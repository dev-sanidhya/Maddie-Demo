'use strict';
// CRM placement: the assistant's judge reads the whole chat and decides which category (who the person is) and which stage
// (where they sit in the CRM) a lead belongs in. This file holds the taxonomy, the model call, and the code guards that stop an
// impossible placement (a vendor marked "Active", a bare "hi" marked "Qualifying") from ever reaching the CRM.
// Applying a placement to a lead lives in the engine (placeLead); this file stays pure so it can be tested without a database.

const fs = require('node:fs');
const path = require('node:path');
const { extractJson } = require('./llm');

const CATEGORIES = ['brand_lead', 'invited_creator', 'creator_pitching', 'existing_campaign', 'vendor_or_promo', 'job_seeker', 'press', 'spam_or_bot', 'personal_or_other'];
const CATEGORY_LABELS = {
  brand_lead: 'Brand lead',
  invited_creator: 'Invited creator',
  creator_pitching: 'Creator pitching',
  existing_campaign: 'Existing campaign',
  vendor_or_promo: 'Vendor or promo',
  job_seeker: 'Job seeker',
  press: 'Press',
  spam_or_bot: 'Spam or bot',
  personal_or_other: 'Other',
};
const STAGES = ['new', 'qualifying', 'active', 'nurture', 'disqualified', 'human'];
// People who are never a sales opportunity: they can only ever sit in Disqualified (the team is not asked to act on them).
const NEVER_A_LEAD = new Set(['vendor_or_promo', 'spam_or_bot', 'job_seeker']);
const REAL_PEOPLE = new Set(['brand_lead', 'invited_creator', 'creator_pitching', 'existing_campaign', 'press']);

const FILE = path.join(__dirname, '..', 'prompts', 'classify.md');
let text = null;
const loadClassify = () => text || (text = fs.readFileSync(FILE, 'utf8'));

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
const noDashes = (s) => String(s || '').replace(/\s*[—–]\s*/g, ', ');

// Does the customer's side of the chat contain real words (not only shared posts, photos or voice notes)?
const typedWords = (rows) => rows.filter((m) => m.direction === 'in' && !/^\s*\[[^\]]*\]\s*$/.test(String(m.text || ''))).reduce((n, m) => n + String(m.text || '').trim().split(/\s+/).filter(Boolean).length, 0);

