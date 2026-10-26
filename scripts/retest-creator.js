'use strict';
// Small live check of the creator flow and Hinglish replies (about 15 AI calls, roughly 1,500 neurons).
// It first probes each Cloudflare account and stops if the free daily allowance is used up, so it never drains production.
//   LOCAL_ONLY=1 node scripts/retest-creator.js
const config = require('../core/config');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { SETTINGS, TEAM } = require('./client-glad-u-came');

async function quotaLeft() {
  for (const p of config.llm.providers.filter((x) => x.apiKey && /cloudflare/.test(x.name))) {
    const r = await fetch(`${p.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: p.models[0], messages: [{ role: 'user', content: 'hi' }], max_tokens: 3 }) });
    if (r.ok) return true;
  }
  return false;
}

(async () => {
  if (!(await quotaLeft())) { console.log('Every Cloudflare account is out of free allowance (resets 00:00 UTC, 5:30 AM IST). Nothing was run.'); return; }
  const app = await createApp({ ...config, telegramToken: '', databaseUrl: '' }, { store: await Store.open({ file: ':memory:' }), debounceMs: 0, log: { log() {}, warn() {}, error() {} } });
  await app.settings.update(SETTINGS);
  for (const t of TEAM) await app.store.saveDesigner({ ...t, min_budget: 0 });
  let n = 0;
  const run = async (label, msgs) => {
    console.log(`\n##### ${label}`);
    const lead = await app.store.createLead({ channel: 'sim', chat_id: `sim:r${++n}`, name: 'Riya', source: 't', start_token: `r${n}` });
    for (const t of msgs) {
      await app.engine.receive({ channel: 'sim', chatId: lead.chat_id, text: t });
      await app.engine.settle();
      const out = (await app.store.getMessages(lead.id)).filter((m) => m.direction === 'out');
      const x = await app.store.getLead(lead.id);
      console.log(`U: ${t}\nB: ${(out[out.length - 1] || {}).text || '(no reply)'}\n   [${x.stage}: ${x.stage_reason}]`);
    }
  };
  await run('Creator asks about fees and selection', ['Hi I am a travel creator with 80k on insta, what is your rate per reel? will I definitely get selected?', '@wanderwithme, Goa, English and Hindi']);
  await run('Creator asks about a hamper and offers an address', ['do you send hampers to creators? I do fashion reels, 30k followers', 'sure my address is 12 MG Road Pune 411001']);
  await run('Creator, free collab', ['I make food reels (15k), can I collab for free products?']);
  await run('Hinglish brand', ['bhai hume influencer campaign karna hai apne chai brand ke liye', 'mumbai aur pune me, budget 5 lakh hai']);
  await run('Hinglish creator', ['hi main fashion creator hun, 20k followers, kaise join kar sakti hu aapke saath?']);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
