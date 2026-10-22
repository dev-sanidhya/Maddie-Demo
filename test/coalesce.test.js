'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const baseConfig = require('../core/config');

const silent = { log() {}, warn() {}, error() {} };

test('a message that arrives while the reply is being written is answered together with the first, in one reply', async () => {
  const seen = [];
  let app;
  let injected = false;
  const llm = async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) return {};
    // the first reply is being written: the customer sends a second message right now
    if (!injected) { injected = true; await app.engine.receive({ channel: 'telegram', chatId: 'tg-1', text: 'and what do you charge for PR?' }); }
    seen.push((o.messages || []).map((m) => m.content).join('\n'));
    return 'Happy to help with both.';
  };
  const config = { ...baseConfig, telegramToken: '', adminPassword: 'pw', intakeSecret: 's', databaseUrl: '' };
  app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: llm, debounceMs: 0, log: silent });
  await app.engine.receive({ channel: 'telegram', chatId: 'tg-1', text: 'hi, we want an influencer campaign' });
  await app.engine.settle();
  const out = (await app.store.all("SELECT * FROM messages WHERE direction='out'")).filter((m) => m.role === 'assistant');
  assert.strictEqual(out.length, 1, 'exactly one reply for the two messages');
  const last = seen[seen.length - 1];
  assert.ok(/influencer campaign/.test(last) && /what do you charge/.test(last), 'the single reply was written from both messages');
});
