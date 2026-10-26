'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyFacts } = require('../core/facts');
const { sanitizeReply } = require('../core/validator');
const { DEFAULTS } = require('../core/settings');

const now = Date.parse('2026-10-26T10:00:00Z');
const settings = DEFAULTS;
const booked = { id: 1, meta: {}, callback_at: Date.parse('2026-10-23T11:30:00Z'), callback_text: 'Tomorrow, Fri 23 Oct, 5:00 PM', callback_status: 'scheduled' };

test('a plain "hey" never moves a booked call even if the model re-reads an old "tomorrow 5 pm"', () => {
  const r = applyFacts(booked, { callback_text: 'tomorrow 5 pm', callback_at: '2026-10-27T17:00' }, 'Hey there', { lastAsked: null, settings, now });
  assert.strictEqual(r.patch.callback_at, undefined);
  assert.ok(!r.changed.includes('callback_at'));
});

test('"tomorrow anytime" is a preference, not a midnight booking', () => {
  const lead = { id: 2, meta: {} };
  const r = applyFacts(lead, { callback_text: 'tomorrow anytime', callback_at: '2026-10-27T00:00' }, 'Tomorrow anytime', { lastAsked: 'callback', settings, now });
  assert.strictEqual(r.patch.callback_at, undefined);
  assert.strictEqual(r.patch.callback_status, 'requested');
});

test('a real time still books', () => {
  const lead = { id: 3, meta: {} };
  const r = applyFacts(lead, { callback_text: 'tomorrow 5 pm', callback_at: '2026-10-27T17:00' }, 'tomorrow 5 pm works', { lastAsked: 'callback', settings, now });
  assert.ok(r.patch.callback_at);
});

test('a reply that opens by repeating what the customer said loses that sentence', () => {
  const lead = { id: 4, meta: {} };
  const out = sanitizeReply("You've mentioned a budget range of 1-2 lakh. That gives us room to plan a focused creator campaign. What would you like the content to achieve?", lead, { polish: true, maxQuestions: 1 });
  assert.ok(!/mentioned a budget/.test(out));
  assert.match(out, /focused creator campaign/);
  const kept = sanitizeReply("That gives us room to plan a focused campaign. What should the content achieve?", lead, { polish: true, maxQuestions: 1 });
  assert.match(kept, /^That gives us room/);
});

test('"in next 10-15 days" answers the timeline question even if the model returns nothing', async () => {
  const { Store } = require('../core/db');
  const { createApp } = require('../core/app');
  const baseConfig = require('../core/config');
  let asked = null;
  const llm = async (o) => {
    if ((o.system || '').includes('You extract structured facts')) return {};
    return 'Noted.';
  };
  const config = { ...baseConfig, telegramToken: '', adminPassword: 'pw', intakeSecret: 's', databaseUrl: '' };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: llm, debounceMs: 0, log: { log() {}, warn() {}, error() {} } });
  const lead = await app.store.createLead({ channel: 'sim', chat_id: 'sim:tl', name: 'T', source: 't', start_token: 'tl', meta: { last_asked: 'timeline' } });
  await app.engine.receive({ channel: 'sim', chatId: 'sim:tl', text: 'In next 10-15 days' });
  await app.engine.settle();
  const l = await app.store.getLead(lead.id);
  assert.ok(l.timeline_months !== null && l.timeline_months <= 1, `timeline captured (${l.timeline_months})`);
});

test('a time outside 10 AM to 6 PM is not booked, it is kept as a preference', () => {
  const s = { ...settings, calendar: { ...settings.calendar, work_start_hour: 10, work_end_hour: 18 } };
  const lead = { id: 5, meta: {} };
  const late = applyFacts(lead, { callback_text: 'tomorrow 9 pm', callback_at: '2026-10-27T21:00' }, 'tomorrow 9 pm works', { lastAsked: 'callback', settings: s, now });
  assert.strictEqual(late.patch.callback_at, undefined);
  assert.strictEqual(late.meta.flags.callback_outside, true);
  const early = applyFacts(lead, { callback_text: 'tomorrow 8 am', callback_at: '2026-10-27T08:00' }, 'tomorrow 8 am', { lastAsked: 'callback', settings: s, now });
  assert.strictEqual(early.patch.callback_at, undefined);
  const ok = applyFacts(lead, { callback_text: 'tomorrow 6 pm', callback_at: '2026-10-27T18:00' }, 'tomorrow 6 pm', { lastAsked: 'callback', settings: s, now });
  assert.ok(ok.patch.callback_at, '6 PM sharp is inside the window');
});

