'use strict';
// Learns from the team's OWN messages across every archived conversation and writes two things the assistant reads before replying:
//   playbook    : what campaigns and offers the team runs, how it answers common questions, and its process
//   team_style  : a few real short messages, so replies sound like the team
// The assistant's own past messages are left out, and so are fee amounts and phone numbers.
//   node scripts/build-playbook.js            (uses the AI: a couple of calls)
const config = require('../core/config');
const { Store } = require('../core/db');
const { Llm } = require('../core/llm');
const { scrubPlaybook, scrubStyle } = require('../core/concierge');

const clip = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
const hasPrivate = (t) => /\d{6,}|@\w|https?:\/\//i.test(t);

(async () => {
  const store = await Store.open({ url: config.databaseUrl, file: config.dbPath });
  const llm = new Llm(config.llm, {});
  const bot = new Set((await store.all("SELECT text FROM messages WHERE direction='out' AND role='assistant'")).map((r) => r.text));
  const isBot = (t) => bot.has(t) || /^Thanks \S+,? (noted|the team|we've noted|I've noted)/i.test(t) || /^Hi \S+, I'm from Glad U Came/i.test(t) || /I'm from Glad U Came, a PR and influencer/i.test(t);
  const convs = await store.archiveAll({ minTeam: 1 });
  console.log(`${convs.length} conversations with team messages`);

  // recurring long messages (campaign pitches / templates) and one-off conversational messages
  const freq = new Map(); const convo = []; const pairs = [];
  for (const c of convs) {
    c.msgs.forEach((m, i) => {
      if (!m.fromUs || isBot(m.text)) return;
      const key = m.text.slice(0, 80);
      freq.set(key, { n: (freq.get(key)?.n || 0) + 1, text: m.text });
      if (m.text.length >= 25 && m.text.length <= 160 && !hasPrivate(m.text)) convo.push(m.text);
      const prev = c.msgs[i - 1];
      if (prev && !prev.fromUs && /\?/.test(prev.text) && prev.text.length < 220 && m.text.length < 300 && !hasPrivate(m.text)) pairs.push({ q: prev.text, a: m.text });
    });
  }
  const templates = [...freq.values()].filter((x) => x.n >= 4 && x.text.length > 120).sort((a, b) => b.n - a.n).slice(0, 10);
  const pick = (arr, n) => { const out = []; const step = Math.max(1, Math.floor(arr.length / n)); for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]); return out; };
  const style = [...new Set(pick(convo, 60))].slice(0, 16);
  const qa = pick(pairs, 36);
  console.log(`${templates.length} recurring templates, ${convo.length} conversational messages, ${pairs.length} question/answer pairs`);

  const material = [
    'RECURRING MESSAGES THE TEAM SENDS (each sent many times):',
    ...templates.map((t, i) => `T${i + 1} (sent ${t.n}x): ${clip(t.text, 700)}`),
    '',
    'REAL EXCHANGES (customer or creator asked, team answered):',
    ...qa.map((p, i) => `Q${i + 1}: ${clip(p.q, 200)}\nA${i + 1}: ${clip(p.a, 260)}`),
  ].join('\n');

  const raw = await llm.complete({
    system: `You are building an internal PLAYBOOK for an AI assistant that helps a PR and influencer marketing agency's team (Glad U Came) with Instagram DMs. You are given the team's own real messages. Write the playbook in plain text, at most 450 words, with these sections:
CAMPAIGNS AND OFFERS: each brand or campaign the team is currently approaching creators about (name it exactly as in the messages), what is offered (paid, barter, gifting hamper, event), what is asked of the creator (deliverables), and any condition the team states.
COMMON QUESTIONS AND HOW THE TEAM ANSWERS: the recurring questions creators ask and the team's actual answers.
PROCESS: what the team asks for next and how it hands over (for example contact details, WhatsApp, manager contact).
RULES: only use what is in the messages. Do NOT include any fee, rate or price amounts, any phone number, email or link, or any person's name. Do not invent anything. If unsure, leave it out.`,
    messages: [{ role: 'user', content: material }],
    temperature: 0.2, maxTokens: 1100,
  });
  const playbook = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  await store.kvSet('playbook', playbook);
  await store.kvSet('team_style', cleanStyle);
  console.log('\n===== PLAYBOOK =====\n' + playbook + '\n\n===== STYLE EXAMPLES =====\n' + cleanStyle.map((s) => '- ' + s).join('\n'));
  await store.close();
})().catch((e) => { console.error(e); process.exit(1); });
