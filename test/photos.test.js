'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { createServer } = require('../core/server');
const { Llm } = require('../core/llm');
const baseConfig = require('../core/config');

const silent = { log() {}, warn() {}, error() {} };
const IG_ID = '17841400000000001';
// a few recognisable bytes standing in for a JPEG
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('pretend-this-is-a-living-room-photo'), Buffer.from([0xff, 0xd9])]);
const PHOTO_URL = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=123&signature=abc';

async function boot({ visionFails = false, imageOk = true } = {}) {
  const graph = [];
  const downloads = [];
  const visions = [];
  const fetchImpl = async (url, init = {}) => {
    if (/lookaside\.fbsbx\.com/.test(url)) {
      downloads.push(url);
      if (!imageOk) return { ok: false, status: 404, headers: { get: () => '' }, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => PHOTO.buffer.slice(PHOTO.byteOffset, PHOTO.byteOffset + PHOTO.length) };
    }
    graph.push({ url, body: init.body ? JSON.parse(init.body) : null });
    let data = { message_id: 'm_out' };
    if (/\/me\?/.test(url)) data = { user_id: IG_ID, username: 'studio' };
    else if (/\/\d+\?fields=name/.test(url)) data = { name: 'Atharva Singh', username: 'atharva' };
    return { ok: true, status: 200, json: async () => data };
  };
  const llm = async (o) => {
    const sys = o.system || '';
    if (o.vision) {
      visions.push(o);
      if (visionFails) throw new Error('vision model unavailable');
      assert.ok(o.image && Buffer.isBuffer(Buffer.from(o.image.bytes)) && o.image.mime === 'image/jpeg', 'the picture itself is handed to the vision model');
      return 'A bright living room with a grey sofa, oak flooring and large windows.';
    }
    if (sys.includes('You extract structured facts')) return { refused: [] };
    // the reply model sees the photo only as text; echo what it was told so the test can check it
    const photoLine = (o.messages || []).map((m) => m.content).find((c) => /^\[Photo\]/.test(c));
    return photoLine ? `Lovely light in that room, the oak floor works well with a grey sofa.` : 'Thanks, noted.';
  };
  const config = {
    ...baseConfig, telegramToken: '', adminPassword: 'pw', intakeSecret: 's',
    instagram: { accessToken: 'tok', appSecret: 'appsecret', verifyToken: 'v', handle: 'studio', apiVersion: 'v23.0', accountId: IG_ID, forward: {} },
  };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: llm, fetchImpl, debounceMs: 0, log: silent });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { app, graph, downloads, visions, server, base, cookie };
}

const photoEvent = (sender, mid, attachments) => ({ object: 'instagram', entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid, attachments } }] }] });
const replies = (graph) => graph.filter((g) => /\/me\/messages$/.test(g.url) && g.body && g.body.message);
const settle = async (app) => { await new Promise((r) => setTimeout(r, 60)); await app.engine.settle(); };

test('a photo is downloaded, looked at, stored, answered, and shown in both inboxes exactly as sent', async () => {
  const { app, graph, downloads, visions, server, base, cookie } = await boot();
  try {
    await app.instagram.handleWebhook(photoEvent('7001', 'mid.p1', [{ type: 'image', payload: { url: PHOTO_URL } }]));
    await settle(app);
    assert.deepStrictEqual(downloads, [PHOTO_URL]);
    assert.strictEqual(visions.length, 1);

    const lead = await app.store.getLeadByChat('ig:7001');
    const msgs = await app.store.getMessages(lead.id);
    const inbound = msgs.find((m) => m.direction === 'in');
    assert.match(inbound.text, /^\[Photo\] A bright living room with a grey sofa/);
    const out = msgs.find((m) => m.direction === 'out');
    assert.match(out.text, /Lovely light in that room/, 'the reply is about what is in the photo');
    assert.ok(replies(graph).some((g) => /Lovely light/.test(g.body.message.text)), 'and it was actually sent');

    // the picture itself is kept, byte for byte
    const idx = await app.store.mediaIndex([lead.id]);
    const mediaId = idx.get(Number(inbound.id));
    assert.ok(mediaId);
    const stored = await app.store.getMedia(mediaId);
    assert.ok(Buffer.compare(stored.data, PHOTO) === 0, 'identical bytes');
    assert.strictEqual(stored.mime, 'image/jpeg');

    // the studio's Lead Inbox shows that picture in the chat
    const crm = await (await fetch(`${base}/api/crm/leads`, { headers: { cookie } })).json();
    const item = crm.leads[0].transcript.find((t) => t.image);
    assert.strictEqual(item.image, `/api/media/${mediaId}`);
    assert.match(item.content, /^\[Photo\]/);
    // ...and the console's lead view marks the same message
    const detail = await (await fetch(`${base}/api/leads/${lead.id}`, { headers: { cookie } })).json();
    assert.strictEqual(detail.messages.find((m) => m.id === inbound.id).media_id, mediaId);

    // the picture is served with its own type, to signed-in staff only
    const img = await fetch(`${base}/api/media/${mediaId}`, { headers: { cookie } });
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');
    assert.ok(Buffer.compare(Buffer.from(await img.arrayBuffer()), PHOTO) === 0);
    assert.strictEqual((await fetch(`${base}/api/media/${mediaId}`)).status, 401);
  } finally { server.close(); }
});

