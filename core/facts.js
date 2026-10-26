'use strict';
// Turns the LLM's raw extraction into validated, sticky lead facts. The model
// proposes; this module disposes. Numbers are range-checked, contact details are
// regex-verified against what the person actually typed, and explicit budget
// phrases ("8 lakh", "50k") are re-parsed deterministically so a model slip
// cannot move a lead across the budget bar.

const { parseAmount, looksLikeBudget, amountSupportedByText, isBareNumberAnswer } = require('./budget');
const { parseWhen, isoLocalToEpoch } = require('./when');

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,17}\d)/;

// The model proposes flags; the customer's own words must back them up. A harmless
// "hi bhai, 2bhk interior karwana hai" must never be able to hand a lead to a human or end the chat.
const HUMAN_WORDS = /\b(human|person|people|agent|representative|someone|somebody|staff|manager|owner|real|bot|robot|talk to|speak to|speak with|talk with|connect me|insaan|aadmi|banda|kisi se|complain|complaint|angry|useless|worst|scam|fraud|rubbish|stupid|idiot|annoying)\b/i;
const STOP_WORDS = /\b(not interested|no longer|stop|unsubscribe|remove me|leave me|don'?t (want|message|contact|call)|do not (want|message|contact|call)|nahi chahiye|nahin chahiye|mat karo|no thanks|no thank you|nope|cancel|changed my mind|forget it|never mind|nevermind)\b/i;

// Who is writing: creators, press and existing clients are not new brand leads. The model proposes a type and
// the person's own words must back it up, so a brand that merely mentions influencers is never rerouted.
const ROUTE_WORDS = {
  creator: /\b(i am|i'm|im|i m|we are|we're|as)\b[^.?!]{0,40}\b(creator|influencer|blogger|vlogger|youtuber|content creator|model|artist)\b|\bmy (instagram|page|channel|handle|followers|reels|content|niche|profile)\b|\b\d+\s?(k|m)?\s?followers\b|\bjoin (your|the) (roster|network|team|campaigns?)\b|\bi (do|make|create|post|shoot|run)\b[^.?!]{0,30}\b(reels|content|videos|posts|a page|a channel)\b|\b(campaigns?|gigs?|collabs?|opportunit(y|ies)) (i|we) can (join|do|apply)\b|\bcan i (join|apply|collab|work with you)\b/i,
  press: /\b(journalist|reporter|editor|magazine|publication|newspaper|press|media house|podcast|writing a (story|piece|feature)|feature on|interview)\b/i,
  existing_client: /\b(already (a |your )?client|existing client|current client|ongoing campaign|our ongoing|working with you|my account manager|our account manager)\b/i,
};

const clip = (s, n) => String(s).trim().replace(/\s+/g, ' ').slice(0, n);
const validNum = (v) => typeof v === 'number' && Number.isFinite(v);

function extractContact(text) {
  const out = {};
  const email = String(text || '').match(EMAIL_RE);
  if (email) out.email = email[0].toLowerCase();
  const phone = String(text || '').match(PHONE_RE);
  if (phone) {
    const digits = phone[0].replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) out.phone = phone[0].trim();
  }
  return out;
}

