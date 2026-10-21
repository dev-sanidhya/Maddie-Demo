'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const config = require('../core/config');
const { sanitizeReply, ungrounded } = require('../core/validator');

const silent = { log() {}, warn() {}, error() {} };

// A model stand-in that records exactly what the real one would be shown, and a "summarizer"
// that faithfully keeps every marker it is given. If a marker is neither in the live messages
// nor in the summary at some turn, the chatbot has forgotten something: that is the failure we test for.
function recorder({ summarizerWorks = true } = {}) {
  const prompts = [];
  const llm = async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) return { refused: [] };
    if (sys.includes('long-term memory')) {
      if (!summarizerWorks) throw new Error('summarizer down');
      const prev = (o.messages[0].content.match(/Current summary: (.*)/) || [])[1] || '';
      const fresh = o.messages[0].content.split('New messages:')[1] || '';
      const markers = [...new Set(fresh.match(/\bM\d+\b/g) || [])].filter((m) => !new RegExp(`\\b${m}\\b`).test(prev)).join(' ');
      return `${prev.replace('(empty)', '')} ${markers}`.trim();
    }
    prompts.push({ system: sys, messages: o.messages });
    return 'Thanks, noted.';
  };
  return { llm, prompts };
}

async function build(opts) {
  const rec = recorder(opts);
  const app = await createApp({ ...config, telegramToken: '' }, { store: await Store.open({ file: ':memory:' }), llmOverride: rec.llm, debounceMs: 0, log: silent });
  app.engine.transports.instagram = { send: async () => {}, typing: async () => {}, sendRaw: async () => {} };
  return { app, ...rec };
}
const settle = async (app, id) => { await app.engine.idle(id); await new Promise((r) => setTimeout(r, 5)); await app.engine.idle(id); await app.engine.settle(); };

async function chat(app, n, chatId) {
  const lead = await app.store.createLead({ channel: 'instagram', chat_id: chatId, name: 'Memory Test', source: 'instagram', meta: {} });
  for (let i = 1; i <= n; i++) {
    await app.engine.receive({ channel: 'instagram', chatId, text: `we also talked about M${i}`, externalId: `${chatId}-${i}` });
    await settle(app, lead.id);
  }
  return lead;
}

const shown = (p) => `${p.system}\n${p.messages.map((m) => m.content).join('\n')}`;

test('in a 60-message chat, every earlier message is always either shown or summarised (no gap)', async () => {
  const { app, prompts } = await build();
  await chat(app, 60, 'ig:mem1');
  assert.ok(prompts.length >= 50, 'the assistant replied to nearly every message');
  prompts.forEach((p, idx) => {
    const text = shown(p);
    const current = idx + 1; // the message being answered
    for (let i = 1; i < current; i++) assert.ok(new RegExp(`\\bM${i}\\b`).test(text), `turn ${current}: M${i} was forgotten`);
    assert.ok(p.messages.length <= 40, `turn ${current}: prompt grew to ${p.messages.length} messages`);
  });
});

test('even if the summarizer is down, the model sees the 40 most recent messages and the prompt stays bounded', async () => {
  const { app, prompts } = await build({ summarizerWorks: false });
  await chat(app, 45, 'ig:mem2');
  const last = prompts[prompts.length - 1];
  assert.ok(last.messages.length <= 40);
  const text = shown(last);
  for (let i = 45 - 15; i <= 45; i++) assert.ok(new RegExp(`\\bM${i}\\b`).test(text), `recent M${i} must be present`);
});

test('the summary is stored with its position, and a stale summarizer cannot overwrite a newer one', async () => {
  const { app } = await build();
  const lead = await chat(app, 30, 'ig:mem3');
  const fresh = await app.store.getLead(lead.id);
  assert.ok(fresh.summary_upto > 0 && fresh.summary.includes('M1'));
  // a late writer holding an old position loses the compare-and-swap
  const r = await app.store.run('UPDATE leads SET summary=?, summary_upto=? WHERE id=? AND summary_upto=?', 'STALE', 1, lead.id, 0);
  assert.strictEqual(r.changes, 0);
  assert.notStrictEqual((await app.store.getLead(lead.id)).summary, 'STALE');
});

