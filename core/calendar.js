'use strict';
// Books the intro call straight onto the owner's Google Calendar, for free.
//
// How it connects: the owner shares their calendar with a Google "service account"
// (an e-mail address that belongs to this app, created once in the free Google Cloud
// console) and gives it "Make changes to events". The app signs in as that account
// with a JWT, so no OAuth screens, no tokens that expire on the owner, and no cost.
//
// What it does:
//  - freebusy: reads when the owner is busy (only busy/free, never event titles)
//  - isAvailable / suggestSlots: pure functions that respect working hours, days,
//    slot length, buffers and minimum notice, so Aria only offers times that are free
//  - createEvent / updateEvent / deleteEvent: puts the call on the calendar
// Everything the model decides about time still goes through code; the LLM never
// invents an availability.

const crypto = require('node:crypto');
const { partsIn, zonedEpoch } = require('./when');

const MIN = 60000;
const DAY = 86400000;
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ---------- pure scheduling logic ----------
function workDays(cfg) {
  const list = (Array.isArray(cfg.work_days) ? cfg.work_days : String(cfg.work_days || '').split(/[\s,]+/))
    .map((d) => String(d).toLowerCase().slice(0, 3)).filter(Boolean);
  return new Set(list.map((d) => DAY_NAMES.indexOf(d)).filter((i) => i >= 0));
}

// Is a call starting at startMs possible? Inside working hours, on a working day, far enough
// ahead, and not touching any busy block (each padded by the buffer).
function isAvailable(startMs, cfg, busy, tz, now = Date.now()) {
  const dur = cfg.slot_minutes * MIN;
  if (!Number.isFinite(startMs)) return false;
  if (startMs < now + cfg.min_notice_min * MIN) return false;
  if (startMs > now + cfg.max_days_ahead * DAY) return false;
  const p = partsIn(startMs, tz);
  if (!workDays(cfg).has(p.wd)) return false;
  const dayStart = zonedEpoch(p.y, p.mo, p.d, cfg.work_start_hour, 0, tz);
  const dayEnd = zonedEpoch(p.y, p.mo, p.d, cfg.work_end_hour, 0, tz);
  if (startMs < dayStart || startMs + dur > dayEnd) return false;
  const pad = cfg.buffer_min * MIN;
  return !busy.some((b) => startMs < b.end + pad && startMs + dur > b.start - pad);
}

// Up to `count` free options. With a requested time they are the nearest free slots to it;
// otherwise one per day on different days, near late morning, so the choices feel varied.
function suggestSlots(cfg, busy, tz, { now = Date.now(), requested = null, count = 3 } = {}) {
  const step = Math.max(15, cfg.slot_minutes) * MIN;
  const base = new Date(now + cfg.min_notice_min * MIN);
  const first = partsIn(base.getTime(), tz);
  const days = [];
  for (let i = 0; i <= cfg.max_days_ahead; i++) {
    const d = new Date(Date.UTC(first.y, first.mo - 1, first.d + i));
    days.push({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() });
  }
  const perDay = [];
  for (const d of days) {
    const open = zonedEpoch(d.y, d.mo, d.d, cfg.work_start_hour, 0, tz);
    const close = zonedEpoch(d.y, d.mo, d.d, cfg.work_end_hour, 0, tz);
    const slots = [];
    for (let t = open; t + cfg.slot_minutes * MIN <= close; t += step) if (isAvailable(t, cfg, busy, tz, now)) slots.push(t);
    if (slots.length) perDay.push(slots);
  }
  if (requested !== null) {
    const all = perDay.flat().sort((a, b) => Math.abs(a - requested) - Math.abs(b - requested));
    return all.slice(0, count).sort((a, b) => a - b);
  }
  const out = [];
  for (const slots of perDay) {
    if (out.length >= count) break;
    const target = zonedEpoch(...Object.values(dayOf(slots[0], tz)), 11, 0, tz);
    out.push(slots.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), slots[0]));
  }
  return out;
}
const dayOf = (ts, tz) => { const p = partsIn(ts, tz); return { y: p.y, mo: p.mo, d: p.d }; };

// Local "YYYY-MM-DDTHH:mm" for a timestamp: the format facts.applyFacts reads.
function toLocalIso(ts, tz) {
  const p = partsIn(ts, tz);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.y}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}

// "the second one", "option 3", "1st" -> index, or -1.
function pickOrdinal(text, count) {
  const t = String(text || '').toLowerCase();
  const map = [[/\b(1st|first|option 1|1)\b/, 0], [/\b(2nd|second|option 2|2)\b/, 1], [/\b(3rd|third|last|option 3|3)\b/, 2]];
  for (const [rx, i] of map) if (rx.test(t) && i < count) return i;
  return -1;
}

