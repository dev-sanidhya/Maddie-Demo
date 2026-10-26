'use strict';
// Last line of defence between the model's draft and the customer. Prompts ask
// nicely; this enforces: no re-asking for known facts, at most one question, no
// em dashes, no leaked instructions, bounded length. An empty return means "use
// the deterministic fallback".

const DASHES = /\s*[‒–—―]\s*/g;
const LEAK = /(system prompt|my instructions|directive|mandatory|as an ai language model|<\/?json>|stage_reason|internal categor)/i;

const ASKS = {
  name: /\b(your name|may i (?:get|have|know) your name|what'?s your name|who am i (?:speaking|talking) (?:with|to))\b/i,
  contact: /\b(phone( number)?|contact (number|info)|email( address)?|whatsapp number|reach you)\b/i,
  city: /\b(which (city|area|location)|what (city|area|location)|where (is|are) (the|your) (project|property|home|site|space)|location of)\b/i,
  budget: /\b(budget|how much (are you|do you)|spend)\b/i,
  timeline: /\b(when (are|do|would) you|timeline|how soon|move[- ]in|start date)\b/i,
  project_type: /\b(what (kind|type) of (space|project)|which (space|room|type)|type of (space|project))\b/i,
};

function splitSentences(text) {
  // a full stop between two digits (6.5 lakh, 4.5 weeks) is a decimal point, not the end of a sentence
  return String(text).match(/(?:[^.!?\n]|(?<=\d)\.(?=\d))+[.!?]*(?:\s+|$)|\n+/g)?.map((s) => s.trim()).filter(Boolean) || [];
}

function isQuestion(s) { return /\?\s*$/.test(s) || /\b(please (share|tell|let me know)|could you (share|tell)|can you (share|tell))\b/i.test(s); }

function reasksKnown(sentence, lead) {
  if (!isQuestion(sentence)) return false;
  if (lead.name && ASKS.name.test(sentence)) return true;
  if ((lead.phone || lead.email) && ASKS.contact.test(sentence) && !/\b(best time|good time|call you)\b/i.test(sentence)) return true;
  if (lead.city && ASKS.city.test(sentence)) return true;
  if (lead.budget_amount != null && ASKS.budget.test(sentence)) return true;
  if (lead.timeline_months != null && ASKS.timeline.test(sentence)) return true;
  if (lead.project_type && ASKS.project_type.test(sentence)) return true;
  return false;
}

// Claims a model likes to invent: money, counts of clients/years/awards. A sentence making one is
// only kept when the same number is written in the business facts or the customer's own details.
const NUM = '(\\d[\\d,.]*)';
const CLAIMS = [
  new RegExp(`(?:₹|rs\\.?\\s?|inr\\s?|\\$|usd\\s?)${NUM}`, 'i'),
  new RegExp(`${NUM}\\s?(?:lakhs?|crores?|cr|k)\\b`, 'i'),
  new RegExp(`${NUM}\\+?\\s+(?:years?|yrs|brands?|clients?|campaigns?|awards?|creators?|influencers?|projects?|cities|countries|team members|followers|customers)`, 'i'),
];
const WORD_CLAIM = /\b(hundreds?|thousands?|dozens?|millions?)\s+of\s+(?:brands|clients|campaigns|creators|influencers|projects|customers)\b/i;
const normNum = (d) => d.replace(/[,.]+$/, '').replace(/,/g, '');
function digitsOf(text) { return new Set((String(text).match(/\d[\d,.]*/g) || []).map(normNum)); }
function ungrounded(sentence, grounding) {
  if (grounding === undefined || grounding === null) return false;
  const known = digitsOf(grounding);
  for (const rx of CLAIMS) {
    const m = sentence.match(rx);
    if (m && !known.has(normNum(m[1]))) return true;
  }
  const w = sentence.match(WORD_CLAIM);
  return !!(w && !new RegExp(w[1], 'i').test(grounding));
}

// ---- emojis ----
// 'light' mode: only these, at most two a message and never two in one sentence, never the one used
// in the previous message, and none at all in replies that turn someone down.
const EMOJI_RX = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;
const DEFAULT_EMOJIS = ['✨', '🏡', '🛋️', '📐', '🎨', '🌿', '🙌', '😊', '🤍'];
const baseEmoji = (e) => e.replace(/️/g, '');
const emojisIn = (text) => (String(text).match(EMOJI_RX) || []);

function tidyEmojis(text, { allowed = DEFAULT_EMOJIS, previous = '', max = 2, none = false } = {}) {
  const ok = new Set(allowed.map(baseEmoji));
  const lastUsed = new Set(emojisIn(previous).map(baseEmoji));
  if (lastUsed.size) none = true; // an emoji in every message reads as a template: after one that had one, the next goes plain
  let kept = 0;
  const usedHere = new Set();
  const perSentence = String(text).split(/(?<=[.!?])\s+/).map((sentence) => {
    let inSentence = 0;
    return sentence.replace(EMOJI_RX, (e) => {
      const b = baseEmoji(e);
      if (none || !ok.has(b) || lastUsed.has(b) || usedHere.has(b) || kept >= max || inSentence >= 1) return '';
      kept++; inSentence++; usedHere.add(b);
      return e;
    });
  });
  return perSentence.join(' ').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').replace(/\s+$/g, '').trim();
}

// ---- stock chatbot phrasing ----
const FILLER_OPENER = /^\s*(?:absolutely|certainly|of course|definitely|sure thing|sure|great question|good question|great choice|wonderful|fantastic|awesome|no problem at all)\s*[!,.:-]+\s*/i;
const STOCK = /(i hope (this|you)|hope this message finds|don'?t hesitate|do not hesitate|delve|tapestry|elevate your|game[- ]changer|unlock (the|your)|seamless(ly)?|cutting[- ]edge|state[- ]of[- ]the[- ]art|i'?m here to help|happy to assist|i'?d be (happy|glad|delighted) to (help|assist)|rest assured|world[- ]class|bespoke journey|as an ai|cozy and inviting|warm and inviting|beautiful and functional|beautiful (and|,) (functional|practical)|can already imagine|imagine the possibilities|a lot of options for creating|perfect (fit|blend)|sounds (like )?(a )?(great|wonderful|amazing|fantastic|lovely) (space|home|project|idea|choice|plan))/i;

const RESTATES = /^(so,? )?(you(?:'re| are| have|'ve| mentioned| said| want| need| would like| plan| told)\b|having\b|with (?:a|an|your) (?:budget|timeline|launch)\b|your (?:budget|timeline|launch|goal)s? (?:is|are|of)\b|a (?:budget|timeline) of\b|it sounds like you\b|i (?:see|understand|hear|noticed) (?:that )?you\b|(?:we|i)(?:'ve| have) noted (?:that )?you(?:r|'re)?\b)/i;
// Things the business never says: soft promises about what it can deliver, and judging whether a timeline is workable.
const SOFT_PROMISE = /\b(?:we|i)(?:'ll| will| can)? definitely\b|\bdefinitely (?:make|work|do|deliver|get|handle)\b|\b(?:a |that is a |that's a |it is a |it's a )?tight (?:but |timeline|deadline|turnaround|schedule)|\bmake that happen\b|\bwork with that\b|\b(?:good|great|nice) challenge\b|\b(?:manageable|doable|feasible|achievable)\b|\b(?:don'?t|do not|never|not) (?:usually |typically |generally )?(?:offer|give|provide) (?:any )?discounts?\b|\bno discounts?\b|\b(?:we(?:'ve| have)|you(?:'d| had| have)|i(?:'ve| have)) (?:already )?(?:discussed|mentioned|covered|talked about)\b[^.?!]*\bearlier\b/i;
// "What do you sell, and who is your audience?" is two questions: keep the first.
function singleQuestion(s) {
  if (!/\?\s*$/.test(s)) return s;
  const m = s.match(/^(.*?),? (?:and|or|plus) (?=(?:what|how|who|which|where|when|why|do you|are you|is there|would you|could you|can you|have you|did you)\b)/i);
  return m && m[1].length > 15 ? `${m[1]}?` : s;
}
function polish(text) {
  let t = String(text).replace(FILLER_OPENER, '');
  const kept = splitSentences(t).filter((s) => !STOCK.test(s));
  t = kept.join(' ').trim();
  // at most one exclamation mark: the rest become full stops
  let bangs = 0;
  t = t.replace(/!+/g, (m) => (++bangs > 1 ? '.' : '!'));
  if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

// opts.maxQuestions: 1 for qualification turns, 0 for closings. opts.grounding: the text of facts a reply may rely on.

function sanitizeReply(text, lead, { maxQuestions = 1, maxChars = 650, grounding, emojis = 'off', emojiSet, polish: tone = false, previous = '', declining = false } = {}) {
  if (!text) return '';
  let t = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/,?\s*(?:…|\.\.\.)\s*([)\]])/g, '$1')
    .replace(DASHES, ', ')
    .replace(/\*\*|__|`/g, '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/,\s*,/g, ',')
    .replace(/\s+,/g, ',')
    .replace(/,\s*([)\].!?])/g, '$1')
    .replace(/\(\s*,\s*/g, '(')
    .replace(/[ \t]{2,}/g, ' ');
  if (LEAK.test(t)) return '';
  const kept = [];
  let questions = 0;
  for (const s of splitSentences(t)) {
    if (reasksKnown(s, lead)) continue;
    if (tone && SOFT_PROMISE.test(s)) continue;
    if (ungrounded(s, grounding)) continue;
    if (isQuestion(s)) {
      if (questions >= maxQuestions) continue;
      questions++;
    }
    kept.push(tone && isQuestion(s) ? singleQuestion(s) : s);
  }
  // Replies that open by repeating what the customer just said ("You're looking to launch next week, ...") read as
  // repetitive: when something else follows, that first sentence goes.
  if (tone && kept.length >= 2 && RESTATES.test(kept[0])) kept.shift();
  let out = kept.join(' ').replace(/\s+\n/g, '\n').trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const last = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    out = last > 120 ? cut.slice(0, last + 1) : cut;
  }
  out = out.trim();
  if (tone) out = polish(out);
  if (emojis === 'light') out = tidyEmojis(out, { previous, none: declining, ...(emojiSet ? { allowed: emojiSet } : {}) });
  return out;
}

module.exports = { sanitizeReply, reasksKnown, ungrounded, tidyEmojis, polish, emojisIn, DEFAULT_EMOJIS };