// Returns { patch, changed, meta } where patch holds column updates and meta is
// the updated lead.meta object (flags, refusal counters, declined fields).
// "Did I say my budget was 20 lakh?" asks about the record, it does not change it. A model sometimes reads
// such a question as a new statement, so the code refuses to let a recall question edit anything.
const CONFIRM_QUESTION = /\b(did i (say|tell|mention|give|share)|didn'?t i (say|tell|mention)|have i (said|told|mentioned)|do you (remember|recall)|remind me|what (was|is|were) my|what did i|you said (that )?(my|the))\b/i;
const isConfirmQuestion = (text) => CONFIRM_QUESTION.test(String(text || '')) && /\?/.test(String(text || ''));

function applyFacts(lead, f, userText, { lastAsked = null, settings, now = Date.now() }) {
  f = f && typeof f === 'object' ? f : {};
  const patch = {};
  const changed = [];
  const meta = JSON.parse(JSON.stringify(lead.meta || {}));
  meta.flags = meta.flags || {};
  meta.declined = meta.declined || {};
  meta.refusals = meta.refusals || {};
  if (isConfirmQuestion(userText)) return { patch, changed, meta }; // a question about the record never edits it
  const set = (col, val) => {
    if (val === null || val === undefined || val === '') return;
    if (lead[col] === val) return;
    patch[col] = val;
    changed.push(col);
  };

  if (!lead.name && typeof f.name === 'string' && f.name.trim()) set('name', clip(f.name, 60));

  const contact = extractContact(userText);
  if (contact.email) set('email', contact.email);
  else if (typeof f.email === 'string' && EMAIL_RE.test(f.email)) set('email', f.email.trim().toLowerCase());
  if (contact.phone) set('phone', contact.phone);

  if (typeof f.project_type === 'string' && f.project_type.trim()) set('project_type', clip(f.project_type, 60));
  if (typeof f.city === 'string' && f.city.trim()) set('city', clip(f.city, 60));

  // Budget: explicit units in the message are parsed by code and win over the model.
  const q = settings.qualification;
  let amount = null;
  const textHasBudget = looksLikeBudget(userText);
  if (textHasBudget || lastAsked === 'budget') {
    amount = parseAmount(userText, { allowBare: lastAsked === 'budget' && isBareNumberAnswer(userText) });
  }
  if (amount === null && validNum(f.budget_amount) && amountSupportedByText(f.budget_amount, userText)) amount = f.budget_amount;
  if (amount !== null && amount >= 1000 && amount <= 1e11) {
    set('budget_amount', Math.round(amount));
    if (typeof f.budget_text === 'string' && f.budget_text.trim()) set('budget_text', clip(f.budget_text, 60));
    else set('budget_text', clip(userText, 60));
  }

  if (validNum(f.timeline_months) && f.timeline_months >= 0 && f.timeline_months <= 120) {
    set('timeline_months', Math.round(f.timeline_months * 10) / 10);
    if (typeof f.timeline_text === 'string' && f.timeline_text.trim()) set('timeline_text', clip(f.timeline_text, 60));
  }

  // Append-only memory: every concrete detail the customer states, kept word for word, never compressed away.
  if (Array.isArray(f.details) && f.details.length) {
    const have = Array.isArray(meta.memory) ? meta.memory.slice() : [];
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    for (const d of f.details.slice(0, 8)) {
      if (typeof d !== 'string') continue;
      const t = clip(d.replace(/[‒-―]/g, ', '), 110);
      if (t.length < 4 || /^(null|none|n\/a|unknown)$/i.test(t)) continue;
      if (have.some((h) => norm(h) === norm(t) || norm(h).includes(norm(t)) || norm(t).includes(norm(h)))) continue;
      have.push(t);
    }
    meta.memory = have.slice(-80);
  }
  if (typeof f.notes === 'string' && f.notes.trim() && f.notes.trim().toLowerCase() !== 'null') {
    const prev = lead.notes || '';
    const add = clip(f.notes, 160);
    if (!prev.toLowerCase().includes(add.toLowerCase())) set('notes', clip(prev ? `${prev}; ${add}` : add, 600));
  }

  // Property details the designer needs, kept as short phrases.
  for (const [col, key, n] of [['property', 'property', 80], ['scope', 'scope', 160], ['style', 'style', 100], ['contact_pref', 'contact_pref', 100]]) {
    if (typeof f[key] === 'string' && f[key].trim() && !/^(null|none|n\/a|unknown)$/i.test(f[key].trim())) set(col, clip(f[key], n));
  }

  // Call / meeting time. The deterministic parser and the model are cross-checked:
  // an explicit clock time in the customer's own words wins over the model's guess.
  const tz = settings.business.timezone || 'Asia/Kolkata';
  // Also treat a clear time in a message as a (re)schedule when a call is already in play and the
  // wording is about meeting, even if the model did not flag it.
  const rescheduleWords = /\b(make it|instead|change|reschedul|move|shift|postpone|prepone|can we|could we|call|meet|visit|available|free|works)\b/i;
  const detEarly = (lead.callback_at || lead.callback_text) && rescheduleWords.test(userText) ? parseWhen(userText, now, tz) : null;
  // The model sees the whole chat and may re-read an old "tomorrow 5 pm" when someone just says "hey": a call time is only
  // taken from the model when the customer's own latest words contain a day or a time.
  const det = parseWhen(userText, now, tz);
  const userSaidTime = !!(det && (det.day || det.hasTime));
  const wantsCallback = lastAsked === 'callback' || (typeof f.callback_text === 'string' && f.callback_text.trim() && userSaidTime) || !!(detEarly && detEarly.hasTime);
  if (wantsCallback) {
    const hourIn = (ts) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(ts));
    let llmAt = typeof f.callback_at === 'string' ? isoLocalToEpoch(f.callback_at, tz) : null;
    if (llmAt !== null && (llmAt < now - 10 * 60000 || llmAt > now + 120 * 86400000)) llmAt = null;
    let at = null;
    if (det && det.at && det.hasTime && !det.approx) at = det.at;
    // "tomorrow anytime" has a day but no time: that is a preference, never midnight
    else if (llmAt !== null && !(det && !det.hasTime) && hourIn(llmAt) !== 0) at = llmAt;
    else if (det && det.at && det.hasTime) at = det.at;
    const words = clip((typeof f.callback_text === 'string' && f.callback_text.trim()) || userText, 80);
    if (at !== null && at < now - 10 * 60000) at = null;
    // calls only happen inside working hours (default 10 AM to 6 PM business time): an exact time outside them is kept as a
    // preference and the assistant asks for a time inside the window instead of booking it
    const cal = (settings && settings.calendar) || {};
    const minuteOfDay = (ts) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ts); return Number(p.find((x) => x.type === 'hour').value) * 60 + Number(p.find((x) => x.type === 'minute').value); };
    if (at !== null && Number.isFinite(cal.work_start_hour) && Number.isFinite(cal.work_end_hour)) {
      const m = minuteOfDay(at);
      if (m < cal.work_start_hour * 60 || m > cal.work_end_hour * 60) { at = null; meta.flags.callback_outside = true; }
    }
    if (at !== null) {
      delete meta.flags.callback_outside;
      if (lead.callback_at !== at) {
        set('callback_at', at);
        set('callback_text', words);
        set('callback_status', 'scheduled');
        meta.fu = { ...(meta.fu || {}) };
        delete meta.fu.reminded_at; delete meta.fu.done_at; delete meta.fu.manual_needed_at; delete meta.fu.manual_reason; delete meta.fu.snooze_until;
      }
    } else if ((det && det.day) || (typeof f.callback_text === 'string' && f.callback_text.trim())) {
      // A preference without an exact time ("tomorrow evening", "sometime next week").
      if (!lead.callback_at && lead.callback_text !== words) { set('callback_text', words); set('callback_status', 'requested'); }
      else if (meta.flags.callback_outside && !lead.callback_at) set('callback_status', 'requested');
    }
    if (typeof f.callback_kind === 'string' && /visit|video|call/i.test(f.callback_kind)) set('callback_kind', /visit/i.test(f.callback_kind) ? 'visit' : /video/i.test(f.callback_kind) ? 'video' : 'call');
  }

  // Flags and refusals.
  const known = { ...lead, ...patch };
  const fieldKnown = {
    project_type: !!known.project_type,
    city: !!known.city,
    budget: known.budget_amount != null,
    timeline: known.timeline_months != null,
  };
  if (f.wants_human === true && HUMAN_WORDS.test(userText)) meta.flags.wants_human = true;
  if (!meta.flags.routed && ROUTE_WORDS[f.contact_type] && ROUTE_WORDS[f.contact_type].test(userText)) meta.flags.routed = f.contact_type;
  if (f.not_interested === true && STOP_WORDS.test(userText)) meta.flags.not_interested = true;
  else if (changed.length && meta.flags.not_interested) delete meta.flags.not_interested;
  if (Array.isArray(f.refused)) {
    for (const field of f.refused) {
      if (field in fieldKnown && !fieldKnown[field]) {
        meta.refusals[field] = (meta.refusals[field] || 0) + 1;
      }
    }
  }
  for (const field of Object.keys(fieldKnown)) {
    if (fieldKnown[field]) delete meta.declined[field];
    else if ((meta.refusals[field] || 0) >= 2) meta.declined[field] = true;
  }
  return { patch, changed, meta };
}

module.exports = { applyFacts, extractContact, isConfirmQuestion };
