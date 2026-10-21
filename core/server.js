'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { toCsv } = require('./crm');
const { STAGES, STAGE_LABELS, evaluate } = require('./qualify');
const { normalizePhone } = require('./db');
const { attentionFor, briefFor, nextStepFor, windowOpen, windowHoursLeft } = require('./attention');
const { plan: planFollowup, describe: describeFollowup } = require('./followups');
const { isoLocalToEpoch } = require('./when');
const formOptions = require('./formoptions');

const PUBLIC = path.resolve(__dirname, '..', 'public');
const MAX_BODY = 200 * 1024;
const MINUTES_SAVED_PER_SCREENED_OUT = 12; // an unqualified lead a human would have phoned

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Marks which messages carry a picture, so the console can show it.
async function withMedia(store, leadId, messages) {
  const idx = await store.mediaIndex([leadId]);
  return messages.map((m) => (idx.has(Number(m.id)) ? { ...m, media_id: idx.get(Number(m.id)) } : m));
}

function createHandler(app) {
  const { config, store, settings, engine, telegram, instagram, facebook, scheduler, simulator, llm, calendar } = app;
  const sessionKey = crypto.createHmac('sha256', `${config.adminPassword}|${config.intakeSecret}`).update('session-v1').digest('hex');
  const hits = new Map();
  const started = Date.now();

  // ---------- helpers ----------
  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(status, { 'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  };
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const isAdmin = (req) => {
    const c = cookies(req).fsid || '';
    return c.length === sessionKey.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(sessionKey));
  };
  // The studio's own login: it opens the Lead Inbox and nothing else (routes marked { crm: true }).
  const crmKey = config.crmPassword ? crypto.createHmac('sha256', `${config.crmPassword}|${config.intakeSecret}`).update('crm-session-v1').digest('hex') : null;
  const isCrm = (req) => {
    if (!crmKey) return false;
    const c = cookies(req).fcrm || '';
    return c.length === crmKey.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(crmKey));
  };
  const safeEqual = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = req.headers['content-type'] || '';
      try {
        if (ct.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
        resolve(JSON.parse(raw));
      } catch { reject(new HttpError(400, 'Invalid body')); }
    });
    req.on('error', reject);
  });
  const readRaw = (req, max = 1024 * 1024) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, 'Payload too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  // Which channel the form sends people to: the admin's choice, else Instagram when it is set up.
  const primaryChannel = () => {
    const pref = settings.get().channels.primary;
    const igOk = instagram.enabled && !!instagram.handle;
    const tgOk = telegram.enabled && !!telegram.botUsername;
    if (pref === 'instagram' && igOk) return 'instagram';
    if (pref === 'telegram' && tgOk) return 'telegram';
    return igOk ? 'instagram' : tgOk ? 'telegram' : null;
  };
  const chatLinks = (lead) => {
    const instagramUrl = instagram.handle ? instagram.chatLink(lead.start_token) : null;
    const telegramUrl = telegram.deepLink(lead.start_token);
    const primary = primaryChannel();
    return { primary, chat_url: primary === 'instagram' ? instagramUrl : primary === 'telegram' ? telegramUrl : null, instagram_url: instagramUrl, telegram_url: telegramUrl };
  };
  const limit = (req, key, max, windowMs = 60000) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const k = `${key}:${ip}`;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(k, arr);
    if (arr.length > max) throw new HttpError(429, 'Too many requests, slow down');
  };

  const needNum = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const first = (s) => String(s || '').trim();

  // Last message and last customer message for many leads in two queries (not two per lead).
  async function lastMessages(ids) {
    const lastAny = new Map();
    const lastIn = new Map();
    if (!ids.length) return { lastAny, lastIn };
    const sel = (where) => `SELECT lead_id, text, direction, role, created_at FROM messages WHERE id IN (SELECT MAX(id) FROM messages ${where} GROUP BY lead_id)`;
    for (const m of await store.all(sel(''))) lastAny.set(m.lead_id, m);
    for (const m of await store.all(sel("WHERE direction='in'"))) lastIn.set(m.lead_id, m);
    return { lastAny, lastIn };
  }

  function leadCard(l, designers, { lastAny, lastIn }) {
    const last = lastAny.get(l.id);
    const lastCust = lastIn.get(l.id);
    const d = l.designer_id ? designers.find((x) => x.id === l.designer_id) : null;
    const s = settings.get();
    const next = planFollowup(l, s);
    return {
      id: l.id, name: l.name, phone: l.phone, email: l.email, tg_username: l.tg_username,
      stage: l.stage, stage_reason: l.stage_reason, stage_locked: !!l.stage_locked, score: l.score,
      project_type: l.project_type, city: l.city, budget_amount: l.budget_amount, budget_text: l.budget_text,
      timeline_months: l.timeline_months, timeline_text: l.timeline_text, notes: l.notes, summary: l.summary,
      source: l.source, campaign: l.campaign, channel: l.channel, has_chat: !!l.chat_id,
      ai_paused: !!l.ai_paused, opted_out: !!l.opted_out, designer: d ? d.name : null, designer_id: l.designer_id,
      turns: l.meta.turns || 0,
      property: l.property, scope: l.scope, style: l.style, contact_pref: l.contact_pref,
      callback_at: l.callback_at, callback_text: l.callback_text, callback_status: l.callback_status, callback_kind: l.callback_kind,
      brief: briefFor(l, s),
      attention: attentionFor(l, s),
      next_step: nextStepFor(l, s),
      next_auto: next ? { kind: next.kind, label: describeFollowup(next), at: next.at } : null,
      last_customer: lastCust ? { text: lastCust.text.slice(0, 160), at: lastCust.created_at } : null,
      window_hours_left: windowHoursLeft(l), can_ai_message: windowOpen(l, Date.now(), 0),
      last_message: last ? { text: last.text.slice(0, 140), direction: last.direction, role: last.role, at: last.created_at } : null,
      created_at: l.created_at, updated_at: l.updated_at, qualified_at: l.qualified_at,
    };
  }
  async function leadCards(leads) {
    const designers = await store.listDesigners();
    const maps = await lastMessages(leads.map((l) => l.id));
    return leads.map((l) => leadCard(l, designers, maps));
  }

  async function stats(includeSim) {
    const leads = (await store.listLeads({ limit: 10000 })).filter((l) => includeSim || l.channel !== 'sim');
    const byStage = Object.fromEntries(STAGES.map((s) => [s, 0]));
    let scoreSum = 0;
    let scoreN = 0;
    for (const l of leads) {
      byStage[l.stage] = (byStage[l.stage] || 0) + 1;
      if (l.score) { scoreSum += l.score; scoreN++; }
    }
    const total = leads.length;
    const engaged = leads.filter((l) => (l.meta.turns || 0) > 0).length;
    const decided = byStage.active + byStage.nurture + byStage.disqualified;
    const screenedOut = byStage.disqualified + byStage.nurture;
    const waiting = leads.filter((l) => l.stage === 'new' && !l.chat_id).length;
    return {
      total, byStage, engaged, decided, waiting_for_telegram: waiting,
      qualified_rate: decided ? Math.round((byStage.active / decided) * 100) : null,
      avg_score: scoreN ? Math.round(scoreSum / scoreN) : null,
      hours_saved: Math.round((screenedOut * MINUTES_SAVED_PER_SCREENED_OUT) / 6) / 10,
      minutes_per_screened_out: MINUTES_SAVED_PER_SCREENED_OUT,
    };
  }

  async function status() {
    const q = async (sql) => Number((await store.get(sql)).c);
    return {
      uptime_s: Math.round((Date.now() - started) / 1000),
      telegram: { ...telegram.status, username: telegram.botUsername },
      instagram: { ...instagram.status, username: instagram.handle, token: await instagram.tokenInfo(), primary: primaryChannel() },
      llm: { enabled: llm.enabled, model: config.llm.model, fallback_model: config.llm.fallbackModel, providers: llm.providerStatus(), ...llm.stats },
      engine: engine.stats,
      outbox: {
        pending_messages: await q("SELECT COUNT(*) c FROM messages WHERE direction='out' AND status='pending'"),
        failed_messages: await q("SELECT COUNT(*) c FROM messages WHERE direction='out' AND status='failed'"),
        pending_webhooks: await q("SELECT COUNT(*) c FROM webhook_outbox WHERE status='pending'"),
        dead_webhooks: await q("SELECT COUNT(*) c FROM webhook_outbox WHERE status='dead'"),
      },
      public_url: config.publicUrl,
      demo_mode: config.demoMode,
    };
  }

  async function createIntake(body, source) {
    const name = first(body.name).slice(0, 80);
    const phone = first(body.phone).slice(0, 30);
    const email = first(body.email).slice(0, 120);
    if (!name) throw new HttpError(400, 'Name is required');
    if (normalizePhone(phone).length < 7 && !/.+@.+\..+/.test(email)) throw new HttpError(400, 'A valid phone number or email is required');
    const existing = normalizePhone(phone) ? await store.findLeadByPhone(phone) : null;
    if (existing && existing.channel !== 'sim' && Date.now() - existing.created_at < 24 * 3600 * 1000 && !existing.chat_id) {
      return { lead: existing, duplicate: true };
    }
    const m = formOptions.mapIntake(body, settings.get());
    const lead = await engine.createLeadFromIntake({
      name, phone: phone || null, email: email || null,
      ...m,
      campaign: first(body.campaign).slice(0, 60) || null,
      source: source,
      raw: { ...m },
    });
    return { lead, duplicate: false };
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const rx = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, rx, keys, handler, public: !!opts.public, crm: !!opts.crm });
  };

  // Pages
  const page = (file) => () => fs.readFileSync(path.join(PUBLIC, file));
  route('GET', '/', { public: true }, async (req, res) => { res.writeHead(302, { Location: config.crmPassword ? '/crm' : '/admin' }); res.end(); });
  route('GET', '/form', { public: true }, async (req, res) => send(res, 200, page('form.html')()));
  route('GET', '/admin', { public: true }, async (req, res) => send(res, 200, page('admin.html')()));
  // The privacy policy is written in terms of whichever business runs this deployment.
  const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  route('GET', '/privacy', { public: true }, async (req, res) => {
    const b = settings.get().business;
    const contact = b.contact_email
      ? `Questions or deletion requests: <a href="mailto:${escHtml(b.contact_email)}">${escHtml(b.contact_email)}</a>.`
      : `Questions or deletion requests: please contact ${escHtml(b.name)} directly, or message them in the chat you started.`;
    send(res, 200, String(page('privacy.html')()).replace(/\{\{BUSINESS\}\}/g, escHtml(b.name)).replace('{{CONTACT_LINE}}', contact));
  });
  // The studio's Lead Inbox page (the website CRM) and its two assets
  route('GET', '/crm', { public: true }, async (req, res) => send(res, 200, page('crm.html')()));
  route('GET', '/crm-assets/:file', { public: true }, async (req, res, { params }) => {
    const types = { 'crm.css': 'text/css; charset=utf-8', 'crm.js': 'application/javascript; charset=utf-8' };
    if (!types[params.file]) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': types[params.file], 'Cache-Control': 'public, max-age=300' });
    res.end(fs.readFileSync(path.join(PUBLIC, 'crm-assets', params.file)));
  });

  // Public API
  route('GET', '/api/health', { public: true }, async (req, res) => {
    const t0 = Date.now();
    const db = await store.get('SELECT COUNT(*) c FROM leads').then((r) => ({ ok: true, leads: Number(r.c), ms: Date.now() - t0 }), (e) => ({ ok: false, error: String(e.message).slice(0, 120) }));
    send(res, db.ok ? 200 : 503, { ok: db.ok, db: { kind: store.kind, ...db }, telegram: telegram.status.connected, llm: llm.enabled, serverless: !!config.serverless, uptime_s: Math.round((Date.now() - started) / 1000) });
  });
  route('GET', '/api/public-config', { public: true }, async (req, res) => {
    const s = settings.get();
    send(res, 200, {
      business: s.business.name, tagline: s.business.tagline, description: s.business.description, areas: s.business.areas,
      project_types: s.qualification.project_types, bot: telegram.botUsername, telegram_enabled: telegram.enabled, instagram: instagram.handle, primary: primaryChannel(),
      options: {
        scope: formOptions.SCOPE_OPTIONS.map((o) => o.label), property_types: formOptions.PROPERTY_TYPES, sizes: formOptions.SIZES,
        contact_times: formOptions.CONTACT_TIMES, timelines: formOptions.TIMELINE_OPTIONS.map((o) => o.label), budgets: formOptions.budgetOptions(s.qualification.currency).map((o) => o.label),
      },
    });
  });
  route('POST', '/api/intake', { public: true }, async (req, res) => {
    limit(req, 'intake', 20);
    const body = await readBody(req);
    const { lead, duplicate } = await createIntake(body, 'form');
    send(res, 200, { ok: true, duplicate, bot: telegram.botUsername, ...chatLinks(lead) });
  });
  route('POST', '/api/intake/gform', { public: true }, async (req, res) => {
    limit(req, 'gform', 60);
    const body = await readBody(req);
    if (!safeEqual(body.secret || req.headers['x-intake-secret'] || '', config.intakeSecret)) throw new HttpError(401, 'Bad secret');
    const { lead, duplicate } = await createIntake(body, 'google-form');
    send(res, 200, { ok: true, duplicate, lead_id: lead.id });
  });
  // Instagram webhook (public, but every POST must carry a valid Meta signature)
  route('GET', '/webhook/instagram', { public: true }, async (req, res, { query }) => {
    const challenge = instagram.verifyChallenge(query);
    if (challenge === null) return send(res, 403, { error: 'Verification failed' });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(challenge);
  });
  route('POST', '/webhook/instagram', { public: true }, async (req, res) => {
    const raw = await readRaw(req);
    if (!instagram.validSignature(raw, req.headers['x-hub-signature-256'])) {
      console.warn(`[instagram] webhook REJECTED (bad or missing signature, ${raw.length} bytes). Check INSTAGRAM_APP_SECRET.`);
      return send(res, 401, { error: 'Bad signature' });
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Bad JSON' }); }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    console.log(`[instagram] webhook received: ${JSON.stringify(payload).slice(0, 300)}`);
    res.end('EVENT_RECEIVED'); // acknowledge fast, process after
    const { targets, local } = instagram.split(payload);
    for (const url of targets) engine.bg(instagram.forward(url, raw, req.headers['x-hub-signature-256']));
    if (local.entry.length) engine.bg(instagram.handleWebhook(local));
  });
  // Facebook Messenger webhook for the Page (same signing rules, signed with the Facebook app secret)
  route('GET', '/webhook/facebook', { public: true }, async (req, res, { query }) => {
    const challenge = facebook.verifyChallenge(query);
    if (challenge === null) return send(res, 403, { error: 'Verification failed' });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(challenge);
  });
  route('POST', '/webhook/facebook', { public: true }, async (req, res) => {
    const raw = await readRaw(req);
    if (!facebook.validSignature(raw, req.headers['x-hub-signature-256'])) {
      console.warn(`[facebook] webhook REJECTED (bad or missing signature, ${raw.length} bytes). Check FACEBOOK_APP_SECRET.`);
      return send(res, 401, { error: 'Bad signature' });
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Bad JSON' }); }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    console.log(`[facebook] webhook received: ${JSON.stringify(payload).slice(0, 300)}`);
    res.end('EVENT_RECEIVED');
    if (payload.object !== 'page') return;
    const { local } = facebook.split(payload);
    if (local.entry.length) engine.bg(facebook.handleWebhook(local));
  });
  route('POST', '/api/login', { public: true }, async (req, res) => {
    limit(req, 'login', 10);
    const body = await readBody(req);
    if (!safeEqual(body.password || '', config.adminPassword)) throw new HttpError(401, 'Wrong password');
    send(res, 200, { ok: true }, { 'Set-Cookie': `fsid=${sessionKey}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}` });
  });
  route('POST', '/api/logout', { public: true }, async (req, res) => {
    send(res, 200, { ok: true }, { 'Set-Cookie': ['fsid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', 'fcrm=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'] });
  });
  // Sign-in for the Lead Inbox page: the studio password opens the inbox only; the admin password still opens everything.
  route('POST', '/api/crm-login', { public: true }, async (req, res) => {
    limit(req, 'login', 10);
    const body = await readBody(req);
    const given = body.password || '';
    const age = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`;
    if (config.crmPassword && safeEqual(given, config.crmPassword)) return send(res, 200, { ok: true, role: 'studio' }, { 'Set-Cookie': `fcrm=${crmKey}; ${age}` });
    if (safeEqual(given, config.adminPassword)) return send(res, 200, { ok: true, role: 'admin' }, { 'Set-Cookie': `fsid=${sessionKey}; ${age}` });
    throw new HttpError(401, 'Wrong password');
  });
  route('GET', '/api/me', { public: true }, async (req, res) => send(res, 200, { admin: isAdmin(req), studio: isCrm(req) }));

  // Admin API
  route('GET', '/api/bootstrap', async (req, res) => {
    send(res, 200, {
      settings: settings.get(), designers: await store.listDesigners(), personas: simulator.personas(),
      stages: STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s] })), status: await status(),
      telegram_link: telegram.deepLink('gform'), instagram_link: instagram.chatLink(), public_url: config.publicUrl,
      webhook_url: `${config.publicUrl}/webhook/instagram`, verify_token_set: !!config.instagram.verifyToken,
      calendar: { configured: calendar.google.configured, email: calendar.google.email },
    });
  });
  route('GET', '/api/status', async (req, res) => send(res, 200, await status()));
  route('GET', '/api/stats', async (req, res, { query }) => send(res, 200, await stats(query.get('sim') !== '0')));

  route('GET', '/api/leads', async (req, res, { query }) => {
    const leads = await store.listLeads({
      stage: query.get('stage') || undefined, q: query.get('q') || undefined,
      channel: query.get('sim') === '0' ? 'real' : undefined, limit: 1000,
    });
    send(res, 200, { leads: await leadCards(leads) });
  });
  route('POST', '/api/leads', async (req, res) => {
    const body = await readBody(req);
    const { lead } = await createIntake(body, first(body.source) || 'admin');
    send(res, 200, { ok: true, id: lead.id, ...chatLinks(lead) });
  });
  route('GET', '/api/media/:id', { crm: true }, async (req, res, { params }) => {
    const m = await store.getMedia(Number(params.id));
    if (!m || m.removed_at) throw new HttpError(404, 'Not found');
    // the bytes live in the database, or in Supabase Storage whose address is never shown to the browser
    let bytes = m.data;
    if (!bytes && m.storage_path) { const f = await engine.photos.get(m.storage_path); bytes = f && f.bytes; }
    if (!bytes) throw new HttpError(404, 'Photo unavailable');
    res.writeHead(200, { 'Content-Type': m.mime, 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
    res.end(bytes);
  });
  // Delete one photo (the studio can do this from the inbox); the chat keeps a "photo removed" note.
  route('DELETE', '/api/media/:id', { crm: true }, async (req, res, { params }) => {
    const m = await store.getMedia(Number(params.id));
    if (!m) throw new HttpError(404, 'Not found');
    if (m.removed_at) return send(res, 200, { ok: true, already: true });
    try { await engine.removeMedia([m]); } catch (e) { throw new HttpError(502, e.message); }
    await store.addEvent(m.lead_id, 'photo_removed', { media: m.id, by: 'studio' });
    send(res, 200, { ok: true });
  });
  route('GET', '/api/leads/:id', async (req, res, { params }) => {
    const lead = await store.getLead(Number(params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    const [card] = await leadCards([lead]);
    send(res, 200, {
      lead: card,
      messages: await withMedia(store, lead.id, await store.getMessages(lead.id)),
      events: await store.getEvents(lead.id),
      telegram_url: lead.chat_id ? null : chatLinks(lead).chat_url,
      meta: { memory: lead.meta.memory || [], fu: lead.meta.fu || {}, declined: lead.meta.declined || {}, flags: lead.meta.flags || {}, asked: lead.meta.asked || {}, followups_sent: lead.meta.followups_sent || 0, drips_sent: lead.meta.drips_sent || 0 },
    });
  });
  route('PATCH', '/api/leads/:id', async (req, res, { params }) => {
    const id = Number(params.id);
    const lead = await store.getLead(id);
    if (!lead) throw new HttpError(404, 'Lead not found');
    const b = await readBody(req);
    const patch = {};
    for (const k of ['name', 'phone', 'email', 'project_type', 'city', 'notes', 'timeline_text', 'property', 'scope', 'style', 'contact_pref']) if (k in b) patch[k] = first(b[k]).slice(0, 300) || null;
    if ('callback_at' in b) {
      const tz = settings.get().business.timezone;
      const raw = b.callback_at;
      const at = raw === null || raw === '' ? null : typeof raw === 'number' ? raw : (isoLocalToEpoch(String(raw), tz) ?? (Number.isNaN(Date.parse(raw)) ? undefined : Date.parse(raw)));
      if (at === undefined) throw new HttpError(400, 'That date and time is not valid');
      await engine.setCallback(id, at, 'callback_text' in b ? first(b.callback_text) : undefined);
    }
    if ('budget_amount' in b) {
      const n = needNum(b.budget_amount);
      if (n !== null && (!Number.isFinite(n) || n < 0)) throw new HttpError(400, 'Invalid budget');
      patch.budget_amount = n;
    }
    if ('timeline_months' in b) {
      const n = needNum(b.timeline_months);
      if (n !== null && (!Number.isFinite(n) || n < 0)) throw new HttpError(400, 'Invalid timeline');
      patch.timeline_months = n;
    }
    if ('designer_id' in b) patch.designer_id = b.designer_id ? Number(b.designer_id) : null;
    if (Object.keys(patch).length) {
      await store.updateLead(id, patch);
      await store.addEvent(id, 'edited_by_admin', { fields: Object.keys(patch) });
    }
    if ('ai_paused' in b) await engine.setPaused(id, !!b.ai_paused);
    if (b.unlock) await engine.unlockStage(id);
    else if (b.stage) {
      if (!STAGES.includes(b.stage)) throw new HttpError(400, 'Unknown stage');
      await engine.setStage(id, b.stage, first(b.reason) || undefined);
    } else if (Object.keys(patch).length) await engine.reevaluateLead(id);
    engine.changed('lead', id);
    send(res, 200, { ok: true });
  });
  route('DELETE', '/api/leads/:id', async (req, res, { params }) => {
    await store.deleteLead(Number(params.id));
    engine.changed('lead', Number(params.id));
    send(res, 200, { ok: true });
  });
  route('POST', '/api/leads/:id/message', async (req, res, { params }) => {
    const b = await readBody(req);
    const text = first(b.text);
    if (!text) throw new HttpError(400, 'Message is empty');
    const lead = await store.getLead(Number(params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    if (!lead.chat_id) throw new HttpError(400, 'This lead has not opened the chat yet, so there is nowhere to send to');
    await engine.sendManual(lead.id, text, { pause: b.pause !== false });
    send(res, 200, { ok: true });
  });
  route('POST', '/api/leads/:id/reset', async (req, res, { params }) => { await engine.resetLead(Number(params.id)); send(res, 200, { ok: true }); });
  route('POST', '/api/leads/:id/start', async (req, res, { params }) => { engine.bg(engine.start(Number(params.id))); send(res, 200, { ok: true }); });
  route('POST', '/api/leads/:id/nudge', async (req, res, { params }) => {
    const b = await readBody(req);
    await engine.nudge(Number(params.id), b.kind === 'drip' ? 'drip' : 'followup');
    send(res, 200, { ok: true });
  });

  // Follow-ups: mark done, snooze, or reschedule
  route('POST', '/api/leads/:id/followup', async (req, res, { params }) => {
    const b = await readBody(req);
    const id = Number(params.id);
    if (!await store.getLead(id)) throw new HttpError(404, 'Lead not found');
    if (b.action === 'reschedule') {
      const at = isoLocalToEpoch(String(b.at || ''), settings.get().business.timezone);
      if (at === null) throw new HttpError(400, 'Pick a date and time');
      await engine.setCallback(id, at);
    } else await engine.completeFollowup(id, { action: b.action === 'snooze' ? 'snooze' : 'done', note: first(b.note), hours: b.hours });
    send(res, 200, { ok: true });
  });
  route('GET', '/api/activity', async (req, res) => {
    const rows = await store.all("SELECT e.id, e.lead_id, e.type, e.data, e.created_at, l.name FROM events e JOIN leads l ON l.id=e.lead_id WHERE e.type IN ('stage_changed','lead_created','designer_assigned','call_rescheduled','followup_done','reminder_sent','manual_followup_needed','facts_updated','followup_sent') AND l.channel!='sim' ORDER BY e.id DESC LIMIT 25");
    send(res, 200, { items: rows.map((r) => ({ ...r, data: JSON.parse(r.data || '{}') })) });
  });

  // Test chat (acts as the customer, in the browser, through the same pipeline)
  route('POST', '/api/chat/test', async (req, res) => {
    const b = await readBody(req);
    let lead = b.leadId ? await store.getLead(Number(b.leadId)) : null;
    if (!lead || lead.channel !== 'sim') {
      lead = await store.createLead({
        channel: 'sim', chat_id: `sim:${crypto.randomBytes(6).toString('hex')}`, name: first(b.name) || 'Test Customer',
        phone: first(b.phone) || null, source: 'admin-test', start_token: engine.newToken(),
      });
      await store.addEvent(lead.id, 'lead_created', { source: 'admin-test' });
      engine.changed('lead', lead.id);
      if (!first(b.text)) engine.bg(engine.start(lead.id));
    }
    if (first(b.text)) await engine.receive({ channel: 'sim', chatId: lead.chat_id, text: first(b.text) });
    send(res, 200, { ok: true, leadId: lead.id });
  });

  // Settings
  route('GET', '/api/settings', async (req, res) => send(res, 200, settings.get()));
  route('PUT', '/api/settings', async (req, res) => {
    const b = await readBody(req);
    const prev = settings.get().qualification;
    const next = await settings.update(b);
    const changedBar = ['min_budget', 'borderline_pct', 'active_within_months', 'required', 'service_cities'].some((k) => JSON.stringify(prev[k]) !== JSON.stringify(next.qualification[k]));
    send(res, 200, { ok: true, settings: next, reclassify_suggested: changedBar });
  });
  route('POST', '/api/settings/preview', async (req, res) => {
    const b = await readBody(req);
    send(res, 200, await engine.preview(b.patch || {}, { includeSim: b.includeSim !== false }));
  });
  route('POST', '/api/settings/reevaluate', async (req, res) => send(res, 200, { ok: true, moved: await engine.reevaluateAll() }));

  // Designers
  route('GET', '/api/designers', async (req, res) => send(res, 200, { designers: await store.listDesigners() }));
  route('POST', '/api/designers', async (req, res) => {
    const b = await readBody(req);
    if (!first(b.name)) throw new HttpError(400, 'Name is required');
    send(res, 200, { designer: await store.saveDesigner({ ...b, name: first(b.name) }) });
  });
  route('PUT', '/api/designers/:id', async (req, res, { params }) => {
    const b = await readBody(req);
    if (!first(b.name)) throw new HttpError(400, 'Name is required');
    send(res, 200, { designer: await store.saveDesigner({ ...b, id: Number(params.id), name: first(b.name) }) });
  });
  route('DELETE', '/api/designers/:id', async (req, res, { params }) => {
    await store.run('UPDATE leads SET designer_id=NULL WHERE designer_id=?', Number(params.id));
    await store.deleteDesigner(Number(params.id));
    send(res, 200, { ok: true });
  });

  // Instagram admin actions. Graph API errors become 400s (a Graph 401 must not look like a lost admin session).
  const ig = async (fn) => { try { return await fn(); } catch (e) { throw new HttpError(400, e.message || 'Instagram request failed'); } };
  route('POST', '/api/instagram/subscribe', async (req, res) => { send(res, 200, { ok: true, result: await ig(() => instagram.subscribe()) }); });
  route('POST', '/api/instagram/refresh-token', async (req, res) => { send(res, 200, { ok: true, result: await ig(() => instagram.refreshToken({ force: true })) }); });
  route('POST', '/api/instagram/ice-breakers', async (req, res) => {
    const b = await readBody(req);
    if (Array.isArray(b.questions)) await settings.update({ channels: { ice_breakers: b.questions } });
    send(res, 200, { ok: true, result: await ig(() => instagram.setIceBreakers(settings.get().channels.ice_breakers)) });
  });

  require('./websitecrm').mount({ route, send, readBody, limit, HttpError, store, settings, engine, config });
  require('./igconnect').mountInstagramConnect({ route, send, instagram, config });

  // Simulator, scheduler, integrations
  route('POST', '/api/sim/run', async (req, res) => {
    const b = await readBody(req);
    if (config.serverless) throw new HttpError(400, 'The persona simulator runs for minutes, so it is only available when the server runs on your own machine (npm run dev).');
    if (!llm.enabled) throw new HttpError(400, 'No LLM key configured');
    send(res, 200, await simulator.run({ personaIds: b.personas, concurrency: Number(b.concurrency) || 3, repeat: Number(b.repeat) || 1 }));
  });
  route('GET', '/api/sim/state', async (req, res) => send(res, 200, simulator.state));
  route('POST', '/api/sim/clear', async (req, res) => send(res, 200, { ok: true, removed: await simulator.clear() }));
  route('POST', '/api/scheduler/run', async (req, res) => {
    const b = await readBody(req);
    send(res, 200, await scheduler.tick({ force: !!b.force, includeSim: b.includeSim !== false }));
  });
  // Proves the app can write to the owner's calendar (adds and removes a tiny event).
  route('POST', '/api/calendar/test', async (req, res) => {
    const c = settings.get().calendar;
    if (!calendar.google.configured) return send(res, 200, { ok: false, message: 'The app has no Google service account yet.' });
    if (!c.calendar_id) return send(res, 200, { ok: false, message: 'Enter the calendar ID first.' });
    try {
      await calendar.google.test(c.calendar_id, settings.get().business.timezone);
      const free = await calendar.offer();
      send(res, 200, { ok: true, message: free.length ? `Connected. Next free times: ${engine.fmtSlots(free).join(' | ')}` : 'Connected, but no free time was found in your working hours.' });
    } catch (e) {
      send(res, 200, { ok: false, message: e.message });
    }
  });
  route('POST', '/api/test-alert', async (req, res) => {
    const chat = settings.get().handoff.notify_chat_id;
    if (!chat) throw new HttpError(400, 'No alert chat set. Send /setup <admin password> to the bot from the chat you want alerts in.');
    await telegram.transport.sendRaw(chat, 'Test alert from your lead funnel. Alerts for new active leads will arrive here.');
    send(res, 200, { ok: true });
  });
  route('POST', '/api/test-webhook', async (req, res) => {
    const url = settings.get().handoff.webhook_url;
    if (!url) throw new HttpError(400, 'No webhook URL configured');
    await store.enqueueWebhook('test.ping', { message: 'Test event from lead funnel', at: new Date().toISOString() });
    const r = await scheduler.tick();
    send(res, 200, { ok: true, delivered: r.webhooks });
  });
  route('POST', '/api/demo/wipe', async (req, res) => {
    const b = await readBody(req);
    if (b.confirm !== 'WIPE') throw new HttpError(400, 'Type WIPE to confirm');
    const ids = (await store.all('SELECT id FROM leads')).map((r) => r.id);
    for (const id of ids) await store.deleteLead(id);
    engine.changed('lead');
    send(res, 200, { ok: true, removed: ids.length });
  });
  route('GET', '/api/export.csv', async (req, res) => {
    const s = settings.get();
    const csv = toCsv(await store.listLeads({ limit: 20000 }), s.qualification.currency, await store.listDesigners(), s.business.timezone);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' });
    res.end(csv);
  });
  // Live updates are polled (a serverless function cannot hold a stream open): the admin asks for
  // this fingerprint every few seconds and reloads only when it changes.
  route('GET', '/api/pulse', async (req, res) => {
    const r = await store.get('SELECT (SELECT COALESCE(MAX(updated_at),0) FROM leads) a, (SELECT COALESCE(MAX(id),0) FROM messages) b, (SELECT COALESCE(MAX(id),0) FROM events) c, (SELECT COUNT(*) FROM leads) d');
    send(res, 200, { v: `${r.a}.${r.b}.${r.c}.${r.d}`, sim: simulator.state.running });
  });

  // Called every minute by the database scheduler (and daily by Vercel Cron as a backstop).
  route('GET', '/api/cron', { public: true }, async (req, res) => cron(req, res));
  route('POST', '/api/cron', { public: true }, async (req, res) => cron(req, res));
  async function cron(req, res) {
    const given = String((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-cron-secret'] || '');
    if (!config.cronSecret || !given || !safeEqual(given, config.cronSecret)) throw new HttpError(401, 'Bad cron secret');
    const r = await scheduler.tick({ budgetMs: Number(config.cronBudgetMs) || 40000 });
    send(res, 200, { ok: true, at: new Date().toISOString(), ...r });
  }

  // Telegram pushes updates here when the bot runs in webhook mode.
  const telegramSecret = crypto.createHmac('sha256', String(config.adminPassword)).update('telegram-webhook').digest('hex').slice(0, 32);
  route('POST', '/webhook/telegram', { public: true }, async (req, res) => {
    if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', telegramSecret)) throw new HttpError(401, 'Bad secret');
    const update = await readBody(req);
    send(res, 200, { ok: true });
    engine.bg(telegram.handleUpdate(update));
  });
  route('POST', '/api/telegram/connect', async (req, res) => {
    if (!telegram.enabled) throw new HttpError(400, 'No TELEGRAM_BOT_TOKEN configured');
    await telegram.start(config.serverless ? { webhook: { url: `${config.publicUrl}/webhook/telegram`, secret: telegramSecret } } : {});
    send(res, 200, { ok: true, username: telegram.botUsername });
  });

  // ---------- dispatch ----------
  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type, X-Intake-Secret, X-Site-Key' });
        return res.end();
      }
      if (url.pathname === '/api/intake' || url.pathname === '/api/public-config' || url.pathname === '/api/crm/ingest') res.setHeader('Access-Control-Allow-Origin', '*');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.rx);
        if (!m) continue;
        if (!r.public && !isAdmin(req) && !(r.crm && isCrm(req))) return send(res, 401, { error: 'Not signed in' });
        await settings.refresh(); // other instances may have changed the settings
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return await r.handler(req, res, { params, query: url.searchParams });
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[http]', req.method, url.pathname, e);
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Internal error' : e.message });
      else res.end();
    }
  }
  return handler;
}

function createServer(app) { return http.createServer(createHandler(app)); }

module.exports = { createServer, createHandler };
