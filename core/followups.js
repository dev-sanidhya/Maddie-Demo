'use strict';
// The follow-up planner: one pure function that answers "what should the system do
// for this lead next, and when?". The scheduler only executes what this says, the
// dashboard shows it, and tests can check it without any clock or database.
//
// Rules it encodes:
//  - Nudges only go to people who were asked something and have not replied.
//  - Every silence is a fresh streak: when the customer writes again, the counters restart.
//  - Instagram only lets the assistant message within 24 hours of the customer's last
//    message, so the final nudge is pulled forward to land inside that window. When the
//    window closes first, the lead is handed to a human instead of being forgotten.
//  - Nothing is sent in quiet hours (default 9pm to 9am, business time zone) unless the
//    window would close before the morning.
//  - Form leads who never open the chat are flagged for a human call.
//  - Booked calls get a reminder shortly before the call.

const { partsIn, zonedEpoch } = require('./when');

const MIN = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const IG_WINDOW = 23 * HOUR; // 24h minus a 1h safety margin, same as attention.windowOpen

// ---------- helpers ----------
function inQuiet(ts, tz, f) {
  const s = f.quiet_start_hour;
  const e = f.quiet_end_hour;
  if (s === e) return false;
  const h = partsIn(ts, tz).h;
  return s > e ? (h >= s || h < e) : (h >= s && h < e);
}

// First moment at or after ts that is outside quiet hours.
function nextOpen(ts, tz, f) {
  if (!inQuiet(ts, tz, f)) return ts;
  const p = partsIn(ts, tz);
  let day = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  if (p.h >= f.quiet_end_hour && f.quiet_start_hour > f.quiet_end_hour) day = new Date(day.getTime() + DAY); // evening: open again tomorrow morning
  else if (f.quiet_start_hour <= f.quiet_end_hour && p.h >= f.quiet_end_hour) day = new Date(day.getTime() + DAY);
  return zonedEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), f.quiet_end_hour % 24, 0, tz);
}

// Last moment at or before ts that is outside quiet hours.
function prevOpen(ts, tz, f) {
  if (!inQuiet(ts, tz, f)) return ts;
  const p = partsIn(ts, tz);
  let day = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  if (p.h < f.quiet_end_hour) day = new Date(day.getTime() - DAY); // early morning: yesterday evening
  return zonedEpoch(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), f.quiet_start_hour % 24, 0, tz) - 5 * MIN;
}

// Moves `at` out of quiet hours without ever passing `deadline` (when the messaging window closes).
function adjustForHours(at, { tz, f, deadline = Infinity, notBefore = 0 }) {
  if (!inQuiet(at, tz, f)) return at;
  const later = nextOpen(at, tz, f);
  if (later <= deadline) return later;
  const earlier = prevOpen(at, tz, f);
  if (earlier > notBefore) return earlier;
  return at; // no polite slot exists before the window closes: better a late-evening nudge than none
}

// How many nudges / drips have gone out since the customer last wrote.
function streak(lead) {
  const s = (lead.meta && lead.meta.fu_streak) || {};
  const same = s.inbound_at === (lead.last_inbound_at || 0);
  return { followups: same ? s.followups || 0 : 0, drips: same ? s.drips || 0 : 0 };
}

function isInstagram(lead) { return lead.channel === 'instagram' || lead.channel === 'facebook'; } // both have the same 24 hour reply window
// The last moment the assistant may message this lead (Infinity when there is no such window).
function windowEnd(lead) { return isInstagram(lead) ? (lead.last_inbound_at || 0) + IG_WINDOW : Infinity; }

