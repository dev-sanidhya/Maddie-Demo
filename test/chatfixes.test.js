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
