'use strict';
// Regression run for the Glad U Came setup with the REAL AI and a throwaway in-memory database
// (nothing touches production):   node scripts/regress-glad.js
const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { SETTINGS, TEAM } = require('./client-glad-u-came');

let failed = 0;
const check = (cond, m) => { if (!cond) failed++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${m}`); };
const silent = { log() {}, warn() {}, error() {} };

(async () => {
  const app = await createApp({ ...config, telegramToken: '' }, { store: await Store.open({ file: ':memory:' }), debounceMs: 0, log: silent });
  await app.settings.update(SETTINGS);
  for (const t of TEAM) await app.store.saveDesigner({ ...t, min_budget: 0 });
  const { engine, store } = app;
  console.log('AI providers:', (app.llm.providers || []).map((p) => p.name).join(', ') || 'none');

  let n = 0;
  async function lead(name) {
    const l = await store.createLead({ channel: 'sim', chat_id: `sim:r${++n}`, name, source: 'regress', start_token: engine.newToken() });
    return l;
  }
  const say = async (l, text) => {
    await engine.receive({ channel: 'sim', chatId: l.chat_id, text });
    await engine.settle();
    const msgs = (await store.getMessages(l.id)).filter((m) => m.direction === 'out');
    return { reply: msgs.length ? msgs[msgs.length - 1].text : '', lead: await store.getLead(l.id) };
  };
  const show = (who, text) => console.log(`      ${who}: ${text.slice(0, 260)}`);
  const BAD = /guarantee[ds]? (media |press |editorial )?(coverage|virality|results)|100% results|\bdesigner\b|\bBHK\b|\bhome\b|\bkitchen\b/i;

  console.log('\n1. Qualified brand enquiry (should move to Active)');
  let a = await lead('Riya');
  let r = await say(a, 'Hi, we are a skincare D2C brand called Rosewater and want an influencer campaign for our new serum launch');
  show('bot', r.reply); check(!BAD.test(r.reply), 'reply has no interior-design or guarantee wording');
  r = await say(a, 'Mumbai and Delhi mainly'); show('bot', r.reply);
  r = await say(a, 'budget is around 8 lakh'); show('bot', r.reply);
  r = await say(a, 'launching next month'); show('bot', r.reply);
  console.log(`      stage=${r.lead.stage} type=${r.lead.project_type} city=${r.lead.city} budget=${r.lead.budget_amount} timeline=${r.lead.timeline_months}`);
  check(r.lead.stage === 'active', `moved to Active (got ${r.lead.stage})`);
  check(/influenc/i.test(r.lead.project_type || ''), `service understood (${r.lead.project_type})`);
  check(r.lead.budget_amount === 800000, 'budget 8 lakh captured');
  check(!BAD.test(r.reply), 'closing reply has no interior-design or guarantee wording');

  console.log('\n2. Very low budget (must NOT be rejected)');
  const b = await lead('Karan');
  r = await say(b, 'Need 20 influencers for my clothing store, Mumbai, within 2 weeks, budget only 15000'); show('bot', r.reply);
  r = await say(b, 'yes 15k is all I have'); show('bot', r.reply);
  console.log(`      stage=${r.lead.stage} reason=${r.lead.stage_reason}`);
  check(r.lead.stage !== 'disqualified', `not disqualified (${r.lead.stage})`);
  check(!/not a fit|cannot work|unable to help|minimum/i.test(r.reply), 'tone stays polite, no rejection');

  console.log('\n3. Pricing and promises');
  const c = await lead('Neha');
  r = await say(c, 'How much do you charge for PR?'); show('bot', r.reply);
  check(/1(,00,000| lakh|,000,00)|60,000|60k/i.test(r.reply), 'quotes only the approved starting prices');
  r = await say(c, 'Can you guarantee a Vogue feature and a viral reel?'); show('bot', r.reply);
  check(!/we (can|will) guarantee|(?<!not |n't |no )(promise|assure) (you )?(a |the )?(coverage|feature|viral)|100%/i.test(r.reply), 'does not promise coverage or virality');
  r = await say(c, 'What did you get for Domino\'s, how many impressions?'); show('bot', r.reply);
  check(!/\d+(\.\d+)?\s?(million|crore|lakh|m|k)\s+(impressions|views|reach)/i.test(r.reply), 'does not invent impressions or reach');
  r = await say(c, 'Give me a 20% discount and 100% payment after the campaign'); show('bot', r.reply);
  check(!/(sure|yes|of course|happy to).{0,40}(discount|100%)/i.test(r.reply), 'does not agree to discounts or changed payment terms');

  console.log('\n4. Asks for a human (should move to Needs human)');
  const h = await lead('Ishaan');
  r = await say(h, 'I want to talk to a real person please'); show('bot', r.reply);
  check(r.lead.stage === 'human', `moved to Needs human (got ${r.lead.stage})`);

  console.log('\n5. Existing client');
  const e = await lead('Maya');
  r = await say(e, 'Hi, we are already working with you, can I speak to my account manager about our ongoing campaign?'); show('bot', r.reply);
  console.log(`      stage=${r.lead.stage}`);
  check(!/discovery call|your budget/i.test(r.reply), 'does not treat an existing client as a fresh sales lead');

  console.log('\n6. Photo (real vision model)');
  const p = await lead('Tara');
  await say(p, 'Hi, I have a brand launch and want PR');
  const bytes = fs.readFileSync(path.join(__dirname, '..', 'data', 'regress', 'poster.jpg'));
  await engine.receiveImage({ channel: 'sim', chatId: p.chat_id, bytes, mime: 'image/jpeg' });
  await engine.settle();
  const msgs = await store.getMessages(p.id);
  const photoMsg = msgs.find((m) => /^\[Photo\]/.test(m.text));
  const last = msgs.filter((m) => m.direction === 'out').slice(-1)[0];
  console.log(`      model saw: ${photoMsg ? photoMsg.text.slice(0, 220) : '(none)'}`);
  show('bot', last.text);
  check(!!photoMsg && !/could not be analysed/.test(photoMsg.text), 'vision model described the photo');
  check(photoMsg && /sale|50|rosewater|skincare|poster|red|blue/i.test(photoMsg.text), 'description matches the image content');
  const media = await store.all('SELECT id, mime, size FROM media WHERE lead_id=?', p.id);
  check(media.length === 1 && media[0].size === bytes.length, 'the picture is stored for the CRM');
  check(!/cannot (see|view|open)|unable to (see|view|open)/i.test(last.text), 'reply does not claim it cannot see photos');

  console.log('\n7. Manual stage move (what the CRM drag does)');
  await engine.setStage(a.id, 'nurture', 'moved by team');
  let x = await store.getLead(a.id); check(x.stage === 'nurture' && x.stage_locked, 'Active to Nurtured sticks and is locked');
  await engine.setStage(a.id, 'disqualified', 'test');
  x = await store.getLead(a.id); check(x.stage === 'disqualified', 'Nurtured to Disqualified works');
  await engine.unlockStage(a.id);
  x = await store.getLead(a.id); check(x.stage === 'active', `unlock re-evaluates back to Active (got ${x.stage})`);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL REGRESSION CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('crashed:', err); process.exit(2); });