// ---------- the planner ----------
// Returns the single next action as { kind, at, step?, deadline? }, or null.
//   kind: 'reminder' | 'followup' | 'stall' | 'drip' | 'chat_nudge'
function plan(lead, settings, now = Date.now(), { includeDemo = false } = {}) {
  const f = settings.followups;
  const tz = settings.business.timezone || 'Asia/Kolkata';
  const meta = lead.meta || {};
  const fu = meta.fu || {};
  const flags = meta.flags || {};
  if (lead.channel === 'sim' || lead.channel === 'web' || lead.opted_out) return null; // website-chatbot leads arrive finished: there is no chat to follow up in
  if (meta.demo && !includeDemo) return null;
  if (fu.snooze_until && fu.snooze_until > now) return null;
  const out = [];

  // 1. Reminder before a booked call.
  if (lead.callback_at && lead.callback_status === 'scheduled' && !fu.done_at && !lead.reminded_at && !fu.manual_needed_at
    && lead.stage !== 'disqualified' && now < lead.callback_at + f.overdue_after_min * MIN) {
    out.push({ kind: 'reminder', at: lead.callback_at - f.reminder_before_min * MIN });
  }

  if (!f.enabled) return pick(out);

  // 2. The customer has not opened the chat after filling the form: a human should reach out.
  if (!lead.chat_id && lead.stage === 'new' && meta.form && (lead.phone || lead.email) && !fu.manual_needed_at && !fu.manual_done_at && !fu.human_done_at) {
    const at = adjustForHours((lead.created_at || now) + f.chat_nudge_after_min * MIN, { tz, f });
    out.push({ kind: 'chat_nudge', at });
  }

  const chatted = lead.chat_id && !lead.ai_paused && lead.last_outbound_at && !lead.stage_locked;
  const awaiting = chatted && (lead.last_inbound_at || 0) < lead.last_outbound_at;
  const end = windowEnd(lead);
  const s = streak(lead);

  if (awaiting && (lead.stage === 'new' || lead.stage === 'qualifying' || (lead.stage === 'active' && !lead.callback_at && !fu.done_at))) {
    if (s.followups < f.max) {
      const wait = (s.followups === 0 ? f.first_after_min : f.second_after_min) * MIN;
      let at = lead.last_outbound_at + wait;
      if (isInstagram(lead) && s.followups === f.max - 1) at = Math.min(at, end - f.last_call_margin_min * MIN); // the last nudge must land inside the window
      at = Math.max(at, lead.last_outbound_at + 5 * MIN);
      if (now >= end) { if (lead.stage !== 'active') out.push({ kind: 'stall', at: end }); } // window closed before we could nudge: hand over
      else out.push({ kind: 'followup', at: Math.min(adjustForHours(at, { tz, f, deadline: end, notBefore: lead.last_outbound_at }), end), step: s.followups + 1, deadline: end });
    } else if (lead.stage !== 'active' && !flags.stalled) {
      // On Instagram the hand-over happens the moment the assistant can no longer write; elsewhere after a quiet spell.
      out.push({ kind: 'stall', at: isInstagram(lead) ? Math.max(lead.last_outbound_at + HOUR, end) : lead.last_outbound_at + f.stall_after_min * MIN });
    }
  }

  // 3. Keep-warm check-ins for nurture leads (only where the assistant is still allowed to write).
  if (chatted && lead.stage === 'nurture' && s.drips < f.nurture_max) {
    const at = lead.last_outbound_at + f.nurture_every_days * DAY;
    if (at < end) out.push({ kind: 'drip', at: adjustForHours(at, { tz, f, deadline: end, notBefore: lead.last_outbound_at }), step: s.drips + 1, deadline: end });
  }
  return pick(out);
}

function pick(list) {
  if (!list.length) return null;
  return list.sort((a, b) => a.at - b.at)[0];
}

// A short human description of a plan, for the dashboard.
function describe(p) {
  if (!p) return null;
  switch (p.kind) {
    case 'reminder': return 'Call reminder';
    case 'followup': return `Follow-up ${p.step || 1}`;
    case 'drip': return 'Check-in message';
    case 'stall': return 'Hand over to you';
    case 'chat_nudge': return 'Ask you to reach out';
    default: return p.kind;
  }
}

module.exports = { plan, describe, streak, windowEnd, inQuiet, nextOpen, prevOpen, adjustForHours, IG_WINDOW };
