'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { createServer } = require('../core/server');
const baseConfig = require('../core/config');

const silent = { log() {}, warn() {}, error() {} };
const SECRET = 'shared-meta-app-secret';
const A_ID = '111000111';
const B_ID = '222000222';

// Two client accounts, one Meta app: one webhook address receives both accounts' events.
async function deployment(name, id, token, forward = {}) {
  const graph = [];
  const realFetch = globalThis.fetch;
  const fetchImpl = async (url, init = {}) => {
    if (/graph\.instagram\.com/.test(url)) {
      graph.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers && init.headers.Authorization });
      let data = { message_id: 'm_out' };
      if (/\/me\?/.test(url)) data = { user_id: id, username: name.toLowerCase() };
      else if (/\/\d+\?fields=name/.test(url)) data = { name: 'Some Customer', username: 'cust' };
      return { ok: true, status: 200, json: async () => data };
    }
    return realFetch(url, init); // forwarding between deployments is real HTTP
  };
  const llm = async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) return { refused: [] };
    return `Welcome to ${name}.`;
  };
  const config = {
    ...baseConfig, telegramToken: '', adminPassword: `pw-${name}`, intakeSecret: `s-${name}`,
    instagram: { accessToken: token, appSecret: SECRET, verifyToken: 'v', handle: name.toLowerCase(), apiVersion: 'v23.0', accountId: id, forward },
  };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: llm, fetchImpl, debounceMs: 0, log: silent });
  await app.settings.update({ business: { name } });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  return { app, graph, server, url: `http://127.0.0.1:${server.address().port}/webhook/instagram` };
}

const entry = (id, sender, text, mid) => ({ id, time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id }, timestamp: Date.now(), message: { mid, text } }] });
const sign = (body) => `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
const post = (url, payload) => { const body = JSON.stringify(payload); return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(body) }, body }); };
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 40)); } return false; };
const sentBy = (d) => d.graph.filter((g) => g.body && g.body.message);

test('one webhook address, two client accounts: each account is handled only by its own deployment', async () => {
  const B = await deployment('Interioarty', B_ID, 'token-B');
  const A = await deployment('Aperture', A_ID, 'token-A', { [B_ID]: B.url });
  try {
    // one batch from Meta with a message for each account, plus one for an account nobody owns
    const res = await post(A.url, { object: 'instagram', entry: [entry(A_ID, '9001', 'hello aperture', 'mid.a1'), entry(B_ID, '9002', 'hello interioarty', 'mid.b1'), entry('999', '9003', 'who am I', 'mid.x1')] });
    assert.strictEqual(res.status, 200);

    assert.ok(await until(async () => (await A.app.store.getLeadByChat('ig:9001')) && (await B.app.store.getLeadByChat('ig:9002'))), 'both leads were created');
    assert.ok(await until(() => sentBy(A).length >= 1 && sentBy(B).length >= 1), 'both replied');
    await A.app.engine.settle(); await B.app.engine.settle();

    // separate data: neither deployment saw the other's customer, and nobody saw the stranger
    assert.strictEqual(await A.app.store.getLeadByChat('ig:9002'), null);
    assert.strictEqual(await B.app.store.getLeadByChat('ig:9001'), null);
    assert.strictEqual(await A.app.store.getLeadByChat('ig:9003'), null);
    assert.strictEqual(await B.app.store.getLeadByChat('ig:9003'), null);

    // separate behaviour and credentials: each replied with its own persona using its own token
    assert.ok(sentBy(A).every((g) => g.auth === 'Bearer token-A' && /Aperture/.test(g.body.message.text) && g.body.recipient.id === '9001'));
    assert.ok(sentBy(B).every((g) => g.auth === 'Bearer token-B' && /Interioarty/.test(g.body.message.text) && g.body.recipient.id === '9002'));
  } finally { A.server.close(); B.server.close(); }
});

test('a forged event is refused, also when sent straight to the second deployment', async () => {
  const B = await deployment('Interioarty', B_ID, 'token-B');
  try {
    const body = JSON.stringify({ object: 'instagram', entry: [entry(B_ID, '9100', 'forged', 'mid.f1')] });
    const res = await fetch(B.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' }, body });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(await B.app.store.getLeadByChat('ig:9100'), null);
  } finally { B.server.close(); }
});

test('with no account id or forwarding configured, behaviour is unchanged (every event is handled locally)', async () => {
  const config = { ...baseConfig, telegramToken: '', instagram: { accessToken: 't', appSecret: SECRET, verifyToken: 'v', handle: 'x', apiVersion: 'v23.0' } };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: async () => ({ refused: [] }), debounceMs: 0, log: silent });
  const { targets, local } = app.instagram.split({ entry: [{ id: '1' }, { id: '2' }] });
  assert.deepStrictEqual(targets, []);
  assert.strictEqual(local.entry.length, 2);
});

test('the forward list ignores anything that is not a numeric id mapped to an https address', () => {
  const prev = process.env.INSTAGRAM_FORWARD;
  process.env.INSTAGRAM_FORWARD = JSON.stringify({ '123': 'https://ok.example/webhook/instagram', abc: 'https://x', '456': 'http://insecure.example' });
  const path = require.resolve('../core/config');
  delete require.cache[path];
  const cfg = require('../core/config');
  assert.deepStrictEqual(cfg.instagram.forward, { '123': 'https://ok.example/webhook/instagram' });
  if (prev === undefined) delete process.env.INSTAGRAM_FORWARD; else process.env.INSTAGRAM_FORWARD = prev;
  delete require.cache[path];
});