test('if the vision model is down the photo is still kept, the team is told, and the assistant asks what it shows', async () => {
  const { app, server } = await boot({ visionFails: true });
  try {
    await app.instagram.handleWebhook(photoEvent('7002', 'mid.p2', [{ type: 'image', payload: { url: PHOTO_URL } }]));
    await settle(app);
    const lead = await app.store.getLeadByChat('ig:7002');
    const inbound = (await app.store.getMessages(lead.id)).find((m) => m.direction === 'in');
    assert.match(inbound.text, /could not be analysed/);
    assert.ok((await app.store.mediaIndex([lead.id])).has(Number(inbound.id)), 'the picture is stored anyway');
    assert.ok((await app.store.getEvents(lead.id)).some((e) => e.type === 'vision_failed'));
  } finally { server.close(); }
});

test('only Meta image hosts are downloaded, and a failed download falls back to the polite reply', async () => {
  const a = await boot();
  try {
    await a.app.instagram.handleWebhook(photoEvent('7003', 'mid.p3', [{ type: 'image', payload: { url: 'https://evil.example.com/steal.jpg' } }]));
    await settle(a.app);
    assert.deepStrictEqual(a.downloads, [], 'a foreign address is never fetched');
    assert.strictEqual(await a.app.instagram.fetchImage('http://lookaside.fbsbx.com/x'), null, 'https only');
    assert.strictEqual(await a.app.instagram.fetchImage('https://lookaside.fbsbx.com.evil.io/x'), null, 'not a lookalike host');
  } finally { a.server.close(); }
  const b = await boot({ imageOk: false });
  try {
    await b.app.instagram.handleWebhook(photoEvent('7004', 'mid.p4', [{ type: 'image', payload: { url: PHOTO_URL } }]));
    await settle(b.app);
    const lead = await b.app.store.getLeadByChat('ig:7004');
    const texts = (await b.app.store.getMessages(lead.id)).map((m) => m.text);
    assert.ok(texts.includes('[sent a photo]'));
    assert.ok(texts.some((t) => /cannot open attachments/.test(t)));
  } finally { b.server.close(); }
});

test('Instagram redelivering the same photo does not run the vision model or store it twice', async () => {
  const { app, visions, server } = await boot();
  try {
    const ev = photoEvent('7005', 'mid.p5', [{ type: 'image', payload: { url: PHOTO_URL } }]);
    await app.instagram.handleWebhook(ev);
    await app.instagram.handleWebhook(ev);
    await settle(app);
    assert.strictEqual(visions.length, 1);
    const lead = await app.store.getLeadByChat('ig:7005');
    assert.strictEqual((await app.store.mediaIndex([lead.id])).size, 1);
  } finally { server.close(); }
});

test('deleting a lead deletes its pictures', async () => {
  const { app, server } = await boot();
  try {
    await app.instagram.handleWebhook(photoEvent('7006', 'mid.p6', [{ type: 'image', payload: { url: PHOTO_URL } }]));
    await settle(app);
    const lead = await app.store.getLeadByChat('ig:7006');
    await app.store.deleteLead(lead.id);
    assert.strictEqual((await app.store.get('SELECT COUNT(*) c FROM media')).c, 0);
  } finally { server.close(); }
});

test('the vision call sends the picture as a data URL, and fails over to the next account when one is out of quota', async () => {
  const calls = [];
  const cfg = {
    apiKey: 'a', baseUrl: 'http://one', model: 'm', fallbackModel: '', maxRpm: 0, tpm: 0, timeoutMs: 5000,
    providers: [
      { name: 'cloudflare', baseUrl: 'http://one', apiKey: 'a', models: ['m'], visionModels: ['vision-x'], tpm: 0 },
      { name: 'cloudflare-2', baseUrl: 'http://two', apiKey: 'b', models: ['m'], visionModels: ['vision-x'], tpm: 0 },
    ],
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (/one/.test(url)) return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'you have used up your daily free allocation' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A kitchen.' } }], usage: { prompt_tokens: 900, completion_tokens: 8, total_tokens: 908 } }) };
  };
  const llm = new Llm(cfg, { fetchImpl });
  assert.strictEqual(await llm.vision({ prompt: 'what is it?', image: { mime: 'image/png', bytes: Buffer.from('abc') } }), 'A kitchen.');
  const part = calls[0].body.messages[0].content;
  assert.strictEqual(part[0].text, 'what is it?');
  assert.strictEqual(part[1].image_url.url, `data:image/png;base64,${Buffer.from('abc').toString('base64')}`);
  assert.strictEqual(calls[0].body.model, 'vision-x');
  assert.ok(/two/.test(calls[1].url), 'second account used');
  await assert.rejects(() => new Llm({ ...cfg, providers: [{ ...cfg.providers[0], visionModels: [] }] }, { fetchImpl }).vision({ prompt: 'x', image: { mime: 'image/png', bytes: Buffer.from('a') } }), /No vision model/);
});
