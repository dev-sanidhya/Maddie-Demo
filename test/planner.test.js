'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { plan, streak, inQuiet, adjustForHours } = require('../core/followups');
const { DEFAULTS } = require('../core/settings');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { Scheduler } = require('../core/scheduler');
const config = require('../core/config');

const MIN = 60000;
const HOUR = 3600000;
const S = () => JSON.parse(JSON.stringify(DEFAULTS));
// the same, with the optional quiet hours switched on (off by default)
const Q = () => { const s = S(); s.followups.quiet_start_hour = 21; s.followups.quiet_end_hour = 9; return s; };
const ist = (iso) => Date.parse(`${iso}+05:30`);
const NOON = ist('2026-10-12T12:00:00'); // a Monday, midday in Mumbai

const ig = (o = {}) => ({
  channel: 'instagram', chat_id: 'ig:1', stage: 'qualifying', meta: {}, fu_step: 0,
  created_at: NOON - 3 * HOUR, last_inbound_at: NOON, last_outbound_at: NOON + MIN, ...o,
});

test('first nudge goes out 8 hours after the question', () => {
  const p = plan(ig(), S(), NOON + 2 * MIN);
  assert.strictEqual(p.kind, 'followup');
  assert.strictEqual(p.step, 1);
  assert.strictEqual(p.at, NOON + MIN + 8 * HOUR);
});

test('there are no quiet hours by default: a night-time nudge is sent when due', () => {
  const askedAt = ist('2026-10-12T21:30:00');
  const p = plan(ig({ last_inbound_at: askedAt - MIN, last_outbound_at: askedAt }), S(), askedAt + MIN);
  assert.strictEqual(p.at, askedAt + 8 * HOUR);
});

test('optional quiet hours push a nudge to the next morning', () => {
  const askedAt = ist('2026-10-12T21:30:00');
  const p = plan(ig({ last_inbound_at: askedAt - MIN, last_outbound_at: askedAt }), Q(), askedAt + MIN);
  assert.strictEqual(p.at, ist('2026-10-13T09:00:00'));
});

test('quiet hours never push a nudge past the Instagram window: it is sent earlier instead', () => {
  const s = Q();
  const inbound = ist('2026-10-12T10:00:00'); // window closes 23h later, at 09:00 next day
  const out = ist('2026-10-12T20:30:00');
  const p = plan(ig({ last_inbound_at: inbound, last_outbound_at: out }), s, out + MIN);
  assert.ok(p.at <= inbound + 23 * HOUR, 'never after the window ends');
  assert.ok(!inQuiet(p.at, 'Asia/Kolkata', s.followups), 'and in hours');
});

test('the last nudge is pulled forward to land inside the 24 hour window', () => {
  const s = S();
  const inbound = NOON;
  const lead = ig({ last_inbound_at: inbound, last_outbound_at: inbound + 10 * HOUR, meta: { fu_streak: { inbound_at: inbound, followups: 1, drips: 0 } } });
  const p = plan(lead, s, inbound + 10 * HOUR + MIN);
  assert.strictEqual(p.kind, 'followup');
  assert.strictEqual(p.step, 2);
  // 10h + 12h would be 22h after their message; the window (23h) minus a 3h margin makes it 20h
  assert.strictEqual(p.at, inbound + 20 * HOUR);
  // with quiet hours on, 20h is 8am, which moves to 9am, still inside the window
  assert.strictEqual(plan(lead, Q(), inbound + 10 * HOUR + MIN).at, ist('2026-10-13T09:00:00'));
});

test('a customer reply restarts the sequence', () => {
  const lead = ig({ meta: { fu_streak: { inbound_at: NOON - 5 * HOUR, followups: 2, drips: 0 } } });
  assert.strictEqual(streak(lead).followups, 0);
  assert.strictEqual(plan(lead, S(), NOON + 2 * MIN).step, 1);
});

test('when the window closes before a nudge, the lead is handed over, not forgotten', () => {
  const lead = ig({ last_inbound_at: NOON - 30 * HOUR, last_outbound_at: NOON - 29 * HOUR });
  const p = plan(lead, S(), NOON);
  assert.strictEqual(p.kind, 'stall');
  assert.strictEqual(plan({ ...lead, stage: 'active' }, S(), NOON), null, 'an active lead is not stalled, "no call time" covers it');
});

test('after the last nudge the lead stalls once the window has closed', () => {
  const inbound = NOON;
  const lead = ig({ last_inbound_at: inbound, last_outbound_at: inbound + 20 * HOUR, meta: { fu_streak: { inbound_at: inbound, followups: 2, drips: 0 } } });
  const p = plan(lead, S(), inbound + 21 * HOUR);
  assert.strictEqual(p.kind, 'stall');
  assert.strictEqual(p.at, inbound + 23 * HOUR, 'handed over the moment the assistant can no longer write');
});

