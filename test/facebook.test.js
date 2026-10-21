'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const baseConfig = require('../core/config');
const { plan } = require('../core/followups');

const silent = { log() {}, warn() {}, error() {} };
const PAGE = '110200000000000';

async function build() {
  const graph = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    graph.push({ url: String(url), method: init.method, body });
    let data = { message_id: 'm_out', recipient_id: 'x' };
    if (/\/me\?/.test(url)) data = { id: PAGE, name: 'InterioArty' };
    else if (/\/\d+\?/.test(url)) data = { first_name: 'Riya', last_name: 'Kapoor' };
    return { ok: true, status: 200, json: async () => data };
  };
  const llmOverride = async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) return { refused: [] };
    return 'Hi Riya, thanks for messaging. What kind of space are you planning?';
  };
  const config = {
    ...baseConfig, telegramToken: '', demoMode: true, adminPassword: 'pw', intakeSecret: 's3cret',
    facebook: { accessToken: 'PAGE_TOKEN', appSecret: 'fbsecret', verifyToken: 'verify-fb', pageId: PAGE, handle: '', apiVersion: 'v23.0', forward: {} },
  };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride, fetchImpl, debounceMs: 0, log: silent });
  return { app, graph };
}

const msgEvent = (sender, text, mid) => ({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid, text } }] }] });
const settle = async (app, id) => { await app.engine.idle(id); await new Promise((r) => setTimeout(r, 30)); await app.engine.idle(id); };

test('a Messenger message becomes a Facebook lead and gets a reply through the Page token', async () => {
  const { app, graph } = await build();
  await app.facebook.handleWebhook(msgEvent('7001', 'Hi, I need a modular kitchen', 'mid.fb1'));
  const lead = await app.store.getLeadByChat('fb:7001');
  assert.ok(lead, 'the lead is stored under fb:<psid>');
  assert.strictEqual(lead.channel, 'facebook');
  assert.strictEqual(lead.name, 'Riya');
  await settle(app, lead.id);
  const sent = graph.filter((g) => /\/me\/messages/.test(g.url) && g.body && g.body.message);
  assert.strictEqual(sent.length, 1, 'one reply went out');
  assert.match(sent[0].url, /^https:\/\/graph\.facebook\.com\/v23\.0\/me\/messages\?access_token=PAGE_TOKEN/);
  assert.strictEqual(sent[0].body.recipient.id, '7001');
  assert.strictEqual(sent[0].body.messaging_type, 'RESPONSE', 'Messenger needs a messaging_type on every send');
  const rows = await app.store.all('SELECT direction, status FROM messages WHERE lead_id = ?', lead.id);
  assert.deepStrictEqual(rows.map((r) => `${r.direction}:${r.status}`), ['in:received', 'out:sent']);
});

test('read receipts and the Page\'s own messages are ignored, and other Pages are dropped', async () => {
  const { app, graph } = await build();
  await app.facebook.handleWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: '7002' }, recipient: { id: PAGE }, read: { watermark: 1 } }] }] });
  await app.facebook.handleWebhook({ object: 'page', entry: [{ id: PAGE, messaging: [{ sender: { id: PAGE }, recipient: { id: '7002' }, message: { mid: 'm.echo', text: 'from us', is_echo: true } }] }] });
  assert.strictEqual(await app.store.getLeadByChat('fb:7002'), null, 'no lead from a read receipt or an echo');
  assert.strictEqual(graph.filter((g) => /\/7002/.test(g.url)).length, 0, 'no profile lookups for them either');
  const { local } = app.facebook.split({ object: 'page', entry: [{ id: '999', messaging: [] }, { id: PAGE, messaging: [] }] });
  assert.deepStrictEqual(local.entry.map((e) => e.id), [PAGE]);
});

test('webhook signatures use the Facebook app secret, and the 24 hour window applies to Messenger', async () => {
  const { app } = await build();
  const raw = Buffer.from(JSON.stringify(msgEvent('7003', 'hi', 'mid.s')));
  const good = `sha256=${crypto.createHmac('sha256', 'fbsecret').update(raw).digest('hex')}`;
  assert.strictEqual(app.facebook.validSignature(raw, good), true);
  assert.strictEqual(app.facebook.validSignature(raw, 'sha256=00'), false);
  assert.strictEqual(app.facebook.verifyChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-fb', 'hub.challenge': '7' })), '7');

  await app.facebook.handleWebhook(msgEvent('7004', 'hello', 'mid.w'));
  const lead = await app.store.getLeadByChat('fb:7004');
  await settle(app, lead.id);
  const old = { ...lead, last_inbound_at: Date.now() - 30 * 3600000 };
  await assert.rejects(() => app.facebook.sendText(old, 'late hello'), /24 hour/);
  // follow-ups clamp to the window like Instagram's, instead of chasing a closed window
  const p = plan({ ...lead, last_outbound_at: Date.now() - 9 * 3600000, last_inbound_at: Date.now() - 10 * 3600000 }, app.settings.get(), Date.now());
  assert.ok(p === null || p.kind !== 'followup' || p.at < Date.now() + 14 * 3600000);
});
