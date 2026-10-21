'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../core/db');
const { Instagram } = require('../core/instagram');

const silent = { log() {}, warn() {}, error() {} };
const make = async (accessToken, store) => new Instagram({ cfg: { accessToken, apiVersion: 'v23.0' }, engine: {}, store, config: {}, log: silent, fetchImpl: async () => ({}) });

test('a token pasted into the environment replaces a stale refreshed one', async () => {
  const store = await Store.open({ file: ':memory:' });
  // The old environment token was refreshed, so its refreshed copy is stored with the old token's fingerprint.
  const old = await make('OLD_ENV_TOKEN', store);
  await store.kvSet('ig_token', 'REFRESHED_FROM_OLD');
  old.fetch = async () => ({ ok: true, json: async () => ({ access_token: 'REFRESHED_FROM_OLD', expires_in: 5184000 }) });
  await old.refreshToken({ force: true });
  assert.strictEqual(await old.loadToken({ maxAgeMs: 0 }), 'REFRESHED_FROM_OLD', 'same environment token: the refreshed copy is used');

  const fresh = await make('NEW_ENV_TOKEN', store);
  assert.strictEqual(await fresh.loadToken({ maxAgeMs: 0 }), 'NEW_ENV_TOKEN', 'new environment token wins over the stale stored one');
});

test('stored tokens written before the fingerprint existed stay trusted', async () => {
  const store = await Store.open({ file: ':memory:' });
  await store.kvSet('ig_token', 'LEGACY_REFRESHED');
  await store.kvSet('ig_token_info', { refreshedAt: 1, expiresAt: 2 });
  const ig = await make('ENV_TOKEN', store);
  assert.strictEqual(await ig.loadToken({ maxAgeMs: 0 }), 'LEGACY_REFRESHED');
});
