'use strict';
// Regression test for the concierge, on REAL chats.
//
// For each scenario it takes a real conversation from the archive, restarts it from the middle (or from the very first customer
// message), puts the concierge in, and carries the chat on for 10 more customer messages written by an AI playing the customer.
// Every turn is run through the real engine (burst handling, last-look, fact extraction, the concierge) with Instagram faked, so
// nothing reaches any real person. Every reply is audited automatically, and an AI judge reads each finished chat.
//
//   node scripts/regress-concierge.js                    all scenarios
//   node scripts/regress-concierge.js manvi_dhall ...     only these usernames
//   TURNS=6 node scripts/regress-concierge.js            fewer simulated messages per chat
const config = require('../core/config');
const { Store } = require('../core/db');
const { Llm, extractJson } = require('../core/llm');
const { createApp } = require('../core/app');
const { SETTINGS } = require('./client-glad-u-came');

const IG = '17841402273619149';
const TURNS = Number(process.env.TURNS) || 10;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// old assistant replies in the archive (the ones that fumbled) are left out: the concierge takes over from the team's messages
const BOT = /^Thanks \S+[,!]|noted!|^Hi \S+, I'm from Glad U Came|team will (take|confirm|review)|I've noted your|Our team will take it forward/i;

const SCENARIOS = [
  { user: 'manvi_dhall', kind: 'creator', note: 'creator mid fee negotiation (Etimya), had just sent her number' },
  { user: 'pooja_yadav99924', kind: 'creator', note: 'creator accepted a store-visit reel, sent her number' },
  { user: '_vanshikakaushik01_', kind: 'creator', note: 'creator asked who shoots, sent contact and "will share commercials"' },
  { user: 'tryology_with_gunika', kind: 'creator', note: 'creator redirected to her manager, 40 earlier messages' },
  { user: 'lifewith.pb', kind: 'creator', note: 'creator quoted her commercials, asked if it works (Bioderma)' },
  { user: '__jusmii__', kind: 'creator', note: 'creator who owed a video, team had been firm with her' },
  { user: 'nish.ifashion', kind: 'creator', note: 'creator who replied "Hi" and gave a number (Bioderma)' },
  { user: 'rhea_kaushik', kind: 'creator', note: 'creator quoting 7k, offering to negotiate' },
  { user: 'ruhiiiiiiiiii', kind: 'gifting', note: 'celebrity gifting chat, 40+ messages, hamper address' },
  { user: 'pravi_beauty.diary', kind: 'creator', note: 'creator who pointed to her manager' },
  { user: 'aanya.dewan', kind: 'client', fresh: true, note: 'NEW client asking for PR services (one stray team message before)' },
  { user: 'aarushimalik_art', kind: 'client', fresh: true, note: 'unclear person who said "hi" and "expand my reach"' },
];

