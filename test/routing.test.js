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

test('creator details are collected one question at a time and kept on the lead', async () => {
  const { creatorMissing } = require('../core/qualify');
  assert.deepStrictEqual(creatorMissing('creator', {}, {}), ['handle', 'followers', 'niche', 'city', 'interest']);
  assert.deepStrictEqual(creatorMissing('creator', { handle: '@a', followers: '10k', niche: 'food', city: 'Pune', interest: 'gifting' }, {}), []);
  assert.deepStrictEqual(creatorMissing('creator_in_campaign', { issue: 'payment' }, {}), ['brand_campaign', 'deliverable']);
  assert.deepStrictEqual(creatorMissing('agency_manager', { agency: 'X' }, { phone: '1' }), ['creators_represented', 'interest']);

  const seen = [];
  const llm = async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) return { contact_type: 'creator', creator: { handle: '@meeraloves', niche: 'skincare', city: 'Pune', followers: '60k', interest: 'paid campaigns' } };
    seen.push(sys);
    return 'Thanks, noted.';
  };
  const config = { ...baseConfig, telegramToken: '', adminPassword: 'pw', intakeSecret: 's', databaseUrl: '' };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: llm, debounceMs: 0, log: silent });
  await app.settings.update({ business: { creator_notes: 'NEVER quote a fee. Gifting addresses stay with the team.' } });
  const lead = await say(app, "I'm a lifestyle creator with 60k followers, @meeraloves in Pune, I want paid campaigns");
  assert.strictEqual(lead.stage, 'human');
  assert.strictEqual(lead.property, '@meeraloves, 60k followers, skincare, Pune');
  assert.strictEqual(lead.scope, 'paid campaigns');
  assert.ok(seen.some((s) => /APPROVED CREATOR AND INFLUENCER NOTES/.test(s) && /NEVER quote a fee/.test(s)), 'the approved creator notes reach the prompt');
  assert.ok(seen.some((s) => /You now have what you need: thank them/.test(s)), 'with everything collected the assistant wraps up');
});

test('someone who says they manage creators is routed to the BD team', async () => {
  const { app } = await boot(null);
  const lead = await say(app, 'Hello, I manage a few fashion creators, would you be open to working with them?');
  assert.strictEqual(lead.stage, 'human');
  assert.match(lead.stage_reason, /Manager or agency/);
});