test('Telegram has no window: second nudge is simply 12 hours after the first', () => {
  const lead = { ...ig({ channel: 'telegram' }), last_inbound_at: NOON - MIN, last_outbound_at: NOON, meta: { fu_streak: { inbound_at: NOON - MIN, followups: 1, drips: 0 } } };
  const p = plan(lead, S(), NOON + HOUR);
  assert.strictEqual(p.at, adjustForHours(NOON + 12 * HOUR, { tz: 'Asia/Kolkata', f: S().followups }));
});

test('a form lead who never opens the chat gets flagged for a human after 30 minutes', () => {
  const lead = { channel: 'telegram', chat_id: null, stage: 'new', phone: '9876543210', meta: { form: {} }, created_at: NOON, fu_step: 0 };
  const p = plan(lead, S(), NOON + MIN);
  assert.strictEqual(p.kind, 'chat_nudge');
  assert.strictEqual(p.at, NOON + 30 * MIN);
  assert.strictEqual(plan({ ...lead, meta: { form: {}, fu: { manual_needed_at: NOON } } }, S(), NOON + HOUR), null, 'only once');
});

test('a call reminder is planned an hour before and not again once sent', () => {
  const call = NOON + 5 * HOUR;
  const lead = ig({ stage: 'active', callback_at: call, callback_status: 'scheduled', last_outbound_at: NOON - HOUR, last_inbound_at: NOON });
  const p = plan(lead, S(), NOON);
  assert.strictEqual(p.kind, 'reminder');
  assert.strictEqual(p.at, call - HOUR);
  assert.strictEqual(plan({ ...lead, reminded_at: NOON }, S(), NOON), null);
});

test('sample leads, opted-out leads, paused chats and snoozed leads are left alone', () => {
  const base = ig();
  assert.strictEqual(plan({ ...base, meta: { demo: true } }, S(), NOON + 2 * MIN), null);
  assert.ok(plan({ ...base, meta: { demo: true } }, S(), NOON + 2 * MIN, { includeDemo: true }));
  assert.strictEqual(plan({ ...base, opted_out: 1 }, S(), NOON + 2 * MIN), null);
  assert.strictEqual(plan({ ...base, ai_paused: 1 }, S(), NOON + 2 * MIN), null);
  assert.strictEqual(plan({ ...base, meta: { fu: { snooze_until: NOON + HOUR } } }, S(), NOON + 2 * MIN), null);
});

// ---------- execution: exactly once ----------
const silent = { log() {}, warn() {}, error() {} };

test('two cron runs at the same moment send a follow-up exactly once', async () => {
  const sent = [];
  const store = await Store.open({ file: ':memory:' });
  const app = await createApp({ ...config, telegramToken: '' }, { store, llmOverride: async () => 'Just checking in, still keen?', debounceMs: 0, log: silent });
  app.engine.transports.instagram = { send: async (lead, text) => { sent.push(text); }, typing: async () => {}, sendRaw: async () => {} };
  const now = Date.now();
  const lead = await store.createLead({
    channel: 'instagram', chat_id: 'ig:77', name: 'Quiet', stage: 'qualifying', meta: { turns: 1 },
    last_inbound_at: now - 9 * HOUR, last_outbound_at: now - 8.5 * HOUR,
  });
  const a = new Scheduler({ engine: app.engine, store, settings: app.settings, log: silent });
  const b = new Scheduler({ engine: app.engine, store, settings: app.settings, log: silent });
  const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
  await app.engine.settle();
  assert.strictEqual(ra.followups + rb.followups, 1);
  assert.strictEqual(sent.length, 1);
  const after = await store.getLead(lead.id);
  assert.strictEqual(after.meta.fu_streak.followups, 1);
  // a third run right away has nothing to do: the second nudge is hours away
  const rc = await a.tick();
  assert.strictEqual(rc.followups, 0);
  assert.strictEqual(sent.length, 1);
});

test('a lead that is processed by one instance cannot be taken by another (lease)', async () => {
  const store = await Store.open({ file: ':memory:' });
  const lead = await store.createLead({ channel: 'telegram', chat_id: '9', meta: {} });
  const release = await store.lease(lead.id, 60000);
  assert.ok(release);
  assert.strictEqual(await store.lease(lead.id, 60000), null);
  await release();
  assert.ok(await store.lease(lead.id, 60000));
});