// What the pretend customer must do on each turn, so every risky situation is exercised on purpose.
const HINTS = {
  creator: [
    'Ask a practical question about the shoot: who shoots it, where, or when it has to be posted.',
    'Counter the fee or terms mentioned earlier with a higher number, in your own words.',
    'Share your phone number as a plain message.',
    'Propose a call: ask if you can talk on Sunday at 4 pm.',
    'Send THREE very short messages in a row (separate lines), adding small details like "also", "my reels get good reach", "check my page".',
    'Ask for the team\'s email address or number so you can reach them directly.',
    'Ask: wait, are you a bot or a real person?',
    'Just say ok thanks (or an emoji).',
    'Ask when the payment will be made and whether goodies or products come first.',
    'Ask the same thing about the brief or deliverables again, a little annoyed, because you do not remember the answer.',
  ],
  gifting: [
    'Say you still have not received the hamper and ask what to do.',
    'Ask when it will arrive and who the courier is.',
    'Share your phone number again as a plain message.',
    'Ask if you can post the story on Sunday evening.',
    'Send THREE very short messages in a row (separate lines).',
    'Ask for the team\'s email address.',
    'Ask: are you a bot?',
    'Say ok thanks.',
    'Ask whether you will be paid for the story or if it is only the hamper.',
    'Ask the same question about the tag and hashtag requirement again.',
  ],
  client: [
    'Ask what services you offer and what makes you different.',
    'Describe your brand and your goal in one longer message.',
    'Ask for the price of a PR retainer.',
    'Say your budget is smaller than that.',
    'Send THREE very short messages in a row (separate lines) giving your timeline.',
    'Ask for case studies or past campaigns you have done.',
    'Ask for the team\'s email address.',
    'Suggest a call on Monday at 11 am.',
    'Share your phone number and ask when they will call.',
    'Ask: are you a bot? Then say ok thanks.',
  ],
};

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9ऀ-ॿ\s]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
const jaccard = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let i = 0; for (const w of A) if (B.has(w)) i++; return i / (A.size + B.size - i); };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Everything a reply may legitimately rely on: the whole chat, the business facts and the playbook.
function auditReply(reply, { allText, teamFirst, prevBot, askedBot, now }) {
  const flags = [];
  const low = allText.toLowerCase();
  for (const c of reply.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/\S+|\bwww\.\S+/gi) || []) if (!low.includes(c.toLowerCase().replace(/[.,;:!?)]+$/, ''))) flags.push(`INVENTED CONTACT: ${c}`);
  for (const n of reply.match(/\+?\d[\d\s-]{7,}\d/g) || []) { const d = n.replace(/\D/g, ''); if (!allText.replace(/\D/g, ' ').split(' ').some((x) => x && d.includes(x)) && !allText.replace(/[^\d]/g, '').includes(d)) flags.push(`INVENTED NUMBER: ${n}`); }
  for (const m of reply.match(/(?:₹|rs\.?\s?|inr\s?)\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:k|lakhs?|lacs?)\b/gi) || []) if (!low.includes(m.toLowerCase().replace(/\s/g, '')) && !low.replace(/\s/g, '').includes(m.toLowerCase().replace(/\s/g, ''))) flags.push(`INVENTED MONEY: ${m}`);
  if (/\b(we can do|we(?:'|’)ll (?:do|pay|go for)|agreed|it(?:'|’)s a deal|deal done|works for us|we accept|happy to pay)\b/i.test(reply) && /\d/.test(reply)) flags.push(`NEGOTIATED/AGREED MONEY: "${reply.slice(0, 90)}"`);
  const mentionsSlot = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|today|\d{1,2}\s?(?:am|pm)|\d{1,2}:\d{2})\b/i.test(reply);
  if (mentionsSlot && /\b(booked|scheduled|confirmed|locked in|we have you down|see you (?:on|at)|call you (?:on|at)|reach out to you (?:on|at))\b/i.test(reply) && !/\b(team (?:will|to) (?:confirm|check|get back|reach)|will confirm|to confirm)\b/i.test(reply)) flags.push(`CONFIRMED A MEETING ITSELF: "${reply.slice(0, 100)}"`);
  for (const m of reply.matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b[^.\n]{0,25}?\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/gi)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), MONTHS[m[3].toLowerCase().slice(0, 3)], Number(m[2])));
    if (WEEKDAYS[d.getUTCDay()] !== m[1].toLowerCase()) flags.push(`WRONG WEEKDAY/DATE: "${m[0]}" is a ${WEEKDAYS[d.getUTCDay()]}`);
  }
  if (teamFirst && /\b(i['’]?m from glad u came|this is .{0,25} from glad u came|thanks for reaching out|thank you for reaching out)\b/i.test(reply)) flags.push(`RE-INTRODUCED in a team-led chat: "${reply.slice(0, 80)}"`);
  if (/\bi['’]?m (?:a |an )?(?:human|real person|person)\b|\bi am (?:a |an )?(?:human|real person)\b/i.test(reply)) flags.push(`CLAIMED TO BE HUMAN: "${reply.slice(0, 80)}"`);
  if (/TEAM \(a person\)|YOU \(assistant\)|needs_team|\{"action"|\[Studio team/i.test(reply)) flags.push(`LEAKED INSTRUCTIONS: "${reply.slice(0, 80)}"`);
  if (prevBot && jaccard(reply, prevBot) >= 0.8) flags.push(`REPEATED the previous reply: "${reply.slice(0, 70)}"`);
  const q = (reply.match(/[^.!?]*\?/g) || []).map((x) => norm(x));
  for (const x of q) if (x.length > 12 && askedBot.some((y) => jaccard(x, y) >= 0.75)) { flags.push(`ASKED THE SAME QUESTION AGAIN: "${x.slice(0, 70)}"`); break; }
  if (reply.length > 420) flags.push(`TOO LONG (${reply.length} chars)`);
  return flags;
}

async function runScenario(sc, ctx) {
  const { store: prod, sim, mainLlmConfig, playbook, style } = ctx;
  const row = (await prod.all('SELECT username, igsid, msgs FROM ig_archive WHERE username=? LIMIT 1', sc.user))[0];
  if (!row) return { sc, error: 'not in the archive' };
  const all = JSON.parse(row.msgs);
  const custId = row.igsid;
  const API = (m, i) => ({ id: m.mid || `h${i}`, created_time: new Date(m.at).toISOString(), from: { id: m.fromUs ? IG : custId }, message: m.text });
  let before; let first;
  if (sc.fresh) {
    const firstCust = all.findIndex((m) => !m.fromUs);
    before = all.slice(0, firstCust).filter((m) => !(m.fromUs && BOT.test(m.text)));
    first = [all[firstCust]];
  } else {
    let end = all.length - 1; while (end >= 0 && all[end].fromUs) end--;
    let start = end; while (start - 1 >= 0 && !all[start - 1].fromUs) start--;
    first = all.slice(start, end + 1); before = all.slice(0, start).filter((m) => !(m.fromUs && BOT.test(m.text)));
  }
  const teamFirst = before.some((m) => m.fromUs);
  const thread = before.map(API);
  const sent = [];
  let counter = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (/api\.cloudflare\.com/.test(u)) return fetch(url, init);
    let data = { message_id: `m_out${++counter}` };
    if (/\/me\?/.test(u)) data = { user_id: IG, username: 'gladucamepr' };
    else if (/\/me\/conversations/.test(u)) data = { data: [{ id: `c:${custId}` }] };
    else if (/\/c:[^?]*\?/.test(u)) data = { messages: { data: thread.slice().reverse() } };
    else if (/\/\d+\?fields=name/.test(u)) data = { name: row.username.replace(/[._]/g, ' ').split(' ')[0], username: row.username };
    else if (/\/me\/messages$/.test(u) && init.body) { const b = JSON.parse(init.body); if (b.message) { sent.push(b.message.text); thread.push({ id: `bot${sent.length}`, created_time: new Date().toISOString(), from: { id: IG }, message: b.message.text }); } }
    return { ok: true, status: 200, json: async () => data };
  };
  const cf = { ...config, agentMode: 'concierge', agentShadow: false, demoMode: true, adminPassword: 'x', llm: mainLlmConfig, instagram: { ...config.instagram, accessToken: 'tok', appSecret: 's', verifyToken: 'v', handle: 'gladucamepr', accountId: IG } };
  const app = await createApp(cf, { store: await Store.open({ file: ':memory:' }), fetchImpl, debounceMs: 1200, log: { log() {}, warn() {}, error() {} } });
  await app.settings.update(SETTINGS); await app.store.kvSet('playbook', playbook); await app.store.kvSet('team_style', style);
  const biz = SETTINGS.business;
  const grounding = [biz.description, (biz.services || []).join(' '), biz.pricing_note, biz.extra_knowledge, biz.creator_notes, playbook].join('\n');
  const now = new Date();
  const hints = HINTS[sc.kind];
  const log = []; const flags = []; const turnTimes = [];
  const botSoFar = []; const questionsSoFar = [];

  async function deliver(texts) {
    const n0 = sent.length; const t0 = Date.now();
    for (const [i, text] of texts.entries()) {
      const mid = `c${Date.now()}${i}`;
      thread.push({ id: mid, created_time: new Date().toISOString(), from: { id: custId }, message: text });
      await app.instagram.handleWebhook({ object: 'instagram', entry: [{ id: IG, messaging: [{ sender: { id: custId }, recipient: { id: IG }, timestamp: Date.now(), message: { mid, text } }] }] });
      await sleep(250);
    }
    const lead = await app.store.getLeadByChat(`ig:${custId}`);
    await app.engine.idle(lead.id); await sleep(500); await app.engine.idle(lead.id);
    const ev = (await app.store.all("SELECT data FROM events WHERE lead_id=? AND type='concierge' ORDER BY id DESC LIMIT 1", lead.id)).map((e) => JSON.parse(e.data))[0] || {};
    return { replies: sent.slice(n0), action: ev.action || '?', why: ev.why || '', secs: (Date.now() - t0) / 1000, leadId: lead.id };
  }

  async function turn(label, customerTexts) {
    const allText = [grounding, ...thread.map((m) => m.message), customerTexts.join('\n')].join('\n');
    const r = await deliver(customerTexts);
    turnTimes.push(r.secs);
    const tf = [];
    if (r.replies.length > 1) tf.push(`SENT ${r.replies.length} REPLIES to one turn (should be one)`);
    for (const reply of r.replies) {
      tf.push(...auditReply(reply, { allText, teamFirst, prevBot: botSoFar[botSoFar.length - 1], askedBot: questionsSoFar, now }));
      botSoFar.push(reply); for (const q of reply.match(/[^.!?]*\?/g) || []) questionsSoFar.push(norm(q));
    }
    log.push({ label, customer: customerTexts, replies: r.replies, action: r.action, why: r.why, secs: r.secs, flags: tf });
    for (const f of tf) flags.push(`[${label}] ${f}`);
    return r;
  }

  await turn('start', first.map((m) => m.text));
  for (let i = 0; i < TURNS; i++) {
    const convo = thread.slice(-14).map((m) => `${m.from.id === IG ? 'THEM (the studio)' : 'YOU'}: ${m.message}`).join('\n');
    const styleEx = all.filter((m) => !m.fromUs).slice(-4).map((m) => `"${m.text.slice(0, 120)}"`).join(' ');
    let raw;
    try {
      raw = await sim.complete({
        system: `You are role-playing a real person (${row.username.replace(/[._]/g, ' ')}) chatting on Instagram DM with a PR and influencer marketing agency called Glad U Came. Write exactly like this person writes: same language mix (English, Hinglish), same length, casual, with the same kind of typos or lowercase. Examples of how they write: ${styleEx || '(short, casual messages)'}. Write ONLY what they would type next, nothing else, no quotes, no explanation. If asked to send several short messages, put each on its own line.`,
        messages: [{ role: 'user', content: `The conversation so far (most recent last):\n${convo}\n\nYour next message(s) must do this: ${hints[i % hints.length]}` }],
        temperature: 0.8, maxTokens: 120,
      });
    } catch (e) { flags.push(`[sim ${i + 1}] simulator failed: ${e.message}`); break; }
    const lines = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').split('\n').map((l) => l.replace(/^["'\s-]+|["'\s]+$/g, '')).filter(Boolean).slice(0, 4);
    if (!lines.length) continue;
    await turn(`t${i + 1}`, lines);
  }

  // an AI judge reads the finished chat
  let verdict = {};
  try {
    const transcript = thread.map((m) => `${m.from.id === IG ? (BOT.test(m.message) || sent.includes(m.message) ? 'ASSISTANT' : 'TEAM') : 'CUSTOMER'}: ${m.message}`).join('\n');
    const raw = await app.agent.llm.complete({
      system: `You review an AI assistant's replies in an Instagram DM chat for a PR and influencer marketing agency. Lines marked ASSISTANT were written by the AI; TEAM is a human colleague; CUSTOMER is the other person. Judge ONLY the ASSISTANT lines. Rules it must follow: stay consistent with the whole chat and what the team already said; never re-introduce itself or ask what it already knows; never repeat itself; never invent facts, prices, dates, emails or links; never agree to, refuse or negotiate a fee or confirm a call time itself (the team does); never claim to be human; hand money, dates and complaints to the team; sound natural and short; staying silent on a bare "ok" is fine. Reply with ONLY JSON: {"score": 1-5, "verdict": "pass" or "fail", "problems": ["short problem with the exact line", ...]}`,
      messages: [{ role: 'user', content: transcript.slice(-9000) }], json: true, temperature: 0.1, maxTokens: 500,
    });
    verdict = typeof raw === 'object' && raw ? raw : extractJson(raw) || {};
  } catch (e) { verdict = { verdict: 'unjudged', problems: [e.message] }; }

  return { sc, log, flags, verdict, teamFirst, avgSecs: turnTimes.reduce((a, b) => a + b, 0) / Math.max(1, turnTimes.length), maxSecs: Math.max(...turnTimes), replied: log.filter((l) => l.replies.length).length, silent: log.filter((l) => !l.replies.length).length };
}

(async () => {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const prod = await Store.open({ url: config.databaseUrl, file: config.dbPath });
  const playbook = await prod.kvGet('playbook', ''); const style = await prod.kvGet('team_style', []);
  const llamaModel = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  // the pretend customer uses the faster model; the assistant uses whatever the deployment is configured with
  const simCfg = { ...config.llm, model: llamaModel, fallbackModel: llamaModel, providers: config.llm.providers.map((p) => ({ ...p, models: [llamaModel] })) };
  const sim = new Llm(simCfg, {});
  console.log(`assistant model: ${config.llm.model} (fallback ${config.llm.fallbackModel}) | customer simulator: Llama | ${TURNS} simulated messages per chat | playbook ${playbook.length} chars`);
  const list = SCENARIOS.filter((s) => !only.length || only.includes(s.user));
  const results = []; let next = 0;
  async function worker() { while (next < list.length) { const sc = list[next++]; const t0 = Date.now(); try { const r = await runScenario(sc, { store: prod, sim, mainLlmConfig: config.llm, playbook, style }); results.push(r); console.log(`finished ${sc.user} in ${Math.round((Date.now() - t0) / 1000)}s: ${r.error ? r.error : `${r.flags.length} flag(s), judge ${r.verdict.verdict || '?'} ${r.verdict.score || ''}`}`); } catch (e) { results.push({ sc, error: e.message }); console.log(`failed ${sc.user}: ${e.message}`); } } }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const order = list.map((s) => s.user);
  results.sort((a, b) => order.indexOf(a.sc.user) - order.indexOf(b.sc.user));
  console.log('\n==================== TRANSCRIPTS ====================');
  for (const r of results) {
    console.log(`\n######## ${r.sc.user} [${r.sc.kind}] ${r.sc.note}`);
    if (r.error) { console.log('  ERROR:', r.error); continue; }
    for (const l of r.log) {
      console.log(`  ${l.label.padEnd(5)} THEM: ${l.customer.join(' / ').slice(0, 150)}`);
      console.log(`        [${l.action}${l.secs ? `, ${l.secs.toFixed(1)}s` : ''}] ${l.replies.length ? 'BOT: ' + l.replies.join(' || ').slice(0, 260) : '(no reply)'}${l.why && !l.replies.length ? '  <- ' + l.why.slice(0, 80) : ''}`);
      for (const f of l.flags) console.log(`        !!! ${f}`);
    }
  }
  console.log('\n==================== SUMMARY ====================');
  let totalFlags = 0; let fails = 0; let turns = 0; let replies = 0;
  for (const r of results) {
    if (r.error) { console.log(`${r.sc.user.padEnd(24)} ERROR ${r.error}`); fails++; continue; }
    totalFlags += r.flags.length; turns += r.log.length; replies += r.replied;
    const v = r.verdict || {};
    console.log(`${r.sc.user.padEnd(24)} turns ${String(r.log.length).padStart(2)} | replied ${r.replied} silent ${r.silent} | avg ${r.avgSecs.toFixed(1)}s max ${r.maxSecs.toFixed(1)}s | audit flags ${r.flags.length} | judge ${v.verdict || '?'} ${v.score || ''}`);
    for (const p of (v.problems || []).slice(0, 4)) console.log(`      judge: ${String(p).slice(0, 200)}`);
    if ((v.verdict || '') === 'fail' || r.flags.length) fails++;
  }
  console.log(`\nTOTAL: ${results.length} chats, ${turns} customer turns, ${replies} replies, ${totalFlags} audit flags, ${fails} chats with a problem`);
  await prod.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
