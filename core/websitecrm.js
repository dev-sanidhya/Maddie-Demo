'use strict';
// The studio's own "Lead Inbox" (the CRM page built for the website), backed by a real database.
//
// The original page kept leads in each browser's localStorage, so nothing a server learned (an
// Instagram DM, say) could ever appear in it. This module serves that same page from the funnel and
// feeds it from the funnel's database, so every lead lands in one inbox whichever door it came
// through: Instagram, Telegram, the enquiry form, or the chatbot widget on the website.
//
//   GET   /api/crm/leads          (signed in)  every real lead, in the Lead Inbox's shape
//   PATCH /api/crm/leads/:id      (signed in)  { status: new | contacted | closed }
//   POST  /api/crm/ingest         (public)     the website widget sends its lead here (create or update)

const { formatMoney, parseAmount } = require('./budget');
const { formatWhen } = require('./when');
const { briefFor } = require('./attention');
const { STAGE_LABELS } = require('./qualify');

const STATUSES = ['new', 'contacted', 'closed'];
const clip = (v, n) => String(v == null ? '' : v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, n);
const SOURCE_LABEL = { instagram: 'Instagram DM', facebook: 'Facebook Messenger', telegram: 'Telegram', web: 'Website chatbot' };

function sourceOf(lead) {
  if (lead.channel === 'web') return 'Website chatbot';
  if (lead.channel === 'instagram') return 'Instagram DM';
  if (lead.channel === 'facebook') return 'Facebook Messenger';
  if (lead.source === 'form' || lead.source === 'google-form') return 'Enquiry form';
  return SOURCE_LABEL[lead.channel] || 'Chat';
}

// A funnel lead in the shape the Lead Inbox page already understands.
function toCrmLead(lead, messages, settings, media = new Map()) {
  const pic = (m) => media.get(Number(m.id));
  const tz = settings.business.timezone;
  const cur = settings.qualification.currency;
  const months = lead.timeline_months;
  return {
    id: lead.id,
    name: lead.name || '',
    phone: lead.phone || '',
    email: lead.email || '',
    contact: lead.phone || lead.email || (lead.tg_username ? `@${lead.tg_username}` : (lead.channel === 'instagram' ? 'Instagram DM' : lead.channel === 'facebook' ? 'Facebook Messenger' : '')),
    projectType: lead.scope || lead.project_type || '',
    bhk: lead.property || '',
    location: lead.city || '',
    budget: lead.budget_text || (lead.budget_amount != null ? formatMoney(lead.budget_amount, cur) : ''),
    timeline: lead.timeline_text || (months != null ? (months === 0 ? 'right away' : `in ${months} months`) : ''),
    summary: lead.summary || (lead.meta.web_summary || '') || briefFor(lead, settings),
    source: sourceOf(lead),
    channel: lead.channel,
    stage: STAGE_LABELS[lead.stage] || lead.stage,
    call: lead.callback_at ? formatWhen(lead.callback_at, tz) : '',
    status: STATUSES.includes(lead.meta.crm_status) ? lead.meta.crm_status : 'new',
    time: new Date(lead.created_at).toISOString(),
    transcript: messages.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.text, at: m.created_at, ...(pic(m) ? (pic(m).removed ? { removed: true } : { image: `/api/media/${pic(m).id}` }) : {}) })),
    summarizing: false,
  };
}

