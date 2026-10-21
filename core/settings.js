'use strict';
// Admin-editable configuration. Everything the demo needs to "adjust and alter"
// lives here, stored as JSON in the DB and deep-merged over these defaults so a
// partially saved or older config can never leave a key undefined.

const DEFAULTS = {
  business: {
    name: 'Your Business',
    contact_email: '',
    tagline: 'Design to execution, under one roof',
    timezone: 'Asia/Kolkata',
    description: 'A premium interior design and execution studio for homes, offices and commercial spaces. We design, build and hand over turnkey projects.',
    services: ['Full home interiors', 'Modular kitchens and wardrobes', 'Office interiors', 'Renovations', 'Design-only consultation'],
    pricing_note: 'Pricing depends on carpet area, material and scope. Never quote exact numbers; offer a free consultation for an accurate estimate.',
    areas: 'Pune and nearby, other cities case by case',
    extra_knowledge: 'A typical full-home project takes 8 to 12 weeks. Every project gets a dedicated designer, a 3D design preview and a site supervisor.',
  },
  agent: {
    name: 'Aria',
    title: 'virtual design consultant',
    tone: 'premium but human, warm and genuinely enthusiastic, like a knowledgeable consultant who loves helping people shape their space',
    languages: 'Reply in the language the person writes in (English, Hindi or Hinglish).',
    reveal_minimum: false,
    extra_instructions: '',
    // 'light' lets replies carry one tasteful emoji from a fixed set; 'off' (the default) keeps them plain.
    emojis: 'off',
    // true: strips filler openers and stock chatbot phrases so replies read as written by a person.
    polish: false,
  },
  qualification: {
    currency: 'INR',
    min_budget: 500000,
    borderline_pct: 0,
    active_within_months: 3,
    required: ['project_type', 'city', 'budget', 'timeline'],
    service_cities: [],
    project_types: ['Full home', 'Modular kitchen', 'Office', 'Renovation', 'Other'],
  },
  followups: {
    enabled: true,
    first_after_min: 480,
    second_after_min: 720,
    max: 2,
    last_call_margin_min: 180,
    stall_after_min: 720,
    chat_nudge_after_min: 30,
    quiet_start_hour: 0,
    quiet_end_hour: 0,
    nurture_every_days: 7,
    nurture_max: 3,
    reminder_before_min: 60,
    overdue_after_min: 30,
  },
  channels: {
    primary: 'auto',
    ice_breakers: ['Get a free design quote', 'Check if my project fits', 'Talk about my budget'],
  },
  // How long customers' photos are kept. 0 keeps them for ever; N deletes each photo N days after it was sent.
  retention: { photo_days: 0 },
  calendar: {
    enabled: false,
    calendar_id: '',
    work_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    work_start_hour: 10,
    work_end_hour: 19,
    slot_minutes: 30,
    buffer_min: 15,
    min_notice_min: 120,
    max_days_ahead: 14,
  },
  handoff: {
    notify_chat_id: '',
    webhook_url: '',
    webhook_secret: '',
    alert_stages: ['active', 'human'],
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Deep merge restricted to keys that exist in `base`, so unknown keys sent by a
// client are dropped rather than persisted.
function merge(base, over) {
  if (!isObj(base)) return over === undefined ? base : over;
  const out = { ...base };
  if (!isObj(over)) return out;
  for (const k of Object.keys(base)) {
    if (k in over) out[k] = isObj(base[k]) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

const listish = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);

// Coerce whatever the admin UI sends so the engine never sees junk.
function sanitize(s) {
  const q = s.qualification;
  q.min_budget = Math.max(0, Number(q.min_budget) || 0);
  q.borderline_pct = Math.min(50, Math.max(0, Number(q.borderline_pct) || 0));
  q.active_within_months = Math.max(0, Number(q.active_within_months) || 0);
  q.required = listish(q.required).filter((f) => ['project_type', 'city', 'budget', 'timeline'].includes(f));
  if (!q.required.length) q.required = ['budget'];
  q.service_cities = listish(q.service_cities);
  q.project_types = listish(q.project_types);
  q.currency = String(q.currency || 'INR').toUpperCase().slice(0, 4);
  s.business.services = listish(s.business.services);
  s.business.contact_email = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(String(s.business.contact_email || '').trim()) ? String(s.business.contact_email).trim() : '';
  const f = s.followups;
  f.enabled = !!f.enabled;
  for (const k of ['first_after_min', 'second_after_min', 'max', 'nurture_every_days', 'nurture_max', 'reminder_before_min', 'overdue_after_min', 'last_call_margin_min', 'stall_after_min', 'chat_nudge_after_min']) f[k] = Math.max(0, Number(f[k]) || 0);
  f.quiet_start_hour = Math.min(24, Math.max(0, Math.round(Number(f.quiet_start_hour)) || 0));
  f.quiet_end_hour = Math.min(24, Math.max(0, Math.round(Number(f.quiet_end_hour)) || 0));
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.business.timezone }); } catch { s.business.timezone = 'Asia/Kolkata'; }
  s.retention.photo_days = Math.min(3650, Math.max(0, Math.round(Number(s.retention.photo_days)) || 0));
  const c = s.calendar;
  c.enabled = !!c.enabled;
  c.calendar_id = String(c.calendar_id || '').trim();
  c.work_days = listish(c.work_days).map((d) => d.slice(0, 3)).filter((d) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(d.toLowerCase()));
  if (!c.work_days.length) c.work_days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  c.work_start_hour = Math.min(23, Math.max(0, Math.round(Number(c.work_start_hour)) || 10));
  c.work_end_hour = Math.min(24, Math.max(c.work_start_hour + 1, Math.round(Number(c.work_end_hour)) || 19));
  c.slot_minutes = Math.min(180, Math.max(15, Math.round(Number(c.slot_minutes)) || 30));
  c.buffer_min = Math.min(120, Math.max(0, Math.round(Number(c.buffer_min)) || 0));
  c.min_notice_min = Math.min(10080, Math.max(0, Math.round(Number(c.min_notice_min)) || 0));
  c.max_days_ahead = Math.min(60, Math.max(1, Math.round(Number(c.max_days_ahead)) || 14));
  s.agent.reveal_minimum = !!s.agent.reveal_minimum;
  s.agent.emojis = s.agent.emojis === 'light' ? 'light' : 'off';
  s.agent.polish = !!s.agent.polish;
  s.channels.primary = ['auto', 'instagram', 'telegram'].includes(s.channels.primary) ? s.channels.primary : 'auto';
  s.channels.ice_breakers = listish(s.channels.ice_breakers).slice(0, 4);
  s.handoff.alert_stages = listish(s.handoff.alert_stages);
  s.handoff.notify_chat_id = String(s.handoff.notify_chat_id || '').trim();
  return s;
}

class Settings {
  constructor(store, { maxAgeMs = 3000 } = {}) { this.store = store; this.cache = null; this.loadedAt = 0; this.maxAgeMs = maxAgeMs; }
  // Serverless instances cannot share memory, so the database is the truth: call refresh()
  // at the start of every request or job and get() then stays synchronous.
  async refresh({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.loadedAt < this.maxAgeMs) return this.cache;
    this.cache = sanitize(merge(DEFAULTS, await this.store.settingsRaw()));
    this.loadedAt = Date.now();
    return this.cache;
  }
  get() {
    if (!this.cache) throw new Error('Settings not loaded yet: await settings.refresh() first');
    return this.cache;
  }
  async update(patch) {
    await this.refresh({ force: true });
    const next = sanitize(merge(this.get(), patch));
    for (const k of Object.keys(DEFAULTS)) await this.store.settingsSetRaw(k, next[k]);
    this.cache = next;
    this.loadedAt = Date.now();
    return next;
  }
}

module.exports = { Settings, DEFAULTS, merge, sanitize };
