'use strict';
const fs = require('node:fs');
const path = require('node:path');
// The "concierge": instead of walking a fixed script, the assistant reads the WHOLE conversation (and what the team has said
// in it), knows how the team talks and what the business offers, and decides for itself: reply, stay quiet, or hand over to a person.
// It is told what it may state and what only a person may decide. Every reply is checked before it is sent.

const { extractJson } = require('./llm');
const { ungrounded } = require('./validator');
const { chatKey } = require('./chatkey');

const HISTORY_MAX_MSGS = 60;
const HISTORY_MAX_CHARS = 12000;
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}...` : t; };

function when(ms, tz) {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms); } catch { return new Date(ms).toISOString().slice(0, 16); }
}
function ago(ms, now) {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 2) return 'just now';
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// One line per message: who, when, what. Newest last. Very long chats keep how they began plus the latest part.
function transcript(rows, tz, now) {
  const lines = rows.map((m) => {
    const who = m.direction === 'in' ? 'CUSTOMER' : m.role === 'admin' ? 'TEAM (a person)' : 'YOU (assistant)';
    return `[${when(m.created_at, tz)}, ${ago(m.created_at, now)}] ${who}: ${clip(m.text, 700)}`;
  });
  let out = lines.length > HISTORY_MAX_MSGS ? [...lines.slice(0, 4), `... (${lines.length - HISTORY_MAX_MSGS - 4} earlier messages left out) ...`, ...lines.slice(-(HISTORY_MAX_MSGS - 4))] : lines;
  let text = out.join('\n');
  while (text.length > HISTORY_MAX_CHARS && out.length > 12) { out = [...out.slice(0, 3), '... (older messages left out) ...', ...out.slice(6)]; text = out.join('\n'); }
  return text;
}

function factsLine(lead) {
  const f = [
    lead.name && `name: ${lead.name}`, lead.tg_username && `Instagram profile: @${lead.tg_username} (already known, never ask for it)`, lead.phone && `phone: ${lead.phone}`, lead.email && `email: ${lead.email}`,
    (lead.scope || lead.project_type) && `wants: ${lead.scope || lead.project_type}`, lead.property && `brand/profile: ${lead.property}`,
    lead.city && `where: ${lead.city}`, (lead.budget_text || lead.budget_amount) && `budget: ${lead.budget_text || lead.budget_amount}`,
    lead.timeline_text && `timing: ${lead.timeline_text}`, lead.callback_text && `call preference: ${lead.callback_text}`,
  ].filter(Boolean);
  return f.length ? f.join('; ') : 'nothing recorded yet';
}

function businessFacts(settings) {
  const b = settings.business;
  return [
    `Business: ${b.name} - ${b.tagline}`,
    `About: ${b.description}`,
    `Services: ${(b.services || []).join('; ')}`,
    `Areas: ${b.areas}`,
    `Pricing policy (the ONLY prices you may state, and only to businesses asking for our services): ${b.pricing_note}`,
    b.extra_knowledge ? `Other facts: ${b.extra_knowledge}` : '',
    b.creator_notes ? `How we deal with creators and influencers (approved): ${b.creator_notes}` : '',
  ].filter(Boolean).join('\n');
}

// Every instruction lives in prompts/concierge.md (edit that file to change how the assistant behaves).
const PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'concierge.md');
let promptText = null;
const loadPrompt = () => promptText || (promptText = fs.readFileSync(PROMPT_FILE, 'utf8'));

const JUDGE_FILE = path.join(__dirname, '..', 'prompts', 'judge.md');
let judgeText = null;
const loadJudge = () => judgeText || (judgeText = fs.readFileSync(JUDGE_FILE, 'utf8'));

function systemPrompt({ settings, playbook, style, now }) {
  const tz = settings.business.timezone || 'Asia/Kolkata';
  const todayStr = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const styleBlock = style && style.length ? ['HOW OUR TEAM WRITES (real examples, copy the tone and length, not the content)', ...style.map((x) => `- ${x}`), '', ''].join(String.fromCharCode(10)) : '';
  const slots = { '{{BUSINESS}}': settings.business.name, '{{TODAY}}': todayStr, '{{TZ}}': tz, '{{PLAYBOOK}}': playbook || '(none yet)', '{{STYLE}}': styleBlock };
  return Object.entries(slots).reduce((text, [k, v]) => text.split(k).join(v), loadPrompt());
}

// Replies are checked before they are sent. Returns '' when a reply cannot be trusted.
const wordSet = (x) => new Set(String(x).toLowerCase().replace(/[^a-z0-9ऀ-ॿ\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
function similar(a, b) { const A = wordSet(a), B = wordSet(b); if (!A.size || !B.size) return 0; let i = 0; for (const w of A) if (B.has(w)) i++; return i / (A.size + B.size - i); }

function checkReply(text, grounding, { previous = '', recent = [], contactGrounding } = {}) {
  let t = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/[—–]/g, ', ')
    .replace(/\*\*|__|`/g, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (!t) return '';
  if (/system prompt|FACTS|PLAYBOOK|needs_team|\{"action"|TEAM \(a person\)|YOU \(assistant\)|\[Studio team/i.test(t)) return '';
  // contact details must come from the facts or the chat, never from the model's imagination
  // ...and only from the APPROVED business facts: an email or number that merely appears in the chat belongs to someone else.
  const known = String(contactGrounding === undefined ? grounding : contactGrounding || '').toLowerCase();
  const digitsKnown = known.replace(/[^0-9]/g, '');
  for (const n of t.match(/[+]?[0-9][0-9 -]{6,}[0-9]/g) || []) { const d = n.replace(/[^0-9]/g, ''); if (d.length >= 8 && !digitsKnown.includes(d)) return ''; }
  const contacts = t.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/\S+|\bwww\.\S+/gi) || [];
  if (contacts.some((c) => !known.includes(c.toLowerCase().replace(/[.,;:!?)]+$/, '')))) return ''; // an email or link nobody gave it
  const sentences = t.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !ungrounded(s, grounding));
  if (kept.length < sentences.length) return ''; // it stated a number, amount or date nobody gave it
  if (t.length > 360) return ''; // a DM, not a letter
  if (previous && similar(t, previous) >= 0.75) return ''; // never say the same thing twice in a row
  // Phones write curly apostrophes (we’ll): the checks below read a straight-apostrophe copy so they cannot be dodged by punctuation.
  const g = t.replace(/[‘’]/g, "'");
  // It cannot send, book or arrange anything. It may only say the team will, or that it has passed something to the team.
  if (/\b(?:we|i)(?:'ve| have| just| already)?\s+(?:re)?(?:sent|emailed|mailed|texted|booked|scheduled|arranged|updated|changed|shipped|dispatched|refunded|approved|confirmed)\b|\b(?:re)?sent\b|\bresend\b/i.test(g)) return '';
  // ...and it may not promise an outcome or a deliverable the team has not decided (paid options, better terms, sending a video, sharing details)
  if (/\b(?:we|i)(?:'ll| will)\s+(?:also |then |gladly |definitely )?(?:look for|check for|find|get you|arrange|offer|try to get|negotiate|make it|increase|match|waive|discount|share|send|provide|forward you|set up|book|schedule|get back with|get back to you with|touch base)\b/i.test(g)) return '';
  if (/\b(?:have|get|ask) the team (?:to )?(?:resend|send|share|provide|arrange|set up|schedule|book|offer|look for|find)\b/i.test(g)) return '';
  if (/\b(?:we|i) can (?:set up|arrange|schedule|book|organi[sz]e|do)\b|\bworks? for (?:us|me|the team)\b|get back to you (?:after|by|before|on|once)\b|after the \d+(?:st|nd|rd|th)\b|keep you in mind|(?:consider|take) (?:it|that|this) (?:when|into)|when matching you|for paid collaborations only|(?:we|i)(?:'ll| will) get (?!back\b|in touch\b)(?:the|that|this|your|you|it|them)\b/i.test(g)) return '';
  if (/\bpaid (?:opportunit|collaboration option|option|slots?|campaigns?)|\bpayout\b/i.test(g) && !/\?/.test(g)) return '';
  if (/(^|\n)\s*[•*\-]\s|\n\s*\d+[.)]\s/.test(t) || /•/.test(t)) return ''; // no bullet points or numbered lists
  // They are writing to us on Instagram, so their profile is already known: never ask for it.
  if (/\b(?:insta(?:gram)?\s+)?(?:handle|username|user name|profile link|profile id)\b/i.test(g) && /\?|\b(?:share|send|drop|give|tell|provide)\b/i.test(g)) return '';
  // Never settle a call or meeting itself: a day or time may only be mentioned as something the team will confirm.
  const slot = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|tonight|\d{1,2}\s?(?:am|pm)|\d{1,2}:\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i.test(g);
  if (slot && !/\b(confirm|check with|check if|check whether|let you know|whether|if that works)\b/i.test(g)) return '';
  // never ask for the same thing again when the customer did not give it: the same ask in either of the last two replies
  const topics = { 'instagram handle': /\b(instagram )?(handle|profile link|username)\b/i, email: /\bemail\b/i, 'phone number': /\b(phone|whatsapp|contact) (number|details)|\bwhatsapp\b/i, budget: /\bbudget\b/i, niche: /\bniche\b/i, city: /\bcity\b/i, brand: /\b(your )?brand (name|overview|details)|\bshare (a )?(quick |short )?(brief|overview)\b/i };
  for (const [name, rx] of Object.entries(topics)) {
    if (/\?/.test(g) && (g.match(/[^.!?]*\?/g) || []).some((q) => rx.test(q)) && recent.some((r) => (String(r).match(/[^.!?]*\?/g) || []).some((q) => rx.test(q)))) return '';
  }
  return t;
}

// The playbook and the style examples must never carry money, contact details or people's names: a fee the team once quoted to one creator
// must not become something the assistant can say to another. Applied when they are built AND every time they are loaded.
const MONEY = /(₹|\brs\.?\s*\d|\binr\b|\b\d[\d,.]*\s?(k|lakh|lakhs|lac|cr|crore)\b|\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b|\b(walk ?away|fee|rate|commercials?)\b[^.\n]*\d)/i;
function scrubPlaybook(text) {
  return String(text || '').split('\n').filter((l) => !MONEY.test(l) && !/@|https?:\/\//.test(l)).join('\n').replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim();
}
function scrubStyle(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && !MONEY.test(x) && !/\d/.test(x) && !/@|https?:\/\//.test(x) && !/^(hi|hello|hellos|hey)\b[,!\s]*\w+/i.test(x.trim()) && x.length <= 140).slice(0, 14);
}

class Concierge {
  constructor({ llm, store, log = console }) { this.llm = llm; this.store = store; this.log = log; }

  // The playbook and the style examples are small and shared by every chat; cached for a few minutes.
  async knowledge() {
    if (this._k && Date.now() - this._k.at < 5 * 60000) return this._k.v;
    const [playbook, style] = await Promise.all([this.store.kvGet('playbook', ''), this.store.kvGet('team_style', [])]);
    this._k = { at: Date.now(), v: { playbook: scrubPlaybook(playbook), style: scrubStyle(style) } };
    return this._k.v;
  }

  // The editor: a second pass that reads the whole chat and the draft before anything is sent. Returns { verdict: 'send' | 'fix', issues, reply }.
  // If the editor itself cannot run, the draft (which already passed the code checks) goes out, so a reply is never lost.
  async review({ writerPrompt, settings, lead, rows, tz, now, facts, playbook, draft }) {
    try {
      const system = loadJudge().split('{{BUSINESS}}').join(settings.business.name).split('{{WRITER}}').join(writerPrompt);
      const newest = [...rows].reverse().findIndex((m) => m.direction === 'out');
      const unanswered = (newest === -1 ? rows : rows.slice(rows.length - newest)).filter((m) => m.direction === 'in');
      const user = 'CONVERSATION SO FAR (oldest first):' + String.fromCharCode(10) + transcript(rows, tz, now)
        + String.fromCharCode(10, 10) + 'WHAT WE ALREADY KNOW ABOUT THEM: ' + factsLine(lead)
        + String.fromCharCode(10, 10) + "THE CUSTOMER'S NEW MESSAGE(S): " + unanswered.map((m) => '"' + clip(m.text, 500) + '"').join(' ')
        + String.fromCharCode(10, 10) + 'DRAFT REPLY TO REVIEW: "' + draft + '"';
      const raw = await this.llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature: 0.1, maxTokens: 800, thinking: Number(process.env.JUDGE_THINKING) || 0 });
      const out = typeof raw === 'object' && raw ? raw : extractJson(raw);
      if (!out || !['send', 'fix'].includes(out.verdict)) return { verdict: 'send', skipped: 'unreadable review' };
      return { verdict: out.verdict, issues: clip(out.issues, 200), reply: String(out.reply || '').trim() };
    } catch (e) { return { verdict: 'send', skipped: 'editor unavailable: ' + String(e.message).slice(0, 80) }; }
  }

  // The ONE place the assistant gets a chat's history: look the chat up by its hash key in the archive (a primary-key lookup), then add
  // what has happened since (the live message rows). The same message is never counted twice. Other people's chats are never touched.
  async loadChat({ lead, newRows, accountId }) {
    const igsid = String(lead.chat_id || '').replace(/^ig:/, '');
    const key = accountId && igsid ? chatKey(accountId, igsid) : null;
    const arch = key ? await this.store.archiveGet(key) : null;
    const live = (await this.store.all('SELECT * FROM messages WHERE lead_id=? AND id<? ORDER BY id DESC LIMIT 120', lead.id, newRows.length ? newRows[0].id : 2 ** 53)).reverse();
    const current = live.concat(newRows);
    const liveMids = new Set(current.map((r) => r.ext_id).filter(Boolean));
    const fromArchive = ((arch && arch.msgs) || [])
      .map((m) => ({ direction: m.fromUs ? 'out' : 'in', role: m.fromUs ? 'admin' : 'user', text: m.text, created_at: Number(m.at), ext_id: m.mid, id: 0 }))
      .filter((m) => !liveMids.has(m.ext_id) && !current.some((r) => r.direction === m.direction && r.text === m.text && Math.abs(Number(r.created_at) - m.created_at) < 180000));
    const rows = fromArchive.concat(current).sort((a, b) => Number(a.created_at) - Number(b.created_at) || (a.id || 0) - (b.id || 0));
    return { rows, key, archiveN: arch ? arch.msgs.length : 0, fromArchive: fromArchive.length, liveN: live.length };
  }

  // After a turn the archive is kept complete: the new customer messages and the assistant's own reply are added under the same key.
  async remember({ lead, rows, messageId, accountId }) {
    const igsid = String(lead.chat_id || '').replace(/^ig:/, '');
    if (!accountId || !igsid) return;
    const add = rows.map((r) => ({ mid: r.ext_id || `local:${r.id}`, at: Number(r.created_at), fromUs: false, text: r.text }));
    if (messageId) { const m = await this.store.get('SELECT * FROM messages WHERE id=?', messageId); if (m) add.push({ mid: m.ext_id || `local:${m.id}`, at: Number(m.created_at), fromUs: true, text: m.text }); }
    await this.store.archiveAppend(chatKey(accountId, igsid), add).catch(() => {});
  }

  // rows: every message of the chat in order, the new customer messages last. Returns { action, text, needsTeam, why }.
  async respond({ lead, rows, settings, now = Date.now() }) {
    const tz = settings.business.timezone || 'Asia/Kolkata';
    const { playbook, style } = await this.knowledge();
    const facts = businessFacts(settings);
    const system = systemPrompt({ settings, playbook, style, now }).replace('{FACTS}', facts);
    const newest = [...rows].reverse().findIndex((m) => m.direction === 'out');
    const unanswered = newest === -1 ? rows.filter((m) => m.direction === 'in') : rows.slice(rows.length - newest).filter((m) => m.direction === 'in');
    const user = `CONVERSATION SO FAR (oldest first):\n${transcript(rows, tz, now)}\n\nWHAT WE ALREADY KNOW ABOUT THEM (from our notes): ${factsLine(lead)}\n\nTHE CUSTOMER'S NEW MESSAGE${unanswered.length > 1 ? 'S' : ''} TO DEAL WITH: ${unanswered.map((m) => `"${clip(m.text, 500)}"`).join(' ')}\n\nDecide and answer in the JSON format.`;
    const mineOut = [...rows].reverse().filter((m) => m.direction === 'out' && m.role !== 'admin');
    const previous = (mineOut[0] || {}).text || '';
    const recent = mineOut.slice(0, 2).map((m) => m.text);
    const grounding = [facts, playbook, rows.map((m) => m.text).join('\n'), factsLine(lead), 'budget range: under 5 lakhs, 5 to 10 lakhs, above 10 lakhs'].join('\n');

    let lastWhy = '';
    let feedback = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const fb = feedback ? ' EDITOR FEEDBACK on your previous draft: ' + feedback + ' Rewrite it to fix exactly that.' : '';
      let raw;
      try { raw = await this.llm.complete({
        system: (attempt ? `${system}\n\nYour previous answer was rejected: it was not valid JSON in the format above, or it contained a number, price, date, email address or link that is not in the facts or the conversation, or it was too long (keep it under 300 characters, no bullet points or lists), or it stated a day or time as settled (a call time may only be something the team will confirm). Answer again with ONLY the JSON object, keep the reply short and plain, and never include any email, link or figure unless it appears above.` : system) + fb,
        messages: [{ role: 'user', content: user }],
        json: true, temperature: 0.45, maxTokens: 600,
      }); } catch (e) { lastWhy = `AI error: ${String(e.message).slice(0, 100)}`; break; }
      const out = typeof raw === 'object' && raw ? raw : extractJson(raw);
      if (!out || !['reply', 'silent', 'handoff'].includes(out.action)) { if (process.env.CONCIERGE_DEBUG) console.error('[unreadable] ' + JSON.stringify(typeof raw === 'string' ? raw.slice(0, 1500) : raw)); lastWhy = 'unreadable answer'; continue; }
      const why = clip(out.why, 200);
      const needsTeam = out.needs_team === true || out.action === 'handoff';
      if (out.action === 'silent' || !String(out.reply || '').trim()) return { action: out.action === 'handoff' ? 'handoff' : 'silent', text: '', needsTeam, why };
      const text = checkReply(out.reply, grounding, { previous, recent, contactGrounding: [facts, playbook].join(' ') });
      if (text) {
        const t0 = Date.now();
        const rv = await this.review({ writerPrompt: system, settings, lead, rows, tz, now, facts, playbook, draft: text });
        if (process.env.CONCIERGE_DEBUG) console.error('[judge] ' + rv.verdict + ' ' + (Date.now() - t0) + 'ms issues=' + (rv.issues || '') + (rv.skipped ? ' SKIPPED ' + rv.skipped : ''));
        if (rv.verdict === 'send') return { action: out.action, text, needsTeam, why, judge: { verdict: 'send', ...(rv.skipped ? { skipped: rv.skipped } : {}) } };
        const fixed = rv.reply ? checkReply(rv.reply, grounding, { previous, recent, contactGrounding: [facts, playbook].join(' ') }) : '';
        if (fixed) return { action: out.action, text: fixed, needsTeam: true, why, judge: { verdict: 'fixed', issues: rv.issues, original: text } };
        if (process.env.CONCIERGE_DEBUG) console.error('[editor] draft=' + JSON.stringify(text) + ' issues=' + rv.issues + ' fix=' + JSON.stringify(rv.reply) + ' fixPassed=' + !!fixed);
        feedback = rv.issues || 'the draft broke the editor checks';
        lastWhy = 'editor rejected: ' + feedback;
        continue;
      }
      if (process.env.CONCIERGE_DEBUG) console.error('[checks] rejected ' + JSON.stringify(out.reply));
      lastWhy = `reply rejected: ${clip(out.reply, 80)}`;
    }
    // Never send something we do not trust: a person gets the chat instead. If the customer wrote something real, they also get a
    // short holding line (never silence), chosen so it differs from the last thing we said.
    if (process.env.CONCIERGE_DEBUG) console.error('[fallback] ' + lastWhy);
    const lastIn = [...rows].reverse().find((m) => m.direction === 'in');
    const substantive = lastIn && (String(lastIn.text).trim().split(/\s+/).length > 2 || lastIn.text.includes('?'));
    const holding = ['Thanks, noted. I have flagged this for the team.', 'Got it, thank you. The team will take it from here.', 'Noted, I will make sure the team sees this.'].find((h) => !recent.includes(h) && h !== previous) || '';
    return { action: 'handoff', text: substantive ? holding : '', needsTeam: true, why: lastWhy || 'could not write a safe reply', failed: true, held: !!(substantive && holding) };
  }
}

module.exports = { Concierge, transcript, checkReply, systemPrompt, scrubPlaybook, scrubStyle };
