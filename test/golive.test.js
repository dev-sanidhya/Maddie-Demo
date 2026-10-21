'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { createServer } = require('../core/server');
const { Scheduler } = require('../core/scheduler');
const { PhotoStore } = require('../core/storage');
const baseConfig = require('../core/config');

const silent = { log() {}, warn() {}, error() {} };
const SB = 'https://project.supabase.co';
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('studio-photo'), Buffer.from([0xff, 0xd9])]);
const DAY = 86400000;

async function boot({ purgeStatus = 200, crm = true } = {}) {
  const purges = [];
  const files = new Set();
  const fetchImpl = async (url, init = {}) => {
    if (url === `${SB}/functions/v1/purge-photos`) {
      const body = JSON.parse(init.body);
      purges.push({ headers: init.headers, body });
      if (purgeStatus === 200) body.paths.forEach((p) => files.delete(`${body.bucket}/${p}`));
      return { ok: purgeStatus === 200, status: purgeStatus, json: async () => (purgeStatus === 200 ? { removed: body.paths.length } : { error: 'boom' }) };
    }
    if (url.startsWith(`${SB}/storage/v1/object/public/`)) {
      return files.has(url.split('/public/')[1]) ? { ok: true, status: 200, arrayBuffer: async () => PHOTO.buffer.slice(PHOTO.byteOffset, PHOTO.byteOffset + PHOTO.length) } : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const config = {
    ...baseConfig, telegramToken: '', adminPassword: 'admin-pw', intakeSecret: 's', crmPassword: crm ? 'studio-pw' : '',
    instagram: { accessToken: '', appSecret: '', verifyToken: '', handle: '', apiVersion: 'v23.0' },
    storage: { url: SB, key: 'anon', bucket: 'studio-photos', purgeSecret: 'purge-secret' },
  };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: async () => ({ refused: [] }), fetchImpl, debounceMs: 0, log: silent });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (path, password) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const as = (cookie) => (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}), cookie } });
  // a lead with one stored photo of a given age
  const addPhoto = async (name, ageDays, n = 1) => {
    const lead = await app.store.createLead({ channel: 'instagram', chat_id: `ig:${name}`, name, source: 'instagram', meta: { turns: 1 } });
    const ids = [];
    for (let i = 0; i < n; i++) {
      const mid = await app.store.addMessage({ lead_id: lead.id, direction: 'in', role: 'user', text: `[Photo] a room ${i}`, status: 'received', processed: true });
      const path = `${lead.id}/${(name + i).replace(/\W/g, '').padEnd(32, 'a').slice(0, 32).replace(/[^0-9a-f]/g, 'a')}.jpg`;
      files.add(`studio-photos/${path}`);
      const id = await app.store.addMedia({ lead_id: lead.id, message_id: mid, mime: 'image/jpeg', path });
      await app.store.run('UPDATE media SET created_at=? WHERE id=?', Date.now() - ageDays * DAY, id);
      ids.push({ id, path });
    }
    return { lead, ids };
  };
  return { app, server, base, purges, files, login, as, addPhoto };
}

