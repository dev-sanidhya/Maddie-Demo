'use strict';
// The conversation engine. Reliability design (built for serverless, where any
// instance can die at any moment and several can run at once):
//  - INBOX: every inbound message is written to the database first (unique id =
//    idempotent) and marked processed only in the same transaction that stores
//    the reply, so a crash re-runs the turn instead of losing it.
//  - SERIAL PER LEAD: one turn at a time per lead, enforced by a database lease so it
//    holds across instances. Messages that arrive while a turn runs are picked up by
//    the same loop, and the cron sweep catches anything a dead instance left behind.
//  - OUTBOX: replies are stored as pending, claimed atomically, then delivered with
//    retries; the scheduler sweep re-sends anything still pending.
//  - DETERMINISTIC CORE: facts -> qualify.evaluate() -> directive. The LLM only
//    extracts and phrases; it never decides the category.
//  - GRACEFUL DEGRADATION: if the LLM is down, regex backstops still capture
//    contact/budget and templated replies keep the conversation moving.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { applyFacts } = require('./facts');
const { quickFacts } = require('./quickfacts');
const { evaluate, pickDesigner, STAGE_LABELS, creatorMissing, CREATOR_KINDS } = require('./qualify');
const { fallbackReply } = require('./agent');
const { formatMoney } = require('./budget');
const { formatWhen } = require('./when');
const { briefFor } = require('./attention');
const { streak } = require('./followups');
const { toLocalIso, pickOrdinal } = require('./calendar');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(['active', 'nurture', 'disqualified']);
const HISTORY_WINDOW = 14;
const MIN_OVERFLOW = 6; // summarise once this many messages have scrolled out of the live window
const MAX_ASKS_PER_FIELD = 3;
const maxAsks = () => MAX_ASKS_PER_FIELD;
const LEASE_MS = 75000;
const MAX_SETTLE_MS = Number(process.env.DEBOUNCE_MAX_MS) || 25000;
const IN_CLAUSE = (ids) => ids.map(() => '?').join(',');

class Engine extends EventEmitter {
  constructor({ store, settings, agent, config, transports = {}, debounceMs = 1200, log = console }) {
    super();
    this.store = store;
    this.settings = settings;
    this.agent = agent;
    this.config = config;
    this.transports = transports;
    this.debounceMs = debounceMs;
    this.log = log;
    this.locks = new Map();
    this.delivering = new Set();
    this.summarizing = new Set();
    this.calSyncing = new Set();
    this.calendar = null; // set by createApp
    this.photos = null; // set by createApp: Supabase Storage for customers' photos
    this.pending = new Set();
    this.defer = null; // set by the serverless entry: keeps the function alive until background work ends
    this.stats = { turns: 0, llmFallbacks: 0, sendFailures: 0 };
  }

  // ---------- helpers ----------
  // Sample leads (meta.demo, see scripts/seed-demo.js) never message a real account: they use the no-op transport.
  transportFor(lead) { if (lead.meta && lead.meta.demo) return this.transports.sim; return this.transports[lead.channel === 'sim' ? 'sim' : lead.channel] || this.transports.sim; }

