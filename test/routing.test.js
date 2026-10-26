'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const baseConfig = require('../core/config');

const silent = { log() {}, warn() {}, error() {} };

async function boot(contactType) {
  const seen = [];
  const llm = async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) return { contact_type: contactType };
    seen.push(sys);
    return 'Thanks for reaching out.';
  };
  const config = { ...baseConfig, telegramToken: '', adminPassword: 'pw', intakeSecret: 's', databaseUrl: '' };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: llm, debounceMs: 0, log: silent });
  return { app, seen };
}
const say = async (app, text) => { await app.engine.receive({ channel: 'telegram', chatId: 'tg-1', text }); await app.engine.settle(); return app.store.getLeadByChat('tg-1'); };

test('a creator is routed to the influencer team, not qualified as a brand, and still gets replies', async () => {
  const { app, seen } = await boot('creator');
  let lead = await say(app, "Hi, I'm a lifestyle creator with 60k followers, how do I collaborate with brands through you?");
  assert.strictEqual(lead.stage, 'human');
  assert.match(lead.stage_reason, /Creator enquiry/);
  assert.ok(!lead.ai_paused, 'the assistant stays on');
  assert.ok(seen.some((s) => /creator or influencer, not a brand/.test(s)), 'the creator hand-off instructions were used');
  const before = (await app.store.getMessages(lead.id)).filter((m) => m.direction === 'out').length;
  lead = await say(app, 'my handle is @meeraloves, skincare and fashion');
  const after = (await app.store.getMessages(lead.id)).filter((m) => m.direction === 'out').length;
  assert.strictEqual(after, before + 1, 'later messages from a routed creator are still answered');
  assert.strictEqual(lead.stage, 'human');
});

test('a brand that only mentions influencers is not rerouted', async () => {
  const { app } = await boot('creator');
  const lead = await say(app, 'We are a skincare brand and want to work with influencers for our launch');
  assert.notStrictEqual(lead.stage, 'human');
});

test('press and existing clients are routed with their own reason', async () => {
  let t = await boot('press');
  let lead = await say(t.app, 'Hello, I am a journalist at a lifestyle magazine, can I speak to someone about a feature?');
  assert.match(lead.stage_reason, /Press enquiry/);
  t = await boot('existing_client');
  lead = await say(t.app, 'Hi, we are an existing client, can I speak to my account manager about our ongoing campaign?');
  assert.match(lead.stage_reason, /Existing client/);
});