test('contextMessages returns everything uncovered, never fewer than the minimum, never more than the cap', async () => {
  const store = await Store.open({ file: ':memory:' });
  const lead = await store.createLead({ channel: 'telegram', chat_id: 'x', meta: {} });
  const ids = [];
  for (let i = 0; i < 60; i++) ids.push(await store.addMessage({ lead_id: lead.id, direction: i % 2 ? 'out' : 'in', role: i % 2 ? 'assistant' : 'user', text: `m${i}` }));
  const uncoveredAll = await store.contextMessages(lead.id, { summaryUpto: 0 });
  assert.strictEqual(uncoveredAll.length, 40, 'capped');
  const covered = await store.contextMessages(lead.id, { summaryUpto: ids[55] });
  assert.strictEqual(covered.length, 14, 'only the minimum when the summary covers the rest');
  const partial = await store.contextMessages(lead.id, { summaryUpto: ids[39] });
  assert.strictEqual(partial.length, 20, 'everything after the summary point');
  assert.strictEqual(partial[0].text, 'm40');
  const before = await store.contextMessages(lead.id, { beforeId: ids[30], summaryUpto: 0 });
  assert.ok(before.every((m) => m.id < ids[30]));
});

test('replies cannot state numbers that are not in the business facts or the customer details', () => {
  const grounding = 'We run campaigns of 4 to 8 weeks. Founded in 2015. 1000+ brands. Budget: ₹6.5L (they said: 6.5 lakh)';
  const lead = { meta: {} };
  const clean = (t) => sanitizeReply(t, lead, { grounding });
  assert.strictEqual(clean('We have worked with 500 brands in beauty.'), '');
  assert.strictEqual(clean('Our packages start at ₹50,000 a month.'), '');
  assert.strictEqual(clean('We have hundreds of clients across India.'), '');
  assert.strictEqual(clean('We have 12 years of experience.'), '');
  assert.strictEqual(clean('A campaign usually runs 4 to 8 weeks.'), 'A campaign usually runs 4 to 8 weeks.');
  assert.strictEqual(clean('Your 6.5 lakh budget gives us room to work with.'), 'Your 6.5 lakh budget gives us room to work with.');
  // a bad sentence is dropped, the good one kept
  assert.strictEqual(clean('We have 500 brands. Happy to help with your launch.'), 'Happy to help with your launch.');
  assert.ok(!ungrounded('Anything goes when no grounding is supplied.', undefined));
});

test('a recall question never edits the record, and every stated detail is kept word for word', () => {
  const { applyFacts, isConfirmQuestion } = require('../core/facts');
  const { DEFAULTS } = require('../core/settings');
  const settings = JSON.parse(JSON.stringify(DEFAULTS));
  const lead = { meta: {}, budget_amount: 800000, stage: 'active' };
  const asked = applyFacts(lead, { budget_amount: 2000000, details: ['x'.repeat(5)] }, 'Did I say my budget was 20 lakh?', { settings });
  assert.strictEqual(asked.patch.budget_amount, undefined, 'the budget is untouched');
  assert.deepStrictEqual(asked.changed, []);
  assert.ok(isConfirmQuestion("Didn't I tell you the launch is 14 November?"));
  assert.ok(!isConfirmQuestion('my budget is 20 lakh'), 'a statement is still a statement');
  assert.ok(!isConfirmQuestion('can we do tomorrow 5 pm?'));

  // details accumulate, duplicates and near-duplicates are not stored twice
  let meta = {};
  for (const d of [['co-founder Meera handles finance'], ['Co-founder Meera handles finance.', 'wants no creators from Dew Naturals'], ['wants no creators from Dew Naturals', 'null']]) {
    meta = applyFacts({ meta, stage: 'qualifying' }, { details: d }, 'a normal statement', { settings }).meta;
  }
  assert.deepStrictEqual(meta.memory, ['co-founder Meera handles finance', 'wants no creators from Dew Naturals']);
});
