'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { createServer } = require('../core/server');
const { PhotoStore, PATH_OK } = require('../core/storage');
const baseConfig = require('../core/config');

const silent = { log() {}, warn() {}, error() {} };
const IG_ID = '17841400000000002';
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a-photo-that-lives-in-supabase-storage'), Buffer.from([0xff, 0xd9])]);
const SB = 'https://project.supabase.co';

async function boot({ uploadStatus = 200, missingOnRead = false } = {}) {
  const uploads = [];
  const files = new Map();
  const fetchImpl = async (url, init = {}) => {
    if (/lookaside\.fbsbx\.com/.test(url)) return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => PHOTO.buffer.slice(PHOTO.byteOffset, PHOTO.byteOffset + PHOTO.length) };
    if (url.startsWith(`${SB}/storage/v1/object/public/`)) {
      const f = files.get(url.split('/public/')[1]);
      if (!f || missingOnRead) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, arrayBuffer: async () => f.buffer.slice(f.byteOffset, f.byteOffset + f.length) };
    }
    if (url.startsWith(`${SB}/storage/v1/object/`)) {
      uploads.push({ url, headers: init.headers, size: init.body.length });
      if (uploadStatus === 200) files.set(url.split('/object/')[1], Buffer.from(init.body));
      return { ok: uploadStatus === 200, status: uploadStatus, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ message_id: 'm_out', user_id: IG_ID, name: 'Atharva', username: 'atharva' }) };
  };
  const llm = async (o) => {
    if (o.vision) return 'A living room with a grey sofa and oak flooring.';
    if ((o.system || '').includes('You extract structured facts')) return { refused: [] };
    return 'Lovely room.';
  };
  const config = {
    ...baseConfig, telegramToken: '', adminPassword: 'pw', intakeSecret: 's',
    instagram: { accessToken: 'tok', appSecret: 'x', verifyToken: 'v', handle: 'studio', apiVersion: 'v23.0', accountId: IG_ID, forward: {} },
    storage: { url: SB, key: 'anon-key', bucket: 'studio-photos' },
  };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: llm, fetchImpl, debounceMs: 0, log: silent });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  return { app, uploads, files, server, base, cookie: login.headers.get('set-cookie').split(';')[0] };
}
const send = async (app, sender, mid) => {
  await app.instagram.handleWebhook({ object: 'instagram', entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid, attachments: [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/a.jpg' } }] } }] }] });
  await new Promise((r) => setTimeout(r, 60)); await app.engine.settle();
};

test('a photo goes to Supabase Storage, not the database, and is served back to staff only', async () => {
  const { app, uploads, server, base, cookie } = await boot();
  try {
    await send(app, '8001', 'mid.s1');
    assert.strictEqual(uploads.length, 1);
    const up = uploads[0];
    assert.match(up.url, /\/storage\/v1\/object\/studio-photos\/\d+\/[0-9a-f]{32}\.jpg$/);
    assert.ok(PATH_OK.test(up.url.split('/studio-photos/')[1]), 'the name fits the only pattern the storage rule allows');
    assert.strictEqual(up.headers['Content-Type'], 'image/jpeg');
    assert.strictEqual(up.headers.apikey, 'anon-key');
    assert.strictEqual(up.headers['x-upsert'], 'false');

    const lead = await app.store.getLeadByChat('ig:8001');
    const row = await app.store.get('SELECT * FROM media WHERE lead_id=?', lead.id);
    assert.strictEqual(row.data, null, 'nothing is stored in the database');
    assert.match(row.storage_path, PATH_OK);

    const img = await fetch(`${base}/api/media/${row.id}`, { headers: { cookie } });
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');
    assert.ok(Buffer.compare(Buffer.from(await img.arrayBuffer()), PHOTO) === 0, 'identical bytes through the app');
    assert.strictEqual((await fetch(`${base}/api/media/${row.id}`)).status, 401, 'no login, no photo');

    const crm = await (await fetch(`${base}/api/crm/leads`, { headers: { cookie } })).json();
    const shown = crm.leads[0].transcript.find((t) => t.image);
    assert.strictEqual(shown.image, `/api/media/${row.id}`);
    assert.ok(!JSON.stringify(crm).includes('supabase.co'), 'the storage address is never sent to the browser');
  } finally { server.close(); }
});

test('if storage refuses or is unreachable the photo is kept in the database instead, and still shows', async () => {
  const { app, server, base, cookie } = await boot({ uploadStatus: 500 });
  try {
    await send(app, '8002', 'mid.s2');
    const lead = await app.store.getLeadByChat('ig:8002');
    const row = await app.store.get('SELECT * FROM media WHERE lead_id=?', lead.id);
    assert.ok(row.data && row.data.length > 10, 'bytes are in the database');
    assert.strictEqual(row.storage_path, null);
    const img = await fetch(`${base}/api/media/${row.id}`, { headers: { cookie } });
    assert.ok(Buffer.compare(Buffer.from(await img.arrayBuffer()), PHOTO) === 0);
  } finally { server.close(); }
});

test('a photo that has gone missing from storage is a clean 404, not a crash', async () => {
  const { app, server, base, cookie } = await boot({ missingOnRead: true });
  try {
    await send(app, '8003', 'mid.s3');
    const lead = await app.store.getLeadByChat('ig:8003');
    const row = await app.store.get('SELECT * FROM media WHERE lead_id=?', lead.id);
    assert.strictEqual((await fetch(`${base}/api/media/${row.id}`, { headers: { cookie } })).status, 404);
  } finally { server.close(); }
});

test('the storage client only touches well-formed paths and supported image types', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(url); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) }; };
  const ps = new PhotoStore({ url: SB, key: 'k', bucket: 'b' }, { fetchImpl, log: silent });
  assert.strictEqual(await ps.get('../../etc/passwd'), null);
  assert.strictEqual(await ps.get('12/short.jpg'), null);
  assert.strictEqual(await ps.get('12/0123456789abcdef0123456789abcdef.exe'), null);
  assert.deepStrictEqual(calls, [], 'bad paths never reach the network');
  assert.ok(await ps.get('12/0123456789abcdef0123456789abcdef.png'));
  assert.strictEqual(await ps.put(5, 'image/heic', Buffer.from('x')), null, 'a type the bucket does not allow stays in the database');
  assert.strictEqual(await new PhotoStore({}, { fetchImpl }).put(5, 'image/jpeg', Buffer.from('x')), null, 'storage off means database');
  assert.match(await ps.put(5, 'image/webp', Buffer.from('x')), /^5\/[0-9a-f]{32}\.webp$/);
});
