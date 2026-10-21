'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { createServer } = require('../core/server');
const baseConfig = require('../core/config');

const silent = { log() {}, warn() {}, error() {} };

async function boot({ accountId = '555' } = {}) {
  const config = {
    ...baseConfig, telegramToken: '', adminPassword: 'studio-pw', crmPassword: 'client-pw', intakeSecret: 's',
    instagram: { accessToken: 'OLD_ENV', appSecret: 'sec', appId: '123', verifyToken: '', handle: '', apiVersion: 'v23.0', accountId, forward: {} },
  };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: async () => ({ refused: [] }), debounceMs: 0, log: silent });
  const calls = [];
  app.instagram.fetch = async (url, init = {}) => {
    const u = String(url); calls.push(u);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.includes('api.instagram.com/oauth/access_token')) return ok({ access_token: 'SHORT' });
    if (u.includes('ig_exchange_token')) return ok({ access_token: 'LONG', expires_in: 5184000 });
    if (u.includes('/me')) return ok(u.includes('access_token=LONG') || (init.headers && init.headers.Authorization === 'Bearer LONG') ?{ user_id: '555', username: 'interioarty' } : { error: { message: 'Error validating access token: session invalidated', code: 190 } });
    if (u.includes('subscribed_apps')) return ok({ success: true });
    return ok({});
  };
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/crm-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'client-pw' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = (path, withCookie = true) => fetch(`${base}${path}`, { redirect: 'manual', headers: withCookie ? { cookie } : {} });
  return { app, server, get, calls };
}

test('a dead token shows as disconnected, and Connect Instagram brings it back without a redeploy', async () => {
  const { app, server, get } = await boot();
  try {
    let s = await (await get('/api/crm/instagram')).json();
    assert.strictEqual(s.connected, false, 'the old token is refused by Instagram');
    assert.strictEqual(s.can_connect, true);

    const start = await get('/api/crm/instagram/connect');
    assert.strictEqual(start.status, 302);
    const to = new URL(start.headers.get('location'));
    assert.strictEqual(to.origin + to.pathname, 'https://www.instagram.com/oauth/authorize');
    assert.strictEqual(to.searchParams.get('client_id'), '123');
    assert.match(to.searchParams.get('redirect_uri'), /\/crm\/instagram\/callback$/);
    assert.match(to.searchParams.get('scope'), /instagram_business_manage_messages/);
    const state = to.searchParams.get('state');

    const back = await get(`/crm/instagram/callback?code=abc%23_&state=${encodeURIComponent(state)}`, false);
    assert.strictEqual(back.status, 302);
    assert.strictEqual(back.headers.get('location'), '/crm?ig=connected');
    assert.strictEqual(await app.store.kvGet('ig_token', null), 'LONG');

    app.instagram.probed = null;
    s = await (await get('/api/crm/instagram')).json();
    assert.strictEqual(s.connected, true);
    assert.strictEqual(s.username, 'interioarty');
    assert.ok(s.days_left >= 59);
  } finally { server.close(); }
});

test('Connect refuses a forged or stale state, and the wrong Instagram account', async () => {
  const { app, server, get } = await boot({ accountId: '999' });
  try {
    assert.strictEqual((await get('/crm/instagram/callback?code=x&state=bogus', false)).headers.get('location'), '/crm?ig=expired');
    assert.strictEqual((await get('/crm/instagram/callback?error=access_denied&state=x', false)).headers.get('location'), '/crm?ig=denied');
    const state = new URL((await get('/api/crm/instagram/connect')).headers.get('location')).searchParams.get('state');
    const wrong = await get(`/crm/instagram/callback?code=abc&state=${encodeURIComponent(state)}`, false);
    assert.match(wrong.headers.get('location'), /^\/crm\?ig=failed&m=/);
    assert.strictEqual(await app.store.kvGet('ig_token', null), null, 'a different account never replaces the studio token');
  } finally { server.close(); }
});

test('the connect routes need the studio sign-in', async () => {
  const { server, get } = await boot();
  try {
    assert.strictEqual((await get('/api/crm/instagram', false)).status, 401);
    assert.strictEqual((await get('/api/crm/instagram/connect', false)).status, 401);
  } finally { server.close(); }
});