function mount({ route, send, readBody, limit, HttpError, store, settings, engine, config }) {
  cleanupApi({ route, send, readBody, limit, HttpError, store, settings, engine, config });
  route('GET', '/api/crm/leads', { crm: true }, async (req, res) => {
    const s = settings.get();
    const leads = await store.listLeads({ channel: 'real', limit: 500 });
    const ids = leads.map((l) => l.id);
    const byLead = new Map();
    if (ids.length) {
      // one query for all transcripts; the page shows the most recent 80 messages of each chat
      const rows = await store.all(`SELECT id, lead_id, direction, text, created_at FROM messages WHERE lead_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids);
      for (const m of rows) { if (!byLead.has(m.lead_id)) byLead.set(m.lead_id, []); byLead.get(m.lead_id).push(m); }
    }
    const media = await store.mediaState(ids);
    send(res, 200, { leads: leads.map((l) => toCrmLead(l, (byLead.get(l.id) || []).slice(-80), s, media)) });
  });

  route('PATCH', '/api/crm/leads/:id', { crm: true }, async (req, res, { params }) => {
    const b = await readBody(req);
    if (!STATUSES.includes(b.status)) throw new HttpError(400, 'status must be new, contacted or closed');
    const lead = await store.getLead(Number(params.id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    await store.updateLead(lead.id, { meta: { ...lead.meta, crm_status: b.status } });
    await store.addEvent(lead.id, 'crm_status', { status: b.status });
    send(res, 200, { ok: true, status: b.status });
  });

  // The chatbot widget on the website posts each lead here as it forms and again when its AI summary arrives.
  route('POST', '/api/crm/ingest', { public: true }, async (req, res) => {
    limit(req, 'crm-ingest', 40);
    const b = await readBody(req);
    const key = process.env.CRM_INGEST_KEY || '';
    if (key && String(req.headers['x-site-key'] || b.siteKey || '') !== key) throw new HttpError(401, 'Bad site key');
    const webId = clip(b.id, 40);
    if (!webId) throw new HttpError(400, 'id is required');
    const name = clip(b.name, 80);
    const phone = clip(b.phone, 30);
    const email = clip(b.email, 120);
    if (!name && !phone && !email) throw new HttpError(400, 'A name, phone or email is required');

    const chatId = `web:${webId}`;
    const budgetText = clip(b.budget, 80);
    const fields = {
      name: name || null, phone: phone || null, email: email || null,
      city: clip(b.location, 80) || null, property: clip(b.bhk, 80) || null,
      project_type: clip(b.projectType, 80) || null, budget_text: budgetText || null,
      budget_amount: budgetText ? (parseAmount(budgetText, { allowBare: false }) ?? null) : null,
      timeline_text: clip(b.timeline, 80) || null,
    };
    let lead = await store.getLeadByChat(chatId);
    const summary = clip(b.summary, 700);
    const transcript = (Array.isArray(b.transcript) ? b.transcript : []).slice(-80)
      .map((m) => ({ direction: m && m.role === 'assistant' ? 'out' : 'in', role: m && m.role === 'assistant' ? 'assistant' : 'user', text: clip(m && m.content, 1500) }))
      .filter((m) => m.text);
    const turns = transcript.filter((m) => m.direction === 'in').length;

    if (!lead) {
      lead = await store.createLead({ channel: 'web', chat_id: chatId, source: 'Website Chatbot', start_token: engine.newToken(), ...fields, meta: { turns, web_id: webId, web_summary: summary || undefined } });
      await store.addEvent(lead.id, 'lead_created', { source: 'website chatbot' });
    } else {
      const patch = {};
      for (const [k, v] of Object.entries(fields)) if (v !== null && v !== lead[k]) patch[k] = v; // a later, fuller record never blanks what we already know
      await store.updateLead(lead.id, { ...patch, meta: { ...lead.meta, turns, web_summary: summary || lead.meta.web_summary } });
    }
    if (summary) await store.updateLead(lead.id, { summary });
    if (transcript.length) {
      await store.tx(async (t) => {
        await t.run('DELETE FROM messages WHERE lead_id=?', lead.id);
        for (const m of transcript) await t.addMessage({ lead_id: lead.id, direction: m.direction, role: m.role, text: m.text, status: m.direction === 'in' ? 'received' : 'sent', processed: true });
      });
    }
    await engine.reevaluateLead(lead.id);
    send(res, 200, { ok: true, id: lead.id });
  });
}

// ---------- keeping the data small: storage meter and clean-up ----------
const DAY = 86400000;
const RETENTION_CHOICES = [0, 30, 60, 90, 180, 365];
const MAX_PER_CALL = 100; // leads deleted per request, so one call always finishes in time; the page repeats until done

function cleanupApi({ route, send, readBody, limit, HttpError, store, settings, engine, config }) {
  const mb = (n) => Math.round(n * 1024 * 1024);

  // Leads old enough, and in the right state, for a clean-up. "Age" is the last time the customer wrote.
  async function pick({ days, status }) {
    const d = Math.max(1, Math.min(3650, Math.round(Number(days)) || 0));
    if (!Number(days)) throw new HttpError(400, 'Choose how old a lead must be');
    const cutoff = Date.now() - d * DAY;
    const leads = (await store.listLeads({ channel: 'real', limit: 5000 })).filter((l) => {
      const when = l.last_inbound_at || l.updated_at || l.created_at;
      const st = STATUSES.includes(l.meta.crm_status) ? l.meta.crm_status : 'new';
      return when < cutoff && (status === 'any' || st === (status || 'closed'));
    });
    return leads;
  }

  async function summarise(leads) {
    const media = await store.mediaOfLeads(leads.map((l) => l.id));
    return { leads: leads.length, photos: media.length, photo_leads: new Set(media.map((m) => m.lead_id)).size, bytes: media.reduce((n, m) => n + Number(m.size || 0), 0), media };
  }

  // Deletes the photos of these leads (files and database), and optionally the leads themselves.
  // Storage goes first: if it refuses, nothing is deleted, so a lead never loses its record but keeps an orphan photo.
  async function run(leads, scope) {
    const batch = leads.slice(0, MAX_PER_CALL);
    const { media, photos, bytes } = await summarise(batch);
    if (media.length) {
      try { await engine.removeMedia(media); } catch (e) { throw new HttpError(502, e.message); }
    }
    if (scope === 'leads') for (const l of batch) await store.deleteLead(l.id);
    return { leads: scope === 'leads' ? batch.length : 0, photos, bytes, remaining: leads.length - batch.length };
  }

  route('GET', '/api/crm/usage', { crm: true }, async (req, res) => {
    const f = await store.footprint();
    const total = await store.get("SELECT COUNT(*) c FROM leads WHERE channel!='sim'");
    send(res, 200, {
      photos: { count: f.photos, used: f.photo_bytes, limit: mb(config.limits.photosMb) },
      database: { used: f.db_bytes, limit: mb(config.limits.dbMb) },
      leads: Number(total.c),
      photo_days: settings.get().retention.photo_days,
      can_delete_photos: !!(engine.photos && engine.photos.canDelete),
    });
  });

  route('POST', '/api/crm/cleanup/preview', { crm: true }, async (req, res) => {
    const b = await readBody(req);
    const leads = await pick(b);
    const sum = await summarise(leads);
    send(res, 200, { leads: b.scope === 'leads' ? sum.leads : 0, matching_leads: sum.leads, photo_leads: sum.photo_leads, photos: sum.photos, bytes: sum.bytes });
  });

  route('POST', '/api/crm/cleanup', { crm: true }, async (req, res) => {
    limit(req, 'cleanup', 30);
    const b = await readBody(req);
    if (b.scope !== 'photos' && b.scope !== 'leads') throw new HttpError(400, 'Choose photos or leads');
    send(res, 200, { ok: true, ...(await run(await pick(b), b.scope)) });
  });

  // Delete the leads (or only the photos) the user ticked in the inbox.
  route('POST', '/api/crm/leads/delete', { crm: true }, async (req, res) => {
    limit(req, 'cleanup', 30);
    const b = await readBody(req);
    if (b.scope !== 'photos' && b.scope !== 'leads') throw new HttpError(400, 'Choose photos or leads');
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger))].slice(0, 200);
    if (!ids.length) throw new HttpError(400, 'No leads selected');
    const leads = [];
    for (const id of ids) { const l = await store.getLead(id); if (l && l.channel !== 'sim') leads.push(l); }
    send(res, 200, { ok: true, ...(await run(leads, b.scope)) });
  });

  // Automatic deletion of photos after N days, chosen by the studio.
  route('PUT', '/api/crm/retention', { crm: true }, async (req, res) => {
    const b = await readBody(req);
    const days = Number(b.photo_days);
    if (!RETENTION_CHOICES.includes(days)) throw new HttpError(400, `Choose one of ${RETENTION_CHOICES.join(', ')}`);
    await settings.update({ retention: { photo_days: days } });
    send(res, 200, { ok: true, photo_days: days });
  });
}

module.exports = { mount, toCrmLead, sourceOf, cleanupApi };