test('a booked call stays exactly as stored through unrelated messages, and only an explicit change moves it', async () => {
  const { Store } = require('../core/db');
  const { createApp } = require('../core/app');
  const baseConfig = require('../core/config');
  let mode = 'noise';
  const llm = async (o) => {
    if ((o.system || '').includes('You extract structured facts')) {
      // the model keeps re-reading the old time from history, as it did in production
      return mode === 'noise' ? { callback_text: 'tomorrow 5 pm', callback_at: '2099-01-01T17:00' } : { callback_text: 'friday 3 pm', callback_at: '' };
    }
    return 'Noted.';
  };
  const config = { ...baseConfig, telegramToken: '', adminPassword: 'pw', intakeSecret: 's', databaseUrl: '' };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: llm, debounceMs: 0, log: { log() {}, warn() {}, error() {} } });
  const booked = Date.now() + 2 * 86400000;
  const lead = await app.store.createLead({ channel: 'sim', chat_id: 'sim:keep', name: 'K', source: 't', start_token: 'keep' });
  await app.store.updateLead(lead.id, { callback_at: booked, callback_text: 'booked', callback_status: 'scheduled' });
  for (const t of ['Hey there', 'thanks', 'what does reporting look like?']) {
    await app.engine.receive({ channel: 'sim', chatId: 'sim:keep', text: t });
    await app.engine.settle();
    assert.strictEqual((await app.store.getLead(lead.id)).callback_at, booked, `unchanged after "${t}"`);
  }
});

test('soft promises and timeline judgements are dropped, and a double question keeps the first', () => {
  const lead = { id: 9, meta: {} };
  const a = sanitizeReply("Next month is a tight timeline, but we can definitely work with that. What kind of products do you sell, and who is your target audience?", lead, { polish: true, maxQuestions: 1 });
  assert.ok(!/definitely|tight/i.test(a), a);
  assert.match(a, /What kind of products do you sell\?$/);
  const b = sanitizeReply("A 1-month timeline is a good challenge for us. Which city is the campaign in?", lead, { polish: true, maxQuestions: 1 });
  assert.ok(!/challenge/i.test(b), b);
});

test('asking "are you a bot?" does not hand the chat to a person', () => {
  const lead = { id: 10, meta: {} };
  const r = applyFacts(lead, { wants_human: true }, 'hi are you a bot?', { lastAsked: null, settings, now });
  assert.ok(!r.meta.flags.wants_human);
  const ask = applyFacts(lead, { wants_human: true }, 'I want to talk to a real person please', { lastAsked: null, settings, now });
  assert.ok(ask.meta.flags.wants_human);
});

test('invented "discussed earlier" and "we do not offer discounts" lines are dropped', () => {
  const lead = { id: 11, meta: {} };
  const out = sanitizeReply("You'd mentioned payment terms earlier. We also don't offer discounts. For influencer campaigns the structure is 50% on confirmation and 50% on go-live. Which city is the campaign in?", lead, { polish: true, maxQuestions: 1 });
  assert.ok(!/earlier|discount/i.test(out), out);
  assert.match(out, /50% on confirmation/);
});

test('a Hinglish customer message tells the model to answer in Hinglish', async () => {
  const { Store } = require('../core/db');
  const { createApp } = require('../core/app');
  const baseConfig = require('../core/config');
  const prompts = [];
  const llm = async (o) => {
    if ((o.system || '').includes('You extract structured facts')) return {};
    prompts.push(o.system);
    return 'Theek hai.';
  };
  const config = { ...baseConfig, telegramToken: '', adminPassword: 'pw', intakeSecret: 's', databaseUrl: '' };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: llm, debounceMs: 0, log: { log() {}, warn() {}, error() {} } });
  await app.settings.update({ agent: { polish: true } });
  await app.store.createLead({ channel: 'sim', chat_id: 'sim:hg', name: 'H', source: 't', start_token: 'hg' });
  await app.engine.receive({ channel: 'sim', chatId: 'sim:hg', text: 'bhai hume influencer campaign karna hai apne chai brand ke liye' });
  await app.engine.settle();
  assert.ok(prompts.some((p) => /writing in Hinglish/.test(p)), 'Hinglish instruction present');
  prompts.length = 0;
  await app.engine.receive({ channel: 'sim', chatId: 'sim:hg', text: 'We want an influencer campaign for our chai brand' });
  await app.engine.settle();
  assert.ok(!prompts.some((p) => /writing in Hinglish/.test(p)), 'English message gets no Hinglish instruction');
});

test('a Hinglish double question keeps the first', () => {
  const lead = { id: 12, meta: {} };
  const out = sanitizeReply('Aapka chai brand kis tarah ka hai, aur kaun se log aapke target audience hain?', lead, { polish: true, maxQuestions: 1 });
  assert.strictEqual(out, 'Aapka chai brand kis tarah ka hai?');
});