const AUTO = /\b(business hours|press \d (for|to)|auto[- ]?reply|automated (message|reply|response)|out of office|(we|our team) (will|'ll) (get back|respond|reply)( to you)? (shortly|soon|within|as soon)|reply within|respond within|thank you for (contacting|messaging|reaching out to) us|thanks for (contacting|messaging) us)\b/i;
// Words a real person uses to say what they want. A robot's greeting does not contain them.
const WANTS = /\b(we want|i want|looking for|interested in|budget|lakhs?|followers|i am a|i'm a|we are a|we're a|can we talk|can you)\b/i;
// Every customer message so far reads like a business's automated greeting (a few short messages at most).
function looksAutomated(rows) {
  const mine = rows.filter((m) => m.direction === 'in' && String(m.text || '').trim());
  if (!mine.length || mine.length > 2) return false;
  const words = mine.reduce((n, m) => n + String(m.text).trim().split(/\s+/).length, 0);
  return words <= 60 && mine.every((m) => AUTO.test(String(m.text)) && !WANTS.test(String(m.text)));
}
// The customer's latest messages ask for a human.
const ASKS = /\b(real|actual) (person|human)\b|\b(speak|talk|connect|chat) (to|with) (a |an |the |your )?(human|person|someone|somebody|team|manager|owner|founder|representative|agent)\b|\bi want (a|to speak to a) (human|person)\b/i;
const OUT = /\b(remove me|unsubscribe|stop (messaging|texting|dm-?ing|contacting) me|do not (message|contact|dm) me|don'?t (message|contact|dm) me|leave me alone)\b/i;
function wantsOut(rows) { return rows.filter((m) => m.direction === 'in').slice(-2).some((m) => OUT.test(String(m.text || ''))); }
function asksForPerson(rows) {
  const mine = rows.filter((m) => m.direction === 'in').slice(-2);
  return mine.some((m) => ASKS.test(String(m.text || '')));
}

// Turns the model's answer into a safe placement, or null when it cannot be trusted (the lead then keeps its current placement).
//   out: the parsed JSON.  rows: the chat.  current: { category, stage } the lead has now, if any.
function normalizePlacement(out, { rows = [], current = null } = {}) {
  if (!out || typeof out !== 'object') return null;
  const category = String(out.category || '').trim().toLowerCase();
  let stage = String(out.stage || '').trim().toLowerCase();
  if (!CATEGORIES.includes(category) || !STAGES.includes(stage)) return null;
  const confidence = ['high', 'medium', 'low'].includes(String(out.confidence || '').toLowerCase()) ? String(out.confidence).toLowerCase() : 'medium';
  let reason = clip(noDashes(out.reason), 140);
  const notes = [];

  // An unsure judge never moves anyone who already has a placement.
  if (confidence === 'low' && current && current.stage) return null;

  if (NEVER_A_LEAD.has(category) && stage !== 'disqualified') { notes.push(`${stage}->disqualified: ${category} is never a lead`); stage = 'disqualified'; }
  if (category === 'personal_or_other' && (stage === 'qualifying' || stage === 'active')) { notes.push(`${stage}->new: nothing to qualify`); stage = 'new'; }
  if (category === 'personal_or_other' && stage === 'disqualified' && typedWords(rows) === 0) { notes.push('disqualified->new: only shared media, nothing to judge'); stage = 'new'; }
  if (stage === 'new' && REAL_PEOPLE.has(category) && typedWords(rows) >= 3) { notes.push('new->qualifying: they have already written to us'); stage = 'qualifying'; }
  if (stage === 'new' && REAL_PEOPLE.has(category) && typedWords(rows) >= 12) { notes.push('new->qualifying: a real conversation'); stage = 'qualifying'; }
  // a business's own automated greeting is never a person, whoever wrote first
  if (looksAutomated(rows) && category !== 'spam_or_bot') { notes.push(`${category}/${stage}->spam_or_bot/disqualified: an automated reply`); return { category: 'spam_or_bot', stage: 'disqualified', reason: 'Automated reply from a business, not a person', confidence: 'high', evidence: clip(out.evidence, 160), notes }; }
  // asking for a person is always a person's job (unless they are not a lead at all)
  // "remove me", "stop messaging me": a firm no, whoever they are
  if (wantsOut(rows) && category !== 'press' && stage !== 'disqualified') { notes.push(`${stage}->disqualified: asked to be left alone`); stage = 'disqualified'; }
  if (asksForPerson(rows) && !NEVER_A_LEAD.has(category) && stage !== 'human') { notes.push(`${stage}->human: asked for a person`); stage = 'human'; }
  if (!reason) reason = `${CATEGORY_LABELS[category]}, ${stage === 'human' ? 'needs the team' : stage}`;
  return { category, stage, reason, confidence, evidence: clip(out.evidence, 160), notes };
}

// Asks the judge. Returns a normalized placement, or null when the judge could not be read (never throws).
//   did: what the assistant just did this turn, if anything: { action, needsTeam, why, reply }
async function classify({ llm, lead, rows, settings, transcript, factsLine, now = Date.now(), current = null, did = null, retries = 2, confirm = true }) {
  const tz = settings.business.timezone || 'Asia/Kolkata';
  const system = loadClassify().split('{{BUSINESS}}').join(settings.business.name);
  const NL = String.fromCharCode(10);
  const place = current && current.stage ? `category "${current.category || 'unknown'}", stage "${current.stage}"${current.reason ? `, reason "${clip(current.reason, 120)}"` : ''}${current.by === 'admin' ? ' (set by a person on the team)' : ''}` : 'not filed yet';
  const user = `CHAT (oldest first):${NL}${transcript(rows, tz, now)}${NL}${NL}WHAT WE NOTED ABOUT THEM: ${factsLine(lead)}${NL}${NL}CURRENT CRM PLACEMENT: ${place}`
    + (lead.ai_paused ? `${NL}${NL}NOTE: a person on the team has taken over this chat.` : '')
    + (did ? `${NL}${NL}WHAT THE ASSISTANT JUST DID: ${did.action || 'nothing'}${did.needsTeam ? ', flagged the team' : ''}${did.why ? `. Its note: ${clip(did.why, 200)}` : ''}${did.reply ? `. It sent: "${clip(did.reply, 200)}"` : ''}` : '')
    + `${NL}${NL}Decide the placement. JSON only.`;
  const ask = async () => {
    for (let i = 0; i <= retries; i++) {
      try {
        const raw = await llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature: 0.1, maxTokens: 700, thinking: 0 });
        const out = typeof raw === 'object' && raw ? raw : extractJson(raw);
        const p = normalizePlacement(out, { rows, current });
        if (p) return p;
        if (out && String(out.confidence || '').toLowerCase() === 'low') return null; // an honest "not sure": keep what is there
      } catch (e) { if (i === retries) return null; }
    }
    return null;
  };
  const first = await ask();
  // Moving a lead that is already filed needs two opinions that both say it should move, so one wobbly answer can never shuffle the CRM.
  if (first && current && current.stage && first.stage !== current.stage && confirm) {
    const second = await ask();
    if (!second || second.stage === current.stage) return null; // the second opinion says "leave it": it stays
    if (second.stage === first.stage) return second.category === first.category ? first : { ...first, category: second.category };
    // both say it should move, just not to the same place: take the milder one (never write someone off on a disagreement)
    return first.stage === 'disqualified' ? second : first;
  }
  return first;
}

module.exports = { CATEGORIES, CATEGORY_LABELS, STAGES, NEVER_A_LEAD, normalizePlacement, classify, typedWords };
