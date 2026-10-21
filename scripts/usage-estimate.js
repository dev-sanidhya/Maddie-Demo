'use strict';
// Measures what the AI really costs: runs typical enquiries through the real model, counts the tokens
// Cloudflare reports for each, then projects a month and a trial week.   node scripts/usage-estimate.js [enquiries-per-month]
const { DatabaseSync } = require('node:sqlite');
const config = require('../core/config');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const pricing = require('../core/pricing');

const silent = { log() {}, warn() {}, error() {} };
const PER_MONTH = Number(process.argv[2]) || 150;

// [name, share of all enquiries, customer messages, what happens afterwards]
const SCENARIOS = [
  ['Strong lead, books a call', 0.15, ['hi, we are a D2C haircare brand called Silk Roots', 'we want an influencer campaign for our new serum launch', 'based in Bangalore', 'budget is around 9 lakh', 'we want to start next month', 'tomorrow 5 pm works for a call', 'my number is 9876501234', 'thanks'], 'reminder'],
  ['Strong lead, asks many questions', 0.07, ['hello, I run a fashion label', 'what services do you offer?', 'do you work with micro creators?', 'we are in Delhi, budget 12 lakh', 'how long does a campaign take?', 'what does reporting look like?', 'we want to launch in 6 weeks', 'can you do gifting kits too?', 'ok, friday at 4 pm for a call', 'thank you'], 'reminder'],
  ['Budget too low', 0.15, ['hi, need influencers for my small cafe', 'in Pune', 'budget is about 40 thousand', 'okay'], null],
  ['Interested but timeline far away (nurture)', 0.08, ['hello we are a wellness startup', 'planning a campaign sometime next year', 'in Mumbai, around 6 lakh budget', 'maybe 10 months from now', 'ok will think'], null],
  ['Wants a human', 0.05, ['hi', 'I want to talk to a real person please'], null],
  ['Says hello, then goes quiet', 0.30, ['hi'], 'nudges'],
  ['Short chat, then goes quiet', 0.20, ['hi, we sell protein snacks', 'looking for influencers'], 'nudges'],
];

(async () => {
  const src = new DatabaseSync(config.dbPath, { readOnly: true });
  const store = await Store.open({ file: ':memory:' });
  for (const r of src.prepare('SELECT * FROM settings').all()) await store.settingsSetRaw(r.key, JSON.parse(r.value));
  for (const r of src.prepare('SELECT * FROM designers').all()) await store.saveDesigner(r);
  const app = await createApp(config, { store, debounceMs: 0, log: silent, seed: false });
  if (!app.llm.enabled) { console.error('No LLM key configured.'); process.exit(1); }
  const snap = () => JSON.parse(JSON.stringify(app.llm.usage));
  const diff = (a, b) => Object.entries(b).map(([model, v]) => ({ model, calls: v.calls - ((a[model] || {}).calls || 0), prompt_tokens: v.prompt - ((a[model] || {}).prompt || 0), completion_tokens: v.completion - ((a[model] || {}).completion || 0) })).filter((r) => r.calls > 0);

  const results = [];
  for (const [i, [name, share, msgs, after]] of SCENARIOS.entries()) {
    const before = snap();
    const chatId = `sim:est-${i}`;
    const lead = await store.createLead({ channel: 'sim', chat_id: chatId, name: 'Test', source: 'est', start_token: `est${i}`, meta: {} });
    for (const text of msgs) {
      await app.engine.receive({ channel: 'sim', chatId, text });
      await new Promise((r) => setTimeout(r, 20));
      await app.engine.idle(lead.id); await app.engine.settle();
    }
    if (after === 'nudges') { await app.engine.nudge(lead.id, 'followup'); await app.engine.nudge(lead.id, 'followup'); }
    if (after === 'reminder') await app.engine.nudge(lead.id, 'reminder');
    const rows = diff(before, snap());
    const c = pricing.cost(rows);
    const calls = rows.reduce((n, r) => n + r.calls, 0);
    const prompt = rows.reduce((n, r) => n + r.prompt_tokens, 0);
    const completion = rows.reduce((n, r) => n + r.completion_tokens, 0);
    const final = await store.getLead(lead.id);
    results.push({ name, share, msgs: msgs.length, calls, prompt, completion, ...c, stage: final.stage });
    console.log(`${name.padEnd(46)} msgs=${String(msgs.length).padStart(2)} calls=${String(calls).padStart(2)} in=${String(prompt).padStart(6)} out=${String(completion).padStart(5)} neurons=${String(c.neurons).padStart(6)} $${c.usd.toFixed(4)} -> ${final.stage}`);
  }

  // Projection
  const avg = (key) => results.reduce((n, r) => n + r[key] * r.share, 0);
  const per = { calls: avg('calls'), prompt: avg('prompt'), completion: avg('completion'), neurons: avg('neurons'), usd: avg('usd') };
  console.log('\nWeighted average per enquiry (using the mix above):');
  console.log(`  AI calls ${per.calls.toFixed(1)} | tokens in ${Math.round(per.prompt)} + out ${Math.round(per.completion)} = ${Math.round(per.prompt + per.completion)} | neurons ${Math.round(per.neurons)} | $${per.usd.toFixed(4)}`);
  const monthly = (n) => ({ tokens: Math.round((per.prompt + per.completion) * n), neurons: Math.round(per.neurons * n), usd: per.usd * n, calls: Math.round(per.calls * n) });
  const week = PER_MONTH * 7 / 30;
  const m = monthly(PER_MONTH); const w = monthly(week);
  console.log(`\n${PER_MONTH} enquiries a month  -> ${m.calls} AI calls, ${m.tokens.toLocaleString()} tokens, ${m.neurons.toLocaleString()} neurons, $${m.usd.toFixed(2)} at full price`);
  console.log(`One-week trial (~${Math.round(week)} enquiries) -> ${w.calls} AI calls, ${w.tokens.toLocaleString()} tokens, ${w.neurons.toLocaleString()} neurons, $${w.usd.toFixed(2)} at full price`);
  const perDay = m.neurons / 30;
  console.log(`Average ${Math.round(perDay).toLocaleString()} neurons a day vs ${pricing.FREE_NEURONS_PER_DAY.toLocaleString()} free per account per day (you have 2 accounts = ${(2 * pricing.FREE_NEURONS_PER_DAY).toLocaleString()}).`);
  console.log(`Busiest-day check: a day with ${Math.ceil(PER_MONTH / 30 * 4)} enquiries (4x the average) = ${Math.round(per.neurons * Math.ceil(PER_MONTH / 30 * 4)).toLocaleString()} neurons.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