test('the studio password opens the Lead Inbox and nothing else', async () => {
  const { app, server, base, login, as, addPhoto } = await boot();
  try {
    const { ids } = await addPhoto('Riya', 1);
    assert.strictEqual((await login('/api/crm-login', 'wrong')).status, 401);
    const studio = await login('/api/crm-login', 'studio-pw');
    assert.strictEqual(studio.status, 200);
    const api = as(studio.cookie);

    // what the inbox needs
    assert.strictEqual((await api('/api/crm/leads')).status, 200);
    assert.strictEqual((await api(`/api/media/${ids[0].id}`)).status, 200);
    const lead = (await (await api('/api/crm/leads')).json()).leads[0];
    assert.strictEqual((await api(`/api/crm/leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'contacted' }) })).status, 200);

    // everything else in the admin stays locked
    for (const [method, path] of [['GET', '/api/leads'], ['GET', `/api/leads/${lead.id}`], ['GET', '/api/settings'], ['GET', '/api/bootstrap'], ['GET', '/api/stats'], ['GET', '/api/export.csv'], ['DELETE', `/api/leads/${lead.id}`], ['PUT', '/api/settings'], ['POST', '/api/scheduler/run'], ['POST', '/api/demo/wipe'], ['POST', `/api/leads/${lead.id}/message`], ['GET', '/api/designers']]) {
      assert.strictEqual((await api(path, { method, body: method === 'GET' ? undefined : '{}' })).status, 401, `${method} ${path} must stay admin-only`);
    }
    assert.strictEqual((await app.store.getLead(lead.id)).id, lead.id, 'nothing was deleted');

    // the admin password still opens everything, through either door
    const admin = await login('/api/login', 'admin-pw');
    assert.strictEqual((await as(admin.cookie)('/api/settings')).status, 200);
    const viaInbox = await login('/api/crm-login', 'admin-pw');
    assert.strictEqual((await as(viaInbox.cookie)('/api/leads')).status, 200);
    // and the studio password does not work on the admin login
    assert.strictEqual((await login('/api/login', 'studio-pw')).status, 401);
    assert.strictEqual((await fetch(`${base}/api/crm/leads`)).status, 401, 'no cookie, no inbox');
  } finally { server.close(); }
});

test('with no studio password configured, only the admin can sign in', async () => {
  const { server, login } = await boot({ crm: false });
  try {
    assert.strictEqual((await login('/api/crm-login', 'studio-pw')).status, 401);
    assert.strictEqual((await login('/api/crm-login', '')).status, 401);
    assert.strictEqual((await login('/api/crm-login', 'admin-pw')).status, 200);
  } finally { server.close(); }
});

test('the studio can delete a photo: file gone, chat keeps a "photo removed" note, secret and bucket sent correctly', async () => {
  const { app, server, login, as, addPhoto, purges, files } = await boot();
  try {
    const { lead, ids } = await addPhoto('Neha', 2);
    const api = as((await login('/api/crm-login', 'studio-pw')).cookie);
    const r = await api(`/api/media/${ids[0].id}`, { method: 'DELETE' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(purges.length, 1);
    assert.strictEqual(purges[0].headers['x-purge-secret'], 'purge-secret');
    assert.deepStrictEqual(purges[0].body, { bucket: 'studio-photos', paths: [ids[0].path] });
    assert.ok(!files.has(`studio-photos/${ids[0].path}`), 'the file is deleted');
    assert.strictEqual((await api(`/api/media/${ids[0].id}`)).status, 404, 'the photo no longer opens');
    const item = (await (await api('/api/crm/leads')).json()).leads[0].transcript[0];
    assert.strictEqual(item.removed, true);
    assert.strictEqual(item.image, undefined);
    assert.ok((await app.store.getEvents(lead.id)).some((e) => e.type === 'photo_removed'));
    assert.strictEqual((await api(`/api/media/${ids[0].id}`, { method: 'DELETE' })).status, 200, 'deleting twice is harmless');
    assert.strictEqual(purges.length, 1);
  } finally { server.close(); }
});

test('if storage cannot delete, the photo stays visible and the studio is told', async () => {
  const { server, login, as, addPhoto } = await boot({ purgeStatus: 500 });
  try {
    const { ids } = await addPhoto('Aman', 2);
    const api = as((await login('/api/crm-login', 'studio-pw')).cookie);
    assert.strictEqual((await api(`/api/media/${ids[0].id}`, { method: 'DELETE' })).status, 502);
    assert.strictEqual((await api(`/api/media/${ids[0].id}`)).status, 200, 'still there');
  } finally { server.close(); }
});

test('retention: photos older than the limit are deleted automatically, newer ones are kept, and it is off by default', async () => {
  const { app, server, purges, files, addPhoto } = await boot();
  try {
    const old = await addPhoto('Old', 120, 2);
    const fresh = await addPhoto('Fresh', 10);
    const scheduler = new Scheduler({ engine: app.engine, store: app.store, settings: app.settings, log: silent });

    await scheduler.tick();
    assert.strictEqual(purges.length, 0, 'retention is off until a number of days is set');

    await app.settings.update({ retention: { photo_days: 90 } });
    const r = await scheduler.tick();
    assert.strictEqual(r.photos_removed, 2);
    assert.strictEqual(purges.length, 1);
    assert.deepStrictEqual(purges[0].body.paths.sort(), old.ids.map((x) => x.path).sort());
    assert.ok(old.ids.every((x) => !files.has(`studio-photos/${x.path}`)));
    assert.ok(files.has(`studio-photos/${fresh.ids[0].path}`), 'a recent photo is untouched');
    const rows = await app.store.all('SELECT id, removed_at, storage_path FROM media ORDER BY id');
    assert.deepStrictEqual(rows.map((x) => x.removed_at != null), [true, true, false]);

    await scheduler.tick();
    assert.strictEqual(purges.length, 1, 'it does not hammer storage on every tick');
  } finally { server.close(); }
});

test('retention that fails changes nothing and is retried later', async () => {
  const { app, server, addPhoto } = await boot({ purgeStatus: 500 });
  try {
    await addPhoto('Old', 200);
    await app.settings.update({ retention: { photo_days: 90 } });
    const scheduler = new Scheduler({ engine: app.engine, store: app.store, settings: app.settings, log: silent });
    const r = await scheduler.tick();
    assert.ok(!r.photos_removed);
    assert.strictEqual((await app.store.all('SELECT removed_at FROM media'))[0].removed_at, null);
    assert.strictEqual(await app.store.kvGet('photo_purge_at', 0), 0, 'the clock is not advanced, so the next tick retries');
  } finally { server.close(); }
});

test('the storage client asks the project function to delete, and refuses malformed names', async () => {
  const calls = [];
  const ps = new PhotoStore({ url: SB, key: 'anon', bucket: 'b', purgeSecret: 'sec' }, { fetchImpl: async (u, i) => { calls.push({ u, i }); return { ok: true, status: 200, json: async () => ({ removed: 1 }) }; }, log: silent });
  assert.strictEqual(await ps.remove(['../x', 'evil.jpg']), 0, 'nothing valid, nothing sent');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(await ps.remove(['7/0123456789abcdef0123456789abcdef.png']), 1);
  assert.strictEqual(calls[0].u, `${SB}/functions/v1/purge-photos`);
  assert.strictEqual(calls[0].i.headers['x-purge-secret'], 'sec');
  await assert.rejects(() => new PhotoStore({ url: SB, key: 'anon', bucket: 'b' }, { log: silent }).remove(['7/0123456789abcdef0123456789abcdef.png']), /not set up/);
});

test('the front page goes to the inbox when a studio password exists', async () => {
  const { server, base } = await boot();
  try {
    const r = await fetch(`${base}/`, { redirect: 'manual' });
    assert.strictEqual(r.headers.get('location'), '/crm');
  } finally { server.close(); }
});

test('the privacy page speaks for the business that runs the deployment, never for anyone else', async () => {
  const { app, server, base } = await boot();
  try {
    await app.settings.update({ business: { name: 'Interio Arty', contact_email: 'connect@interioarty.com' } });
    let html = await (await fetch(`${base}/privacy`)).text();
    assert.match(html, /Interio Arty uses an automated assistant/);
    assert.match(html, /mailto:connect@interioarty\.com/);
    assert.doesNotMatch(html, /Aperture|shishodiasanidhya|\{\{/);
    await app.settings.update({ business: { name: 'A <b>bad</b> name', contact_email: 'not-an-email' } });
    html = await (await fetch(`${base}/privacy`)).text();
    assert.doesNotMatch(html, /<b>bad<\/b>/, 'the name is escaped');
    assert.match(html, /please contact A &lt;b&gt;bad&lt;\/b&gt; name directly/, 'no email set: a neutral line, not a stranger\'s address');
  } finally { server.close(); }
});
