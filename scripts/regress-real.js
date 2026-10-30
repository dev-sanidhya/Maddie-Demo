'use strict';
// Replays REAL conversations through the concierge, using ONLY what the real customers actually wrote. Nothing is invented.
//
//   node scripts/regress-real.js incidents [usernames...]
//       Recreates the situations where the OLD agent replied in production: same chat context up to the customer message the old
//       agent answered, then every real customer message that followed, in order. Shows the old agent's reply, what the new agent says,
//       and what a person on the team actually answered.
//   node scripts/regress-real.js history [--cut=11] [--n=6] [usernames...]
//       Takes older chats from the archive, gives the AI the first 11 messages as context, then replays the customer's real messages
//       from message 12 on (up to 10 of them), one burst at a time, exactly as written.
//
// Instagram is faked: nothing reaches any real person. Reports are saved in regression-reports/.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../core/config');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { chatKey } = require('../core/chatkey');
const { extractJson } = require('../core/llm');
const { SETTINGS } = require('./client-glad-u-came');

const IG = '17841402273619149';
const CONCURRENCY = Number(process.env.CONCURRENCY) || 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT_LIKE = /^Thanks \S+[,!]|noted!|^Hi \S+, I'm from Glad U Came|team will (take|confirm|review)|I've noted your|Our team will take it forward|welcome to Glad U Came, I'm part of the team/i;
const ATTACH = '[sent a photo or link]';
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9ऀ-ॿ\s]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
const jaccard = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let i = 0; for (const w of A) if (B.has(w)) i++; return i / (A.size + B.size - i); };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// ---------------------------------------------------------------------------------------------------------------- audit
function audit(reply, { allText, teamFirst, prevBot, askedBot, theirText, now }) {
  const flags = [];
  const low = allText.toLowerCase();
  for (const c of reply.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/\S+|\bwww\.\S+/gi) || []) if (!low.includes(c.toLowerCase().replace(/[.,;:!?)]+$/, ''))) flags.push(`INVENTED CONTACT: ${c}`);
  const digitsAll = allText.replace(/\D/g, '');
  for (const n of reply.match(/\+?\d[\d\s-]{7,}\d/g) || []) { const d = n.replace(/\D/g, ''); if (!digitsAll.includes(d)) flags.push(`INVENTED NUMBER: ${n}`); else flags.push(`READ A NUMBER BACK: ${n}`); }
  const money = reply.match(/(?:₹|rs\.?\s?|inr\s?)\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:k|lakhs?|lacs?)\b/gi) || [];
  for (const m of money) {
    const key = m.toLowerCase().replace(/\s/g, '');
    if (!low.replace(/\s/g, '').includes(key)) flags.push(`INVENTED MONEY: ${m}`);
    else if (theirText && theirText.toLowerCase().replace(/\s/g, '').includes(key) && teamFirst) flags.push(`ECHOED THEIR FEE back: ${m}`);
  }
  if (/\b(we can do|we(?:'|’)ll (?:do|pay|go for)|agreed|it(?:'|’)s a deal|deal done|works for us|we accept|happy to pay)\b/i.test(reply) && /\d/.test(reply)) flags.push(`AGREED MONEY: "${reply.slice(0, 90)}"`);
  const slot = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|tonight|\d{1,2}\s?(?:am|pm)|\d{1,2}:\d{2})\b/i.test(reply);
  if (slot && !/\b(confirm|check with|check if|let you know|get back to you|will reach out|whether|if that works)\b/i.test(reply)) flags.push(`SETTLED A CALL TIME: "${reply.slice(0, 100)}"`);
  for (const m of reply.matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b[^.\n]{0,25}?\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/gi)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), MONTHS[m[3].toLowerCase().slice(0, 3)], Number(m[2])));
    if (WEEKDAYS[d.getUTCDay()] !== m[1].toLowerCase()) flags.push(`WRONG WEEKDAY/DATE: "${m[0]}" is a ${WEEKDAYS[d.getUTCDay()]}`);
  }
  if (teamFirst && /\b(i['’]?m from glad u came|welcome to glad u came|thanks for reaching out|thank you for reaching out)\b/i.test(reply)) flags.push(`RE-INTRODUCED in a chat the team started: "${reply.slice(0, 80)}"`);
  if (teamFirst && /\b(what (kind|type) of (service|project)|which (city|area)|what('?s| is) your budget|what budget|when (do you|are you) (want|planning) to start|looking for (pr|public relations))\b/i.test(reply)) flags.push(`CLIENT-STYLE QUESTION to someone the team approached: "${reply.slice(0, 90)}"`);
  if (/\bcannot open attachments\b/i.test(reply)) flags.push('CANNED ATTACHMENT LINE');
  if (/\bi['’]?m (?:a |an )?(?:human|real person|person)\b|\bi am (?:a |an )?(?:human|real person)\b/i.test(reply)) flags.push(`CLAIMED TO BE HUMAN: "${reply.slice(0, 80)}"`);
  if (/TEAM \(a person\)|YOU \(assistant\)|needs_team|\{"action"|\[Studio team/i.test(reply)) flags.push(`LEAKED INSTRUCTIONS: "${reply.slice(0, 80)}"`);
  if (/(^|\s)~(\s|,|!)/.test(reply)) flags.push(`USED "~" AS A NAME: "${reply.slice(0, 60)}"`);
  if (prevBot && jaccard(reply, prevBot) >= 0.75) flags.push(`REPEATED the previous reply: "${reply.slice(0, 70)}"`);
  for (const x of (reply.match(/[^.!?]*\?/g) || []).map(norm)) if (x.length > 12 && askedBot.some((y) => jaccard(x, y) >= 0.75)) { flags.push(`ASKED THE SAME QUESTION AGAIN: "${x.slice(0, 70)}"`); break; }
  if (reply.length > 360) flags.push(`TOO LONG (${reply.length} chars)`);
  if (/(^|\n)\s*[•*\-]\s|•/.test(reply)) flags.push('BULLET POINTS');
  return flags;
}

// -------------------------------------------------------------------------------------------------------- one real chat
// plan: { user, igsid, context: archive msgs given to the AI, bursts: [ { texts:[..], at, teamAfter:[..], old:[..] } ], label }
async function runChat(plan, shared) {
  const { playbook, style } = shared;
  const API = (m, i) => ({ id: m.mid || `h${i}`, created_time: new Date(m.at).toISOString(), from: { id: m.fromUs ? IG : plan.igsid }, message: m.text });
  const thread = plan.context.map(API);
  const sent = []; let counter = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (/api\.cloudflare\.com/.test(u)) return fetch(url, init);
    let data = { message_id: `m_out${++counter}` };
    if (/\/me\?/.test(u)) data = { user_id: IG, username: 'gladucamepr' };
    else if (/\/me\/conversations/.test(u)) data = { data: [{ id: `c:${plan.igsid}` }] };
    else if (/\/c:[^?]*\?/.test(u)) data = { messages: { data: thread.slice().reverse() } };
    else if (/\/\d+\?fields=name/.test(u)) data = { name: plan.name || plan.user.replace(/[._]/g, ' ').split(' ')[0], username: plan.user };
    else if (/\/me\/messages$/.test(u) && init.body) { const b = JSON.parse(init.body); if (b.message) { sent.push(b.message.text); thread.push({ id: `bot${sent.length}`, created_time: new Date().toISOString(), from: { id: IG }, message: b.message.text }); } }
    return { ok: true, status: 200, json: async () => data };
  };
  const cf = { ...config, agentMode: 'concierge', agentShadow: false, demoMode: true, adminPassword: 'x', instagram: { ...config.instagram, accessToken: 'tok', appSecret: 's', verifyToken: 'v', handle: 'gladucamepr', accountId: IG } };
  const app = await createApp(cf, { store: await Store.open({ file: ':memory:' }), fetchImpl, debounceMs: 1200, log: { log() {}, warn() {}, error() {} } });
  await app.settings.update(SETTINGS); await app.store.kvSet('playbook', playbook); await app.store.kvSet('team_style', style);
  // production flow: the chat already sits in the archive under its hash key; the agent looks it up by that key, then adds what is new
  const key = chatKey(IG, plan.igsid);
  if (plan.context.length) await app.store.archiveUpsert({ conv_id: `c:${plan.igsid}`, chat_key: key, igsid: plan.igsid, username: plan.user, last_at: plan.context[plan.context.length - 1].at, msgs: plan.context.map((m, i) => ({ mid: m.mid || `h${i}`, at: m.at, fromUs: m.fromUs, text: m.text })) });
  const biz = SETTINGS.business;
  const grounding = [biz.description, (biz.services || []).join(' '), biz.pricing_note, biz.extra_knowledge, biz.creator_notes, playbook].join('\n');
  const teamFirst = plan.context.some((m) => m.fromUs);
  const now = new Date();
  const rows = []; const flags = []; const botSoFar = []; const asked = [];

  for (const [bi, b] of plan.bursts.entries()) {
    const n0 = sent.length; const t0 = Date.now();
    const allText = [grounding, ...thread.map((m) => m.message), b.texts.join('\n')].join('\n');
    for (const [i, text] of b.texts.entries()) {
      const mid = `r${Date.now()}${bi}${i}`;
      thread.push({ id: mid, created_time: new Date().toISOString(), from: { id: plan.igsid }, message: text });
      const message = text === ATTACH ? { mid, attachments: [{ type: 'video', payload: { url: 'https://cdn.example.com/v.mp4' } }] } : { mid, text };
      await app.instagram.handleWebhook({ object: 'instagram', entry: [{ id: IG, messaging: [{ sender: { id: plan.igsid }, recipient: { id: IG }, timestamp: Date.now(), message }] }] });
      await sleep(250);
    }
    const lead = await app.store.getLeadByChat(`ig:${plan.igsid}`);
    await app.engine.idle(lead.id); await sleep(500); await app.engine.idle(lead.id);
    const ev = (await app.store.all("SELECT data FROM events WHERE lead_id=? AND type='concierge' ORDER BY id DESC LIMIT 1", lead.id)).map((e) => JSON.parse(e.data))[0] || {};
    const replies = sent.slice(n0);
    const f = [];
    if (replies.length > 1) f.push(`SENT ${replies.length} REPLIES to one burst`);
    for (const r of replies) { f.push(...audit(r, { allText, teamFirst, prevBot: botSoFar[botSoFar.length - 1], askedBot: asked, theirText: b.texts.join(' '), now })); botSoFar.push(r); for (const q of r.match(/[^.!?]*\?/g) || []) asked.push(norm(q)); }
    rows.push({ ...b, replies, action: ev.action || '?', why: ev.why || '', secs: (Date.now() - t0) / 1000, flags: f, lookup: ev.chat ? { key: ev.chat, archive: ev.archive_msgs, live: ev.live_msgs, read: ev.read_msgs } : null });
    for (const x of f) flags.push(`[burst ${bi + 1}] ${x}`);
  }

  let verdict = {};
  try {
    const transcript = thread.map((m) => `${m.from.id === IG ? (sent.includes(m.message) ? 'ASSISTANT' : 'TEAM') : 'CUSTOMER'}: ${m.message}`).join('\n');
    const raw = await app.agent.llm.complete({
      system: `You review the ASSISTANT lines (written by an AI) in an Instagram DM chat for a PR and influencer marketing agency. TEAM lines are human colleagues, CUSTOMER is the other person. Judge ONLY the ASSISTANT lines and fail a chat only for a CLEAR violation of these rules: contradicts or ignores what the chat already established; re-introduces itself or asks what it already knows or what a person the team approached would never be asked (what service, which city); repeats itself; invents facts, prices, dates, emails or links; agrees to, refuses or negotiates a creator's fee; settles a call time itself (saying the team will confirm a time is CORRECT); claims to be human. These are all FINE and must not be failed: quoting the agency's own retainer or project prices to a BUSINESS that asked for our services (the approved prices are Rs 1,00,000 per month for PR retainers and Rs 60,000 per project, plus GST); saying the team will confirm or follow up; staying silent on a bare "ok" or "thanks"; short acknowledgements. Reply with ONLY JSON: {"score": 1-5, "verdict": "pass" or "fail", "problems": ["short problem with the exact assistant line"]}`,
      messages: [{ role: 'user', content: transcript.slice(-9000) }], json: true, temperature: 0.1, maxTokens: 450,
    });
    verdict = typeof raw === 'object' && raw ? raw : extractJson(raw) || {};
  } catch (e) { verdict = { verdict: 'unjudged', problems: [e.message] }; }
  return { plan, rows, flags, verdict, teamFirst };
}

// ----------------------------------------------------------------------------------------------------------- planning
const isBurstEnd = (msgs, i) => i === msgs.length - 1 || msgs[i + 1].fromUs;

// customer bursts from index `from` on, each with what a person on the team actually answered next (bot-like lines excluded)
function burstsFrom(msgs, from, limit, oldBot) {
  const out = []; let i = from;
  while (i < msgs.length && out.length < limit) {
    if (msgs[i].fromUs) { i++; continue; }
    // one burst = messages sent in quick succession (a person typing in pieces); a longer pause means a new turn, as it happened
    let j = i; while (j + 1 < msgs.length && !msgs[j + 1].fromUs && msgs[j + 1].at - msgs[j].at <= 20000) j++;
    const k = j + 1; let m = k; const teamAfter = [];
    while (m < msgs.length && msgs[m].fromUs) { if (!BOT_LIKE.test(msgs[m].text)) teamAfter.push(msgs[m].text); m++; }
    const endAt = msgs[j].at;
    out.push({ texts: msgs.slice(i, j + 1).map((x) => x.text), at: endAt, teamAfter: teamAfter.slice(0, 2), old: (oldBot || []).filter((b) => b.at >= endAt - 5000 && b.at <= endAt + 120000).map((b) => b.text) });
    i = j + 1;
  }
  return out;
}

async function planIncidents(prod, only) {
  // every chat in which the OLD agent replied in production
  const leads = await prod.all("SELECT l.id, l.chat_id, l.name FROM leads l WHERE l.chat_id LIKE 'ig:%' AND (EXISTS (SELECT 1 FROM messages m WHERE m.lead_id=l.id AND m.direction='out' AND m.role='assistant') OR l.id BETWEEN 11 AND 16)");
  const plans = [];
  for (const l of leads) {
    const igsid = String(l.chat_id).slice(3);
    const arch = await prod.archiveByIgsid(igsid);
    if (!arch || !arch.msgs.length) continue;
    if (only.length && !only.includes(arch.username)) continue;
    const old = (await prod.all("SELECT text, created_at FROM messages WHERE lead_id=? AND direction='out' AND role='assistant' ORDER BY id", l.id)).map((r) => ({ text: r.text, at: Number(r.created_at) }));
    const oldTexts = new Set(old.map((o) => o.text));
    const msgs = arch.msgs.filter((m) => !(m.fromUs && (oldTexts.has(m.text) || BOT_LIKE.test(m.text)))); // the old agent's own lines are not part of the context
    // the first customer message the old agent answered: the earliest old reply, or the first bot-like line, minus its trigger burst
    const firstOldAt = old.length ? Math.min(...old.map((o) => o.at)) : Infinity;
    const botLikeIdx = arch.msgs.findIndex((m) => m.fromUs && BOT_LIKE.test(m.text));
    const firstBotAt = Math.min(firstOldAt, botLikeIdx >= 0 ? arch.msgs[botLikeIdx].at : Infinity);
    let trig = -1; for (let i = 0; i < msgs.length; i++) if (!msgs[i].fromUs && msgs[i].at <= firstBotAt + 2000) trig = i;
    if (trig < 0) continue;
    let start = trig; while (start - 1 >= 0 && !msgs[start - 1].fromUs) start--;
    const bursts = burstsFrom(msgs, start, 12, old);
    if (!bursts.length) continue;
    plans.push({ user: arch.username, igsid, name: l.name, label: `lead #${l.id}`, context: msgs.slice(0, start), bursts, oldCount: old.length });
  }
  return plans.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

async function planHistory(prod, only, cut, n) {
  let cands;
  if (only.length) cands = (await prod.archiveAll({ minTeam: 1, limit: 5000 })).filter((c) => only.includes(c.username));
  else {
    cands = (await prod.archiveAll({ minTeam: 8, limit: 5000 })).filter((c) => c.n >= 28 && c.n <= 140 && c.last_at < Date.parse('2026-10-27T00:00:00Z'));
    cands = cands.filter((c) => { const after = c.msgs.slice(cut); return after.filter((m) => !m.fromUs).length >= 9 && c.msgs.slice(0, cut).some((m) => m.fromUs) && c.msgs.slice(0, cut).some((m) => !m.fromUs) && !c.msgs.some((m) => BOT_LIKE.test(m.text) && m.fromUs); });
  }
  // diverse picks: different openings, deterministic
  const seen = new Set(); const picks = [];
  for (const c of cands.sort((a, b) => (a.conv_id < b.conv_id ? -1 : 1))) {
    const key = norm((c.msgs.find((m) => m.fromUs) || { text: '' }).text).slice(0, 28);
    if (!only.length && seen.has(key)) continue; seen.add(key); picks.push(c); if (picks.length >= n && !only.length) break;
  }
  return picks.map((c) => {
    const bursts = burstsFrom(c.msgs, cut, 10, []);
    return { user: c.username, igsid: String(c.igsid), name: (c.username || '').replace(/[._]/g, ' ').split(' ')[0], label: `${c.n} msgs, cut at ${cut}`, context: c.msgs.slice(0, cut), bursts };
  }).filter((p) => p.bursts.length);
}

// ------------------------------------------------------------------------------------------------------------- report
function render(results, title) {
  const out = [`# ${title}`, ''];
  let turns = 0, replied = 0, silent = 0, nflags = 0, fails = 0, oldReplies = 0; const slow = [];
  for (const r of results) {
    out.push(`## @${r.plan.user} (${r.plan.label}) ${r.teamFirst ? '[the team spoke first]' : '[the customer spoke first]'}`);
    out.push(`Context given to the AI: ${r.plan.context.length} earlier messages. Last two: ${r.plan.context.slice(-2).map((m) => `${m.fromUs ? 'TEAM' : 'THEM'}: ${m.text.slice(0, 90).replace(/\n/g, ' ')}`).join(' | ') || '(none)'}`);
    for (const [i, b] of r.rows.entries()) {
      turns++; if (b.replies.length) replied++; else silent++;
      out.push(`\n  ${i + 1}. THEM: ${b.texts.join(' / ').slice(0, 220).replace(/\n/g, ' ')}`);
      if (b.old && b.old.length) { oldReplies++; out.push(`     OLD AGENT (what happened in production): ${b.old.join(' || ').slice(0, 260).replace(/\n/g, ' ')}`); }
      if (b.lookup) out.push(`     LOOKUP: chat ${b.lookup.key} -> ${b.lookup.archive} messages in the archive, ${b.lookup.live} live, the AI read ${b.lookup.read}`);
      out.push(`     NEW AGENT [${b.action}, ${b.secs.toFixed(1)}s]: ${b.replies.length ? b.replies.join(' || ').slice(0, 300).replace(/\n/g, ' ') : '(no reply)' + (b.why ? '  <- ' + b.why.slice(0, 90) : '')}`);
      if (b.teamAfter && b.teamAfter.length) out.push(`     TEAM actually answered: ${b.teamAfter.join(' || ').slice(0, 200).replace(/\n/g, ' ')}`);
      for (const f of b.flags) out.push(`     !!! ${f}`);
      if (b.secs > 30) slow.push(`${r.plan.user} burst ${i + 1}: ${b.secs.toFixed(0)}s`);
    }
    nflags += r.flags.length; const v = r.verdict || {};
    out.push(`\n  RESULT: audit flags ${r.flags.length} | judge ${v.verdict || '?'} ${v.score || ''}${(v.problems || []).length ? '\n  judge says: ' + v.problems.slice(0, 3).map((p) => String(p).slice(0, 200)).join(' ;; ') : ''}\n`);
    if (r.flags.length || (v.verdict || '') === 'fail') fails++;
  }
  out.push('---', `TOTAL: ${results.length} chats, ${turns} customer bursts, ${replied} replied, ${silent} silent, ${nflags} audit flags, ${fails} chats with a problem${oldReplies ? `, ${oldReplies} bursts the old agent had answered` : ''}.`);
  if (slow.length) out.push(`Slow (over 30s): ${slow.join('; ')}`);
  return { text: out.join('\n'), turns, replied, silent, nflags, fails };
}

(async () => {
  const [mode, ...rest] = process.argv.slice(2);
  const opt = (n, d) => { const a = rest.find((x) => x.startsWith(`--${n}=`)); return a ? Number(a.split('=')[1]) : d; };
  const only = rest.filter((a) => !a.startsWith('--'));
  if (!['incidents', 'history'].includes(mode)) { console.log('usage: regress-real.js incidents|history [options] [usernames]'); process.exit(1); }
  const prod = await Store.open({ url: config.databaseUrl, file: config.dbPath });
  const shared = { playbook: await prod.kvGet('playbook', ''), style: await prod.kvGet('team_style', []) };
  const plans = mode === 'incidents' ? await planIncidents(prod, only) : await planHistory(prod, only, opt('cut', 11), opt('n', 6));
  console.log(`model: ${config.llm.model} (fallback ${config.llm.fallbackModel}) | ${plans.length} chats | ${plans.reduce((a, p) => a + p.bursts.length, 0)} real customer bursts`);
  for (const p of plans) console.log(`  @${p.user} (${p.label}): ${p.context.length} context msgs, ${p.bursts.length} bursts`);
  const results = []; let next = 0;
  async function worker() { while (next < plans.length) { const p = plans[next++]; const t0 = Date.now(); try { const r = await runChat(p, shared); results.push(r); console.log(`done @${p.user} in ${Math.round((Date.now() - t0) / 1000)}s: ${r.flags.length} flag(s), judge ${r.verdict.verdict || '?'} ${r.verdict.score || ''}`); } catch (e) { console.log(`failed @${p.user}: ${e.stack || e.message}`); } } }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => plans.indexOf(a.plan) - plans.indexOf(b.plan));
  const rep = render(results, mode === 'incidents' ? 'Replay of the real incidents from production (old agent vs new agent)' : `Older real chats, AI from message ${opt('cut', 11) + 1}, real customer messages only`);
  fs.mkdirSync(path.join(__dirname, '..', 'regression-reports'), { recursive: true });
  const file = path.join(__dirname, '..', 'regression-reports', `${mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`);
  fs.writeFileSync(file, rep.text);
  console.log(`\n${rep.text}\n\nSaved: ${file}`);
  await prod.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