  // Fire-and-forget that a serverless platform is still told about (waitUntil).
  bg(promise) {
    const p = Promise.resolve(promise).catch((e) => this.log.error('[engine] background task failed', e));
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
    if (this.defer) this.defer(p);
    return p;
  }
  async settle() { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  runExclusive(leadId, fn) {
    const prev = this.locks.get(leadId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(leadId, next);
    next.finally(() => { if (this.locks.get(leadId) === next) this.locks.delete(leadId); }).catch(() => {});
    return next;
  }

  idle(leadId) { return (this.locks.get(leadId) || Promise.resolve()).catch(() => {}); }
  changed(type, leadId, extra = {}) { this.emit('change', { type, leadId, ...extra }); }
  money(n) { return formatMoney(n, this.settings.get().qualification.currency); }
  hasInbound(lead) { return (lead.meta.turns || 0) > 0; }

  // ---------- lead lifecycle ----------
  newToken() { return crypto.randomBytes(9).toString('base64url'); }

  async createLeadFromIntake(data) {
    const lead = await this.store.createLead({
      channel: 'telegram',
      name: data.name || null,
      phone: data.phone || null,
      email: data.email || null,
      city: data.city || null,
      project_type: data.project_type || null,
      scope: data.scope || null,
      property: data.property || null,
      contact_pref: data.contact_pref || null,
      budget_amount: data.budget_amount ?? null,
      budget_text: data.budget_text || null,
      timeline_months: data.timeline_months ?? null,
      timeline_text: data.timeline_text || null,
      source: data.source || 'form',
      campaign: data.campaign || null,
      start_token: this.newToken(),
      notes: data.notes || null,
      meta: { form: data.raw || {} },
    });
    await this.store.addEvent(lead.id, 'lead_created', { source: lead.source, campaign: lead.campaign });
    await this.afterChange(lead, { created: true });
    return lead;
  }

  // Bind a chat (Telegram or Instagram) to the lead created at form submit, or create an organic one.
  async bindChat(chatId, profile, { token, source, channel = 'telegram' } = {}) {
    let lead = await this.store.getLeadByChat(chatId);
    if (lead) return { lead, isNew: false };
    if (token) {
      const form = await this.store.getLeadByToken(token);
      if (form && !form.chat_id) {
        lead = await this.store.updateLead(form.id, { chat_id: String(chatId), channel, tg_username: profile.username || null, name: form.name || profile.first_name || null });
        await this.store.addEvent(lead.id, 'chat_linked', { via: 'token', channel });
        this.changed('lead', lead.id);
        return { lead, isNew: false, linked: true };
      }
    }
    try {
      lead = await this.store.createLead({
        channel,
        chat_id: String(chatId),
        tg_username: profile.username || null,
        name: profile.first_name || null,
        source: source || channel,
        start_token: this.newToken(),
      });
    } catch (e) {
      // Two webhooks for a brand new person can race: the loser just uses the winner's lead.
      if (this.store.isDuplicate(e)) { lead = await this.store.getLeadByChat(chatId); if (lead) return { lead, isNew: false }; }
      throw e;
    }
    await this.store.addEvent(lead.id, 'lead_created', { source: lead.source });
    await this.afterChange(lead, { created: true });
    return { lead, isNew: true };
  }

  // Merge a placeholder organic lead into the form lead found by phone match.
  async linkByPhone(chatId, phone) {
    const target = await this.store.findLeadByPhone(phone, { unboundOnly: true });
    if (!target) return null;
    const current = await this.store.getLeadByChat(chatId);
    if (current && current.id === target.id) return target;
    let username = null;
    let first = null;
    if (current) {
      username = current.tg_username;
      first = current.name;
      if ((await this.store.countMessages(current.id)) <= 3) await this.store.deleteLead(current.id);
      else await this.store.updateLead(current.id, { chat_id: null });
    }
    const linked = await this.store.updateLead(target.id, { chat_id: String(chatId), tg_username: username || target.tg_username, name: target.name || first });
    await this.store.addEvent(linked.id, 'telegram_linked', { via: 'phone' });
    this.changed('lead', linked.id);
    return linked;
  }

  // A referral (ig.me link ?ref=<token>) can arrive after the person's first message
  // already created an organic lead. Fold that placeholder into the form lead.
  async linkReferral(chatId, token, profile = {}, channel = 'instagram') {
    const form = await this.store.getLeadByToken(token);
    if (!form) return null;
    const current = await this.store.getLeadByChat(chatId);
    if (current && current.id === form.id) return form;
    if (form.chat_id) return null; // token already used by another chat
    if (!current) return (await this.bindChat(chatId, profile, { token, channel })).lead;
    return this.runExclusive(current.id, async () => {
      await this.store.tx(async (t) => {
        await t.run('UPDATE messages SET lead_id=? WHERE lead_id=?', form.id, current.id);
        await t.run('UPDATE media SET lead_id=? WHERE lead_id=?', form.id, current.id);
        await t.run('DELETE FROM events WHERE lead_id=?', current.id);
        await t.run('DELETE FROM leads WHERE id=?', current.id);
        await t.updateLead(form.id, {
          chat_id: String(chatId), channel, tg_username: profile.username || current.tg_username || null,
          name: form.name || current.name || null, last_inbound_at: current.last_inbound_at,
        });
        await t.addEvent(form.id, 'chat_linked', { via: 'referral', channel });
      });
      this.changed('lead', form.id);
      this.bg(this.drain(form.id));
      return this.store.getLead(form.id);
    });
  }

  // Deletes photos (files in storage and the database copy) and leaves a "removed" note in the chat.
  // If storage refuses, nothing is marked removed, so the next attempt tries again.
  async removeMedia(rows) {
    const paths = rows.map((r) => r.storage_path).filter(Boolean);
    if (paths.length) {
      if (!this.photos || !this.photos.canDelete) throw new Error('Photo deletion is not set up on this deployment');
      await this.photos.remove(paths);
    }
    await this.store.markMediaRemoved(rows.map((r) => r.id));
    return rows.length;
  }

  // ---------- inbound ----------
  async receive({ channel = 'telegram', chatId, text, profile = {}, updateId = null, externalId = null, token = null, media = null }) {
    await this.settings.refresh();
    let lead = await this.store.getLeadByChat(chatId);
    if (!lead) lead = (await this.bindChat(chatId, profile, { channel, token })).lead;
    let messageId;
    try {
      messageId = await this.store.addMessage({ lead_id: lead.id, direction: 'in', role: 'user', text: String(text).slice(0, 4000), tg_update_id: updateId, ext_id: externalId });
    } catch (e) {
      if (this.store.isDuplicate(e)) return { leadId: lead.id, duplicate: true };
      throw e;
    }
    if (media) {
      // storage first (it has its own space); the database only if storage is off or refuses the upload
      const path = this.photos ? await this.photos.put(lead.id, media.mime, media.bytes) : null;
      await this.store.addMedia({ lead_id: lead.id, message_id: messageId, mime: media.mime, bytes: path ? null : media.bytes, path, size: media.bytes.length });
    }
    const meta = { ...lead.meta };
    if (meta.flags && meta.flags.stalled) { meta.flags = { ...meta.flags }; delete meta.flags.stalled; }
    await this.store.updateLead(lead.id, { last_inbound_at: Date.now(), meta });
    this.changed('message', lead.id);
    this.bg(this.drain(lead.id));
    return { leadId: lead.id, duplicate: false };
  }

  // A picture from the customer: look at it, keep the picture itself, and let the conversation carry on
  // with a one-line description as the message text (so memory, the summary and the CRM all know what it showed).
  async receiveImage({ channel = 'instagram', chatId, bytes, mime, profile = {}, externalId = null, token = null }) {
    await this.settings.refresh();
    if (externalId && (await this.store.get('SELECT id FROM messages WHERE ext_id=?', externalId))) return { duplicate: true };
    const lead = (await this.store.getLeadByChat(chatId)) || (await this.bindChat(chatId, profile, { channel, token })).lead;
    let description = '';
    try {
      description = await this.agent.describeImage(lead, this.settings.get(), { mime, bytes });
    } catch (e) {
      await this.store.addEvent(lead.id, 'vision_failed', { error: String(e.message).slice(0, 200) });
    }
    const text = description ? `[Photo] ${description}` : '[Photo] The customer sent a photo that could not be analysed.';
    return this.receive({ channel, chatId, text, profile, externalId, token, media: { mime, bytes } });
  }

  drain(leadId) {
    return this.runExclusive(leadId, async () => {
      const release = await this.store.lease(leadId, LEASE_MS);
      if (!release) return; // another instance is on this lead; it re-checks for late arrivals before it finishes
      try {
        await this.settings.refresh();
        for (let guard = 0; guard < 8; guard++) {
          // Debounce: let a burst of messages settle into one turn. People often send one thought as ten short
          // messages, so wait until they have been quiet for debounceMs (up to MAX_SETTLE_MS, so a very long burst still gets answered).
          const settleUntil = Date.now() + MAX_SETTLE_MS;
          while (this.debounceMs && Date.now() < settleUntil) {
            const lead = await this.store.getLead(leadId);
            if (!lead || lead.channel === 'sim' || !lead.last_inbound_at || Date.now() - lead.last_inbound_at >= this.debounceMs) break;
            await sleep(Math.min(this.debounceMs - (Date.now() - lead.last_inbound_at) + 20, Math.max(50, settleUntil - Date.now())));
          }
          const rows = await this.store.all("SELECT * FROM messages WHERE lead_id=? AND direction='in' AND processed=0 ORDER BY id", leadId);
          if (!rows.length) break;
          await this.turn(leadId, rows, { allowDefer: guard < 3 });
        }
      } finally {
        await release();
      }
      // A message may have landed in the instant between our last check and the release.
      const late = await this.store.get("SELECT id FROM messages WHERE lead_id=? AND direction='in' AND processed=0 LIMIT 1", leadId);
      if (late) this.bg(this.drain(leadId));
    });
  }

  // Re-run anything left unprocessed (crash recovery on boot, and the cron sweep).
  // olderThanMs skips messages that a live instance is probably still working on.
  async recover({ olderThanMs = 0, backfill = true, wait = false } = {}) {
    const rows = await this.store.all("SELECT DISTINCT lead_id FROM messages WHERE direction='in' AND processed=0 AND created_at<=?", Date.now() - olderThanMs);
    const runs = rows.map((r) => this.bg(this.drain(r.lead_id)));
    if (backfill) {
      // Backfill owners for qualified leads created before any designer existed.
      for (const l of await this.store.listLeads({ stage: 'active', limit: 2000 })) if (!l.designer_id) await this.assignDesigner(l);
    }
    if (wait) await Promise.allSettled(runs);
    return rows.length;
  }

  // ---------- the turn ----------
  async turn(leadId, rows, { allowDefer = false } = {}) {
    const settings = this.settings.get();
    let lead = await this.store.getLead(leadId);
    if (!lead) return;
    const rowIds = rows.map((r) => r.id);
    const markProcessed = () => this.store.run(`UPDATE messages SET processed=1 WHERE id IN (${IN_CLAUSE(rowIds)})`, ...rowIds);
    const text = rows.map((r) => r.text).join('\n');

    if (lead.opted_out) { await markProcessed(); return; }
    if (lead.ai_paused) {
      await markProcessed();
      await this.store.addEvent(lead.id, 'message_while_paused', {});
      await this.alertPausedMessage(lead, text);
      this.changed('message', lead.id);
      return;
    }

    // A person on the team has already answered what they said (their message is on record after the customer's): stay quiet.
    // Earlier team involvement does not matter; only a reply to THIS message does. No AI call is spent.
    const newestIn = Math.max(...rows.map((r) => Number(r.created_at)));
    if (lead.channel !== 'sim' && await this.store.get("SELECT id FROM messages WHERE lead_id=? AND direction='out' AND role='admin' AND created_at>=? LIMIT 1", leadId, newestIn)) {
      await markProcessed();
      await this.store.addEvent(lead.id, 'reply_held_back', { reason: 'team_already_replied' });
      this.changed('message', lead.id);
      return;
    }

    // Someone is still typing: a newer message is already waiting. Do not spend an AI call on a half-said thought;
    // the next pass picks up everything they have said so far and answers it ONCE.
    const newerWaiting = () => this.store.get("SELECT id FROM messages WHERE lead_id=? AND direction='in' AND processed=0 AND id>? LIMIT 1", leadId, Math.max(...rowIds));
    if (allowDefer && lead.channel !== 'sim' && await newerWaiting()) return;

    const stopTyping = this.keepTyping(lead);
    try {
      this.stats.turns++;
      const history = await this.store.contextMessages(leadId, { beforeId: rowIds[0], summaryUpto: lead.summary_upto });
      const lastAsked = lead.meta.last_asked || null;

      // 1. Extract facts (LLM), tolerate failure.
      let facts = null;
      let aiFailed = false;
      try {
        facts = await this.agent.extract(lead, history, text, settings, lastAsked);
      } catch (e) {
        aiFailed = true;
        this.stats.llmFallbacks++;
        await this.store.addEvent(lead.id, 'llm_error', { step: 'extract', error: String(e.message).slice(0, 200) });
        facts = quickFacts(text, lastAsked, settings); // no AI: still read the common answers by rule
      }
      facts = facts || {};
      // the model sometimes misses a plain answer to the timeline question ("in next 10-15 days"): the rule reader fills it in
      if (facts.timeline_months == null && lead.timeline_months == null && (lastAsked === 'timeline' || /\b(launch|launching|start|starting|begin|go live|going live|need it|ready by)\b/i.test(text))) {
        const qf = quickFacts(text, lastAsked, settings);
        if (qf.timeline_months != null) { facts.timeline_months = qf.timeline_months; facts.timeline_text = facts.timeline_text || qf.timeline_text; }
      }
      // "the second one": the customer picked one of the call times we offered
      const offered = lead.meta.offered || [];
      if (offered.length && lastAsked === 'callback') {
        const i = pickOrdinal(text, offered.length);
        if (i >= 0) { facts.callback_at = toLocalIso(offered[i], settings.business.timezone); facts.callback_text = formatWhen(offered[i], settings.business.timezone); }
      }
      const applied = applyFacts(lead, facts, text, { lastAsked, settings, now: Date.now() });
      applied.meta.turns = (lead.meta.turns || 0) + 1;
      const prevStage = lead.stage;
      lead = await this.store.updateLead(leadId, { ...applied.patch, meta: applied.meta });

      // 2. Decide (pure code).
      // Instagram leads speak first, so the first turn is the greeting: it welcomes them
      // by name and asks the first question in one message.
      const firstContact = !history.some((m) => m.direction === 'out');
      const decision = this.decide(lead, settings, { changed: applied.changed, greeting: firstContact });
      lead = decision.lead;
      lead = await this.calendarStep(lead, decision, applied, settings);

      // 3. Compose. (Check again first: the extra message may have landed while the facts were being read.)
      if (allowDefer && lead.channel !== 'sim' && await newerWaiting()) { await this.store.addEvent(lead.id, 'reply_deferred', { reason: 'newer_message_before_compose' }); return; }
      const info = {};
      const reply = await this.compose(lead, decision.directive, settings, history.concat(rows), info);
      if (info.failed) aiFailed = true;

      // Another message arrived while the reply was being written: drop this reply (nothing is sent or marked
      // as handled) so the next pass answers everything they said in ONE message, the way a person would.
      if (allowDefer && lead.channel !== 'sim' && await this.store.get("SELECT id FROM messages WHERE lead_id=? AND direction='in' AND processed=0 AND id>? LIMIT 1", leadId, Math.max(...rowIds))) {
        await this.store.addEvent(lead.id, 'reply_deferred', { reason: 'newer_message' });
        return;
      }

      // 4. Commit everything for this turn atomically.
      const out = await this.commitTurn({ lead, decision, reply, rowIds, prevStage, changed: applied.changed, aiFailed });
      this.changed('lead', leadId);
      if (out.messageId) await this.deliver(out.messageId).catch(() => {});
      await this.sideEffects(out.lead, prevStage, decision, applied.changed);
      this.bg(this.maybeSummarize(leadId));
    } finally {
      stopTyping();
    }
  }

  // Applies exhaustion rules, evaluates, and picks the directive for this turn.
  decide(lead, settings, { changed = [], greeting = false } = {}) {
    let meta = { ...lead.meta, declined: { ...(lead.meta.declined || {}) }, asked: { ...(lead.meta.asked || {}) } };
    let ev = evaluate({ ...lead, meta }, settings, { hasInbound: this.hasInbound(lead) });
    // A field asked repeatedly with no usable answer stops being asked.
    let guard = 0;
    while (ev.nextField && (meta.asked[ev.nextField] || 0) >= maxAsks(ev.nextField) && guard++ < 4) {
      meta.declined[ev.nextField] = true;
      ev = evaluate({ ...lead, meta }, settings, { hasInbound: this.hasInbound(lead) });
    }
    lead = { ...lead, meta };
    const stage = ev.stage;
    const reasonText = ev.reason;
    let directive = null;

    if (stage === 'human') {
      const routed = meta.flags && meta.flags.routed;
      const creatorKind = CREATOR_KINDS.includes(routed) && !lead.ai_paused ? routed : null;
      // routed people (creators, press, existing clients) keep getting short replies; someone who asked for a person gets silence
      if (creatorKind) {
        // creators get a real conversation: details are collected one question at a time, the team decides everything else
        const missing = creatorMissing(creatorKind, meta.creator || {}, lead);
        directive = { type: 'CREATOR', kind: creatorKind, missing, complete: !missing.length, first: greeting };
      } else directive = meta.closed_stage === 'human' ? (routed ? { type: 'POST' } : null) : { type: 'HANDOFF', reason: reasonText, routed };
    } else if (FINAL.has(stage)) {
      if (meta.closed_stage === stage) {
        directive = { type: 'POST', gotPhone: changed.includes('phone') };
        if (stage === 'active') {
          if (changed.includes('callback_at') && lead.callback_at) {
            directive = { type: 'CONFIRM_CALLBACK', when: formatWhen(lead.callback_at, settings.business.timezone) };
          } else {
            directive.askCallback = !lead.callback_at && (meta.asked.callback || 0) < 2;
            directive.askPhone = !directive.askCallback && !lead.phone && !lead.email && (meta.asked.phone || 0) < 2;
          }
        }
      } else {
        directive = { type: `CLOSE_${stage === 'active' ? 'ACTIVE' : stage === 'nurture' ? 'NURTURE' : 'DISQUALIFIED'}`, reason: reasonText, first: greeting };
      }
    } else {
      const field = ev.nextField;
      const col = { budget: 'budget_amount', timeline: 'timeline_months' }[field] || field;
      const hesitated = !!(meta.refusals && meta.refusals[field] > 0) && !changed.includes(col);
      directive = greeting ? { type: 'GREET', field } : { type: 'ASK', field, hesitated, attempt: meta.asked[field] || 0 };
    }
    if (directive && changed.includes('phone')) directive.gotPhone = true;
    return { ev, stage, reason: reasonText, directive, lead };
  }

  async compose(lead, directive, settings, history, info = {}) {
    if (!directive) return null;
    const designer = directive.type === 'CLOSE_ACTIVE' ? await this.previewDesigner(lead) : (lead.designer_id ? await this.store.getDesigner(lead.designer_id) : null);
    const ctx = { lead, settings, designer, summary: lead.summary };
    try {
      const msg = await this.agent.reply(directive, ctx, history);
      if (msg) return msg;
      this.stats.llmFallbacks++;
      await this.store.addEvent(lead.id, 'reply_fallback', { directive: directive.type, why: 'validator_or_empty' });
    } catch (e) {
      info.failed = true;
      this.stats.llmFallbacks++;
      await this.store.addEvent(lead.id, 'llm_error', { step: 'reply', error: String(e.message).slice(0, 200) });
    }
    return fallbackReply(directive, ctx);
  }

  async previewDesigner(lead) {
    const designers = await this.store.listDesigners();
    return pickDesigner(designers, lead, await this.designerLoads());
  }
  async designerLoads() {
    const loads = {};
    for (const r of await this.store.all("SELECT designer_id, COUNT(*) c FROM leads WHERE stage='active' AND designer_id IS NOT NULL GROUP BY designer_id")) loads[r.designer_id] = Number(r.c);
    return loads;
  }

  async commitTurn({ lead, decision, reply, rowIds, prevStage, changed, aiFailed = false }) {
    const { ev, stage, directive } = decision;
    const meta = { ...lead.meta };
    // If the AI could not handle this turn, the owner must know: it shows under "Needs you now".
    meta.fu = { ...(meta.fu || {}) };
    if (aiFailed) meta.fu.ai_failed_at = Date.now(); else delete meta.fu.ai_failed_at;
    if (directive && directive.type === 'ASK') {
      meta.last_asked = directive.field;
      meta.asked = { ...meta.asked, [directive.field]: (meta.asked[directive.field] || 0) + 1 };
    } else if (directive && directive.type === 'OFFER_SLOTS') {
      meta.last_asked = 'callback'; // negotiating a time does not count against the limit on asking
    } else if (directive && directive.type === 'GREET') {
      meta.last_asked = directive.field;
      meta.asked = { ...meta.asked, [directive.field]: (meta.asked[directive.field] || 0) + 1 };
    } else if (directive && directive.type === 'CLOSE_ACTIVE' && !lead.callback_at) {
      meta.last_asked = 'callback';
      meta.asked = { ...meta.asked, callback: (meta.asked.callback || 0) + 1, ...(!lead.phone && !lead.email ? { phone: (meta.asked.phone || 0) + 1 } : {}) };
    } else if (directive && directive.type === 'POST' && directive.askCallback) {
      meta.last_asked = 'callback';
      meta.asked = { ...meta.asked, callback: (meta.asked.callback || 0) + 1 };
    } else if (directive && ((directive.type === 'POST' && directive.askPhone) || (directive.type === 'CONFIRM_CALLBACK' && !lead.phone && !lead.email))) {
      meta.last_asked = null;
      meta.asked = { ...meta.asked, phone: (meta.asked.phone || 0) + 1 };
    } else if (directive) {
      meta.last_asked = null;
    }
    if (directive && /^CLOSE_|^HANDOFF$/.test(directive.type)) meta.closed_stage = stage;
    if (!FINAL.has(stage) && stage !== 'human') delete meta.closed_stage;

    return this.store.tx(async (t) => {
      const patch = { meta, stage, stage_reason: ev.reason, score: ev.score };
      if (stage === 'human' && meta.flags && meta.flags.wants_human) patch.ai_paused = 1;
      if (stage === 'active' && !lead.qualified_at) patch.qualified_at = Date.now();
      let messageId = null;
      if (reply) {
        messageId = await t.addMessage({ lead_id: lead.id, direction: 'out', role: 'assistant', text: reply, status: 'pending' });
      }
      if (rowIds.length) await t.run(`UPDATE messages SET processed=1 WHERE id IN (${IN_CLAUSE(rowIds)})`, ...rowIds);
      if (stage !== prevStage) {
        await t.addEvent(lead.id, 'stage_changed', { from: prevStage, to: stage, reason: ev.reason, score: ev.score });
      }
      if (changed.length) await t.addEvent(lead.id, 'facts_updated', { fields: changed });
      return { messageId, lead: await t.updateLead(lead.id, patch) };
    });
  }

  async sideEffects(lead, prevStage, decision, changed = []) {
    const stageChanged = lead.stage !== prevStage;
    if (stageChanged && lead.stage === 'active' && !lead.designer_id) await this.assignDesigner(lead);
    const fresh = await this.store.getLead(lead.id);
    await this.afterChange(fresh, { stageChanged, prevStage });
    // A booked call is the most time-sensitive fact we learn: tell the team straight away.
    if (changed.includes('callback_at') && fresh.callback_at && fresh.channel !== 'sim') this.bg(this.alertCallback(fresh));
  }

  async alertCallback(lead) {
    const tz = this.settings.get().business.timezone;
    const d = lead.designer_id ? await this.store.getDesigner(lead.designer_id) : null;
    const lines = [
      `CALL BOOKED: ${lead.name || 'Unknown'}`,
      `When: ${formatWhen(lead.callback_at, tz)}`,
      d ? `Designer: ${d.name}` : '',
      lead.phone ? `Phone: ${lead.phone}` : 'No phone number yet, message them first',
      `About: ${briefFor(lead, this.settings.get())}`,
      `Open: ${this.config.publicUrl}/admin#lead=${lead.id}`,
    ].filter(Boolean).join('\n');
    const targets = new Set();
    const chat = this.settings.get().handoff.notify_chat_id;
    if (chat) targets.add(chat);
    if (d && d.telegram_chat_id) targets.add(d.telegram_chat_id);
    for (const c of targets) { try { await this.transports.telegram?.sendRaw(c, lines); } catch (e) { this.log.warn('[engine] call alert failed', e.message); } }
  }

  async assignDesigner(lead) {
    const d = pickDesigner(await this.store.listDesigners(), lead, await this.designerLoads());
    if (!d) return null;
    await this.store.updateLead(lead.id, { designer_id: d.id });
    await this.store.addEvent(lead.id, 'designer_assigned', { designer: d.name });
    return d;
  }

  // Alerts + CRM webhook after any meaningful change.
  async afterChange(lead, { created = false, stageChanged = false, prevStage = null } = {}) {
    const settings = this.settings.get();
    const h = settings.handoff;
    if (lead.channel === 'sim') { this.changed('lead', lead.id); return; }
    if (h.webhook_url) {
      await this.store.enqueueWebhook(created ? 'lead.created' : stageChanged ? 'lead.stage_changed' : 'lead.updated', await this.publicLead(lead, { prevStage }));
    }
    if (stageChanged && h.alert_stages.includes(lead.stage)) this.bg(this.alertTeam(lead));
    if (this.calendar && this.calendar.ready) this.bg(this.syncCalendar(lead.id));
    this.changed('lead', lead.id);
  }

  // ---------- calendar ----------
  fmtSlots(slots) { const tz = this.settings.get().business.timezone; return slots.map((t) => formatWhen(t, tz)); }

  // Runs inside a turn, before the reply is written: a time the customer proposed is checked against the
  // owner's real calendar. Free: it is booked and confirmed. Busy: the callback is withdrawn and the
  // nearest free options are offered. Never throws: a calendar outage must not break the chat.
  async calendarStep(lead, decision, applied, settings) {
    const cal = this.calendar;
    if (!cal || !cal.ready || (lead.meta && lead.meta.demo) || lead.channel === 'sim') return lead;
    try {
      if (applied.changed.includes('callback_at') && lead.callback_at && decision.stage === 'active') {
        const r = await cal.check(lead.callback_at);
        if (r.ok) {
          const booked = await this.bookEvent(lead, settings);
          const meta = { ...lead.meta, cal: booked };
          delete meta.offered;
          lead = await this.store.updateLead(lead.id, { meta });
          await this.store.addEvent(lead.id, 'calendar_booked', { start: booked.start, link: booked.link });
        } else {
          const meta = { ...lead.meta, offered: r.slots };
          const asked = formatWhen(lead.callback_at, settings.business.timezone);
          lead = await this.store.updateLead(lead.id, { callback_at: null, callback_status: 'requested', callback_text: asked, meta });
          decision.directive = { type: 'OFFER_SLOTS', requested: asked, slots: this.fmtSlots(r.slots) };
          await this.store.addEvent(lead.id, 'calendar_slot_busy', { requested: asked, offered: r.slots });
        }
      } else if (decision.directive && ((decision.directive.type === 'CLOSE_ACTIVE' && !lead.callback_at) || (decision.directive.type === 'POST' && decision.directive.askCallback))) {
        const slots = await cal.offer();
        if (slots.length) {
          decision.directive.slots = this.fmtSlots(slots);
          lead = await this.store.updateLead(lead.id, { meta: { ...lead.meta, offered: slots } });
        }
      }
    } catch (e) {
      await this.store.addEvent(lead.id, 'calendar_error', { error: String(e.message).slice(0, 200) });
      this.log.warn('[calendar]', e.message);
    }
    return lead;
  }

  async bookEvent(lead, settings) {
    const brief = briefFor(lead, settings);
    const url = `${this.config.publicUrl}/admin#lead=${lead.id}`;
    const existing = lead.meta && lead.meta.cal;
    if (existing && existing.event_id) {
      try { return await this.calendar.move(lead, existing.event_id, brief, url); } catch (e) { /* the old event was deleted by hand: make a new one */ }
    }
    return this.calendar.book(lead, brief, url);
  }

  // Keeps the calendar in step with the lead whenever something changes it (the owner rescheduling,
  // a stage change, a call cancelled). Cheap when nothing needs doing: no calendar call is made.
  async syncCalendar(leadId) {
    const cal = this.calendar;
    if (!cal || !cal.ready || this.calSyncing.has(leadId)) return;
    this.calSyncing.add(leadId);
    try {
      const lead = await this.store.getLead(leadId);
      if (!lead || lead.channel === 'sim' || (lead.meta && lead.meta.demo)) return;
      const settings = this.settings.get();
      const fu = lead.meta.fu || {};
      const have = lead.meta.cal;
      const wanted = lead.stage === 'active' && lead.callback_at && lead.callback_status === 'scheduled' && !fu.done_at && !lead.opted_out;
      if (wanted && (!have || have.start !== lead.callback_at)) {
        const booked = await this.bookEvent(lead, settings);
        await this.store.updateLead(leadId, { meta: { ...lead.meta, cal: booked } });
        await this.store.addEvent(leadId, 'calendar_booked', { start: booked.start, link: booked.link, by: 'sync' });
        this.changed('lead', leadId);
      } else if (have && (!lead.callback_at || lead.stage === 'disqualified' || lead.opted_out)) {
        await cal.cancel(have.event_id);
        const meta = { ...lead.meta }; delete meta.cal;
        await this.store.updateLead(leadId, { meta });
        await this.store.addEvent(leadId, 'calendar_cancelled', {});
        this.changed('lead', leadId);
      }
    } catch (e) {
      await this.store.addEvent(leadId, 'calendar_error', { error: String(e.message).slice(0, 200) }).catch(() => {});
    } finally { this.calSyncing.delete(leadId); }
  }

  async publicLead(lead, extra = {}) {
    const designer = lead.designer_id ? await this.store.getDesigner(lead.designer_id) : null;
    return {
      id: lead.id, name: lead.name, phone: lead.phone, email: lead.email, telegram: lead.tg_username,
      source: lead.source, campaign: lead.campaign,
      project_type: lead.project_type, city: lead.city,
      budget_amount: lead.budget_amount, budget_text: lead.budget_text,
      timeline_months: lead.timeline_months, timeline_text: lead.timeline_text,
      stage: lead.stage, stage_reason: lead.stage_reason, score: lead.score,
      designer: designer ? designer.name : null, notes: lead.notes, summary: lead.summary,
      property: lead.property, scope: lead.scope, style: lead.style, contact_pref: lead.contact_pref,
      call_at: lead.callback_at ? new Date(lead.callback_at).toISOString() : null, call_text: lead.callback_text, call_status: lead.callback_status,
      brief: briefFor(lead, this.settings.get()),
      created_at: lead.created_at, updated_at: lead.updated_at, ...extra,
    };
  }

  async alertTeam(lead) {
    const s = this.settings.get();
    const lines = [
      `${lead.stage === 'active' ? 'ACTIVE LEAD' : STAGE_LABELS[lead.stage].toUpperCase()}: ${lead.name || 'Unknown'}`,
      [lead.project_type, lead.city].filter(Boolean).join(' in ') || 'Project details pending',
      `Budget ${lead.budget_amount != null ? this.money(lead.budget_amount) : 'n/a'} | Timeline ${lead.timeline_text || (lead.timeline_months != null ? `${lead.timeline_months} months` : 'n/a')}`,
      `Score ${lead.score}/100`,
      lead.callback_at ? `Call: ${formatWhen(lead.callback_at, s.business.timezone)}` : '',
      `About: ${briefFor(lead, s)}`,
      lead.stage_reason ? `Why: ${lead.stage_reason}` : '',
      lead.summary ? `Notes: ${lead.summary}` : (lead.notes ? `Notes: ${lead.notes}` : ''),
      lead.tg_username ? `${lead.channel === 'instagram' ? 'Instagram' : lead.channel === 'facebook' ? 'Facebook' : 'Telegram'}: @${lead.tg_username}` : (lead.channel === 'instagram' ? 'Channel: Instagram DM' : lead.channel === 'facebook' ? 'Channel: Facebook Messenger' : ''),
      lead.phone ? `Phone: ${lead.phone}` : '',
      `Open: ${this.config.publicUrl}/admin#lead=${lead.id}`,
    ].filter(Boolean).join('\n');
    const targets = new Set();
    if (s.handoff.notify_chat_id) targets.add(s.handoff.notify_chat_id);
    const d = lead.designer_id ? await this.store.getDesigner(lead.designer_id) : null;
    if (d && d.telegram_chat_id) targets.add(d.telegram_chat_id);
    for (const chat of targets) {
      try { await this.transports.telegram?.sendRaw(chat, lines); } catch (e) { this.log.warn('[engine] alert failed', e.message); }
    }
  }

  async alertPausedMessage(lead, text) {
    const meta = { ...lead.meta };
    if (meta.last_pause_alert && Date.now() - meta.last_pause_alert < 5 * 60 * 1000) return;
    meta.last_pause_alert = Date.now();
    await this.store.updateLead(lead.id, { meta });
    const chat = this.settings.get().handoff.notify_chat_id;
    if (chat && lead.channel !== 'sim') {
      this.bg(this.transports.telegram?.sendRaw(chat, `${lead.name || 'A lead'} wrote while the AI is paused: "${text.slice(0, 200)}"\n${this.config.publicUrl}/admin#lead=${lead.id}`));
    }
  }

  keepTyping(lead) {
    const t = this.transportFor(lead);
    if (!t || !t.typing || !lead.chat_id) return () => {};
    const ping = () => Promise.resolve(t.typing(lead.chat_id)).catch(() => {});
    ping();
    const iv = setInterval(ping, 4000);
    return () => clearInterval(iv);
  }

  // ---------- greeting / bot-initiated ----------
  start(leadId) {
    return this.runExclusive(leadId, async () => {
      const release = await this.store.lease(leadId, LEASE_MS);
      if (!release) return;
      try {
        await this.settings.refresh();
        const settings = this.settings.get();
        let lead = await this.store.getLead(leadId);
        if (!lead || lead.ai_paused || lead.opted_out) return;
        if ((await this.store.countMessages(leadId)) > 0) return;
        const stop = this.keepTyping(lead);
        try {
          const decision = this.decide(lead, settings, { greeting: true });
          lead = decision.lead;
          const reply = await this.compose(lead, decision.directive, settings, []);
          const out = await this.commitTurn({ lead, decision, reply, rowIds: [], prevStage: lead.stage, changed: [] });
          if (out.messageId) await this.deliver(out.messageId).catch(() => {});
          this.changed('lead', leadId);
        } finally { stop(); }
      } finally { await release(); }
    });
  }

  // Scheduler-driven messages: kind is 'reminder', 'followup' or 'drip'.
  // claim: { fu_step, last_inbound_at } makes the send exactly-once even if several cron runs overlap:
  // only the run that wins the compare-and-swap on fu_step (and sees no new customer message) sends.
  nudge(leadId, kind, { claim = null } = {}) {
    return this.runExclusive(leadId, async () => {
      const release = await this.store.lease(leadId, LEASE_MS);
      if (!release) return null;
      try {
        await this.settings.refresh();
        const settings = this.settings.get();
        const lead = await this.store.getLead(leadId);
        if (!lead || lead.ai_paused || lead.opted_out || !lead.chat_id) return null;
        if (claim) {
          // claim carries the state the scheduler planned from, so a second run holding the same plan loses.
          const won = await this.store.run('UPDATE leads SET fu_step=fu_step+1 WHERE id=? AND fu_step=? AND COALESCE(last_inbound_at,0)=?', leadId, claim.fu_step, claim.last_inbound_at);
          if (!won.changes) return null;
        }
        const meta = { ...lead.meta };
        const st = streak(lead);
        let directive;
        if (kind === 'reminder') {
          directive = { type: 'REMINDER', when: lead.callback_at ? formatWhen(lead.callback_at, settings.business.timezone) : '' };
          meta.fu = { ...(meta.fu || {}), reminded_at: Date.now() };
        } else if (kind === 'followup') {
          meta.followups_sent = (meta.followups_sent || 0) + 1;
          meta.fu_streak = { inbound_at: lead.last_inbound_at || 0, followups: st.followups + 1, drips: st.drips };
          const ev = evaluate(lead, settings, { hasInbound: this.hasInbound(lead) });
          directive = { type: 'FOLLOWUP', n: st.followups + 1, field: lead.stage === 'active' ? 'callback' : ev.nextField };
          if (directive.field === 'callback' && this.calendar && this.calendar.ready && !(lead.meta && lead.meta.demo)) {
            try { const slots = await this.calendar.offer(); if (slots.length) { directive.slots = this.fmtSlots(slots); meta.offered = slots; } } catch { /* nudge without options */ }
          }
        } else {
          meta.drips_sent = (meta.drips_sent || 0) + 1;
          meta.fu_streak = { inbound_at: lead.last_inbound_at || 0, followups: st.followups, drips: st.drips + 1 };
          directive = { type: 'DRIP' };
        }
        const history = await this.store.contextMessages(leadId, { summaryUpto: lead.summary_upto });
        const reply = await this.compose({ ...lead, meta }, directive, settings, history);
        const id = await this.store.tx(async (t) => {
          await t.updateLead(leadId, { meta });
          const mid = await t.addMessage({ lead_id: leadId, direction: 'out', role: 'assistant', text: reply, status: 'pending' });
          await t.addEvent(leadId, kind === 'reminder' ? 'reminder_sent' : kind === 'followup' ? 'followup_sent' : 'drip_sent', { n: kind === 'followup' ? directive.n : kind === 'drip' ? meta.fu_streak.drips : 1 });
          return mid;
        });
        await this.deliver(id).catch(() => {});
        this.changed('lead', leadId);
        return id;
      } finally { await release(); }
    });
  }

  // Marks silent leads whose follow-ups are exhausted so the funnel can nurture them.
  async markStalled(leadId) {
    const lead = await this.store.getLead(leadId);
    if (!lead) return;
    const meta = { ...lead.meta, flags: { ...(lead.meta.flags || {}), stalled: true } };
    const settings = this.settings.get();
    const ev = evaluate({ ...lead, meta }, settings, { hasInbound: this.hasInbound(lead) });
    const prev = lead.stage;
    const upd = await this.store.updateLead(leadId, { meta, stage: ev.stage, stage_reason: ev.reason, score: ev.score });
    if (ev.stage !== prev) await this.store.addEvent(leadId, 'stage_changed', { from: prev, to: ev.stage, reason: ev.reason, score: ev.score });
    await this.afterChange(upd, { stageChanged: ev.stage !== prev, prevStage: prev });
  }

  // ---------- admin actions ----------
  async sendManual(leadId, text, { pause = true } = {}) {
    const lead = await this.store.getLead(leadId);
    if (!lead) throw new Error('lead not found');
    const id = await this.store.addMessage({ lead_id: leadId, direction: 'out', role: 'admin', text: String(text).slice(0, 4000), status: 'pending' });
    if (pause && !lead.ai_paused) {
      await this.store.updateLead(leadId, { ai_paused: 1 });
      await this.store.addEvent(leadId, 'ai_paused', { by: 'admin', auto: true });
    }
    await this.store.addEvent(leadId, 'manual_message', {});
    { const fresh = await this.store.getLead(leadId); const meta = this.fuMeta(fresh); meta.fu.manual_done_at = Date.now(); delete meta.fu.snooze_until; await this.store.updateLead(leadId, { meta }); }
    await this.reevaluateLead(leadId);
    await this.deliver(id).catch(() => {});
    this.changed('lead', leadId);
    return id;
  }

  async setPaused(leadId, paused) {
    await this.store.updateLead(leadId, { ai_paused: paused ? 1 : 0 });
    if (!paused) {
      const lead = await this.store.getLead(leadId);
      const meta = { ...lead.meta, flags: { ...(lead.meta.flags || {}) } };
      delete meta.flags.wants_human;
      delete meta.closed_stage;
      await this.store.updateLead(leadId, { meta });
    }
    await this.store.addEvent(leadId, paused ? 'ai_paused' : 'ai_resumed', { by: 'admin' });
    await this.reevaluateLead(leadId);
  }

  async setStage(leadId, stage, reason) {
    const lead = await this.store.getLead(leadId);
    const prev = lead.stage;
    const upd = await this.store.updateLead(leadId, { stage, stage_locked: 1, stage_reason: reason || 'Set manually by admin' });
    await this.store.addEvent(leadId, 'stage_changed', { from: prev, to: stage, reason: 'Manual override', manual: true });
    if (stage === 'active' && !upd.designer_id) await this.assignDesigner(upd);
    await this.afterChange(await this.store.getLead(leadId), { stageChanged: prev !== stage, prevStage: prev });
  }

  async unlockStage(leadId) {
    await this.store.updateLead(leadId, { stage_locked: 0 });
    await this.reevaluateLead(leadId);
  }

  async reevaluateLead(leadId, { apply = true } = {}) {
    const lead = await this.store.getLead(leadId);
    const ev = evaluate(lead, this.settings.get(), { hasInbound: this.hasInbound(lead) });
    if (!apply) return ev;
    if (ev.stage !== lead.stage || ev.reason !== lead.stage_reason || ev.score !== lead.score) {
      const upd = await this.store.updateLead(leadId, { stage: ev.stage, stage_reason: ev.reason, score: ev.score });
      if (ev.stage !== lead.stage) {
        await this.store.addEvent(leadId, 'stage_changed', { from: lead.stage, to: ev.stage, reason: ev.reason, score: ev.score, reclassified: true });
        if (ev.stage === 'active' && !upd.designer_id) await this.assignDesigner(upd);
      }
      await this.afterChange(await this.store.getLead(leadId), { stageChanged: ev.stage !== lead.stage, prevStage: lead.stage });
    }
    return ev;
  }

  // What-if: how would the funnel look under a different settings patch?
  async preview(patch, { includeSim = true } = {}) {
    const { merge, sanitize } = require('./settings');
    const candidate = sanitize(merge(this.settings.get(), patch));
    const rows = (await this.store.listLeads({ limit: 5000 })).filter((l) => includeSim || l.channel !== 'sim');
    const before = {};
    const after = {};
    const moved = [];
    for (const l of rows) {
      const cur = l.stage;
      const next = l.stage_locked ? l.stage : evaluate(l, candidate, { hasInbound: this.hasInbound(l) }).stage;
      before[cur] = (before[cur] || 0) + 1;
      after[next] = (after[next] || 0) + 1;
      if (cur !== next) moved.push({ id: l.id, name: l.name || `Lead ${l.id}`, from: cur, to: next, budget: l.budget_amount });
    }
    return { total: rows.length, before, after, moved };
  }

  async reevaluateAll() {
    let n = 0;
    for (const l of await this.store.listLeads({ limit: 5000 })) {
      if (l.stage_locked) continue;
      const before = l.stage;
      const ev = await this.reevaluateLead(l.id);
      if (ev.stage !== before) n++;
    }
    return n;
  }

  async resetLead(leadId) {
    const lead = await this.store.getLead(leadId);
    if (!lead) return;
    await this.store.tx(async (t) => {
      await t.run('DELETE FROM messages WHERE lead_id=?', leadId);
      await t.run('DELETE FROM media WHERE lead_id=?', leadId);
      await t.run('DELETE FROM events WHERE lead_id=?', leadId);
      const form = (lead.meta && lead.meta.form) || {};
      await t.updateLead(leadId, {
        project_type: form.project_type || null, city: form.city || null, scope: form.scope || null, property: form.property || null, contact_pref: form.contact_pref || null,
        style: null, callback_at: null, callback_text: null, callback_status: null, callback_kind: null,
        budget_amount: form.budget_amount ?? null, budget_text: form.budget_text || null, timeline_months: form.timeline_months ?? null, timeline_text: form.timeline_text || null,
        notes: form.notes || null, stage: 'new', stage_reason: null, stage_locked: 0, score: 0, designer_id: null,
        ai_paused: 0, opted_out: 0, summary: '', summary_upto: 0, qualified_at: null, fu_step: 0, reminded_at: null,
        last_inbound_at: null, last_outbound_at: null, meta: { form },
      });
      await t.addEvent(leadId, 'lead_reset', {});
    });
    this.changed('lead', leadId);
  }

  // ---------- follow-ups the owner manages ----------
  fuMeta(lead) { return { ...lead.meta, fu: { ...(lead.meta.fu || {}) } }; }

  // Sets, changes or clears the agreed call time (also used by the admin to reschedule).
  async setCallback(leadId, atMs, text) {
    const lead = await this.store.getLead(leadId);
    const meta = this.fuMeta(lead);
    for (const k of ['reminded_at', 'done_at', 'manual_needed_at', 'manual_reason', 'manual_done_at', 'snooze_until']) delete meta.fu[k];
    const patch = atMs
      ? { callback_at: atMs, callback_status: 'scheduled', callback_text: text || lead.callback_text, meta, reminded_at: null }
      : { callback_at: null, callback_status: text ? 'requested' : null, callback_text: text || null, meta, reminded_at: null };
    await this.store.updateLead(leadId, patch);
    await this.store.addEvent(leadId, 'call_rescheduled', { at: atMs || null });
    await this.afterChange(await this.store.getLead(leadId), {});
    this.changed('lead', leadId);
  }

  // Owner actions on a follow-up: 'done' (with an optional outcome note) or 'snooze'.
  async completeFollowup(leadId, { action = 'done', note = '', hours = 4 } = {}) {
    const lead = await this.store.getLead(leadId);
    const meta = this.fuMeta(lead);
    const patch = { meta };
    if (action === 'snooze') {
      meta.fu.snooze_until = Date.now() + Math.max(0.25, Number(hours) || 4) * 3600000;
      await this.store.addEvent(leadId, 'followup_snoozed', { hours });
    } else {
      meta.fu.done_at = Date.now();
      meta.fu.manual_done_at = Date.now();
      meta.fu.human_done_at = Date.now();
      delete meta.fu.snooze_until;
      if (lead.callback_at) patch.callback_status = 'done';
      if (note && note.trim()) patch.notes = (`${lead.notes ? lead.notes + '; ' : ''}Follow-up done: ${note.trim().slice(0, 200)}`).slice(0, 600);
      await this.store.addEvent(leadId, 'followup_done', { note: note.trim().slice(0, 200) });
    }
    await this.store.updateLead(leadId, patch);
    await this.afterChange(await this.store.getLead(leadId), {});
    this.changed('lead', leadId);
  }

  // The assistant cannot reach this person (messaging window closed, paused...), so the owner must.
  async markManual(leadId, reason) {
    const lead = await this.store.getLead(leadId);
    if (!lead || (lead.meta.fu && lead.meta.fu.manual_needed_at && !lead.meta.fu.manual_done_at)) return;
    const meta = this.fuMeta(lead);
    meta.fu.manual_needed_at = Date.now();
    meta.fu.manual_reason = reason;
    delete meta.fu.manual_done_at;
    await this.store.updateLead(leadId, { meta });
    await this.store.addEvent(leadId, 'manual_followup_needed', { reason });
    this.changed('lead', leadId);
    const chat = this.settings.get().handoff.notify_chat_id;
    if (chat && lead.channel !== 'sim' && !(lead.meta && lead.meta.demo)) {
      this.bg(this.transports.telegram?.sendRaw(chat, `FOLLOW UP BY HAND: ${lead.name || 'A lead'}\n${reason}\n${this.config.publicUrl}/admin#lead=${lead.id}`));
    }
  }

  // ---------- outbound delivery ----------
  async deliver(messageId) {
    if (this.delivering.has(messageId)) return;
    this.delivering.add(messageId);
    try {
      // Claim the message so two instances never send it twice. A claim older than two minutes is treated as a crashed sender.
      const t0 = Date.now();
      const claim = await this.store.run("UPDATE messages SET status='sending', claimed_at=? WHERE id=? AND (status='pending' OR (status='sending' AND claimed_at<?))", t0, messageId, t0 - 120000);
      if (!claim.changes) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        const m = await this.store.get('SELECT * FROM messages WHERE id=?', messageId);
        if (!m || m.status === 'sent') return;
        const lead = await this.store.getLead(m.lead_id);
        if (!lead) return;
        try {
          const sentId = await this.transportFor(lead).send(lead, m.text, { role: m.role });
          await this.store.run("UPDATE messages SET status='sent', error=NULL WHERE id=?", messageId);
          // remember the platform's id for our own message, so an echo of it is never mistaken for a person
          if (typeof sentId === 'string' && sentId) await this.store.run('UPDATE messages SET ext_id=? WHERE id=? AND ext_id IS NULL', sentId, messageId).catch(() => {});
          await this.store.updateLead(lead.id, { last_outbound_at: Date.now() });
          this.changed('message', lead.id);
          return;
        } catch (e) {
          if (e.heldBack) { // a person on the team is already answering this chat: the assistant's reply is dropped, not sent
            await this.store.run('DELETE FROM messages WHERE id=?', messageId);
            await this.store.addEvent(lead.id, 'reply_held_back', { reason: e.message });
            this.changed('message', lead.id);
            return;
          }
          this.stats.sendFailures++;
          const attempts = m.attempts + 1;
          const permanent = e.permanent === true;
          const final = permanent || attempts >= 6;
          await this.store.run('UPDATE messages SET attempts=?, error=?, status=? WHERE id=?', attempts, String(e.message).slice(0, 300), final ? 'failed' : attempt === 2 ? 'pending' : 'sending', messageId);
          if (permanent) {
            await this.store.addEvent(lead.id, 'send_failed', { error: e.message });
            if (/blocked|deactivated|chat not found/i.test(e.message)) await this.store.updateLead(lead.id, { opted_out: 1 });
            this.changed('message', lead.id);
            return;
          }
          await sleep(500 * 2 ** attempt);
        }
      }
    } finally {
      this.delivering.delete(messageId);
    }
  }

  async sweepOutbox() {
    const t = Date.now();
    const rows = await this.store.all("SELECT id FROM messages WHERE direction='out' AND ((status='pending' AND created_at<?) OR (status='sending' AND claimed_at<?)) ORDER BY id LIMIT 50", t - 8000, t - 120000);
    for (const r of rows) await this.deliver(r.id);
    return rows.length;
  }

  // ---------- context management ----------
  async maybeSummarize(leadId) {
    if (this.summarizing.has(leadId)) return;
    const lead = await this.store.getLead(leadId);
    if (!lead) return;
    this.summarizing.add(leadId);
    try {
      // Everything that has scrolled out of the live window and is not yet in the summary.
      const old = (await this.store.all('SELECT * FROM messages WHERE lead_id=? AND id>? ORDER BY id DESC LIMIT 400 OFFSET ?', leadId, lead.summary_upto, HISTORY_WINDOW)).reverse();
      if (old.length < MIN_OVERFLOW) return;
      const summary = await this.agent.summarize(lead, lead.summary, old, this.settings.get());
      // compare-and-swap on summary_upto: if another instance summarised meanwhile, keep theirs
      await this.store.run('UPDATE leads SET summary=?, summary_upto=?, updated_at=? WHERE id=? AND summary_upto=?', summary, old[old.length - 1].id, Date.now(), leadId, lead.summary_upto);
      this.changed('lead', leadId);
    } catch (e) {
      this.log.warn('[engine] summarize failed', e.message);
    } finally {
      this.summarizing.delete(leadId);
    }
  }
}

module.exports = { Engine, FINAL };