// ---------- Google API client ----------
class GoogleCalendar {
  constructor({ account, fetchImpl, log = console } = {}) {
    this.account = account || null; // parsed service account JSON
    this.fetch = fetchImpl || globalThis.fetch;
    this.log = log;
    this.tokenCache = null;
  }

  get email() { return this.account ? this.account.client_email : null; }
  get configured() { return !!(this.account && this.account.client_email && this.account.private_key); }

  async token() {
    if (this.tokenCache && this.tokenCache.exp > Date.now() + 60000) return this.tokenCache.value;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const iat = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: this.account.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`;
    const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key).toString('base64url');
    const res = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new Error(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
    this.tokenCache = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
    return this.tokenCache.value;
  }

  async api(method, path, body) {
    const res = await this.fetch(`https://www.googleapis.com/calendar/v3${path}`, {
      method, headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && (data.error.message || data.error.status)) || `HTTP ${res.status}`;
      const e = new Error(res.status === 404 ? `Calendar not found or not shared with ${this.email}` : msg);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  async busy(calendarId, fromMs, toMs) {
    const r = await this.api('POST', '/freeBusy', { timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), items: [{ id: calendarId }] });
    const cal = (r.calendars || {})[calendarId] || {};
    if (cal.errors && cal.errors.length) throw new Error(`Calendar not readable: ${cal.errors[0].reason}. Share it with ${this.email}.`);
    return (cal.busy || []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  }

  createEvent(calendarId, ev) { return this.api('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, ev); }
  updateEvent(calendarId, id, ev) { return this.api('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, ev); }
  async deleteEvent(calendarId, id) { try { await this.api('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; } }

  // Proves the app can actually write to the owner's calendar: adds and removes a tiny event.
  async test(calendarId, tz) {
    const start = Date.now() + 2 * DAY;
    const ev = await this.createEvent(calendarId, {
      summary: 'Connection test (safe to ignore)', start: { dateTime: new Date(start).toISOString(), timeZone: tz }, end: { dateTime: new Date(start + 5 * MIN).toISOString(), timeZone: tz },
    });
    await this.deleteEvent(calendarId, ev.id);
    return true;
  }
}

// ---------- the booking service the engine uses ----------
class Calendar {
  constructor({ google, settings, log = console }) { this.google = google; this.settings = settings; this.log = log; }

  cfg() { return this.settings.get().calendar; }
  get ready() { const c = this.cfg(); return !!(this.google.configured && c.enabled && c.calendar_id); }
  tz() { return this.settings.get().business.timezone || 'Asia/Kolkata'; }

  async busyBlocks(now = Date.now()) {
    const c = this.cfg();
    return this.google.busy(c.calendar_id, now, now + (c.max_days_ahead + 1) * DAY);
  }

  // { ok: true } when the requested time is free, else { ok: false, slots: [nearest free options] }.
  async check(requestedMs, { ignoreEventId = null, now = Date.now() } = {}) {
    const c = this.cfg();
    const busy = await this.busyBlocks(now);
    if (isAvailable(requestedMs, c, busy, this.tz(), now)) return { ok: true };
    return { ok: false, slots: suggestSlots(c, busy, this.tz(), { now, requested: requestedMs }) };
  }

  async offer({ now = Date.now() } = {}) {
    const c = this.cfg();
    return suggestSlots(c, await this.busyBlocks(now), this.tz(), { now });
  }

  eventBody(lead, brief, adminUrl) {
    const c = this.cfg();
    const s = this.settings.get();
    const tz = this.tz();
    const start = lead.callback_at;
    return {
      summary: `${s.business.name}: intro call with ${lead.name || 'a new lead'}`,
      description: [brief, lead.phone ? `Phone: ${lead.phone}` : 'No phone number yet, message them first.', lead.tg_username ? `Instagram: @${lead.tg_username}` : '', adminUrl ? `Lead desk: ${adminUrl}` : '', 'Booked automatically by the assistant.'].filter(Boolean).join('\n'),
      start: { dateTime: new Date(start).toISOString(), timeZone: tz },
      end: { dateTime: new Date(start + c.slot_minutes * MIN).toISOString(), timeZone: tz },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }, { method: 'popup', minutes: 5 }] },
    };
  }

  async book(lead, brief, adminUrl) {
    const ev = await this.google.createEvent(this.cfg().calendar_id, this.eventBody(lead, brief, adminUrl));
    return { event_id: ev.id, link: ev.htmlLink || null, start: lead.callback_at };
  }
  async move(lead, eventId, brief, adminUrl) {
    const ev = await this.google.updateEvent(this.cfg().calendar_id, eventId, this.eventBody(lead, brief, adminUrl));
    return { event_id: ev.id, link: ev.htmlLink || null, start: lead.callback_at };
  }
  cancel(eventId) { return this.google.deleteEvent(this.cfg().calendar_id, eventId); }
}

module.exports = { Calendar, GoogleCalendar, isAvailable, suggestSlots, toLocalIso, pickOrdinal, workDays };
