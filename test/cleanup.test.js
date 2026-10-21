'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { createServer } = require('../core/server');
const baseConfig = require('../core/config');

const silent = { log() {}, warn() {}, error() {} };
const SB = 'https://project.supabase.co';
const DAY = 86400000;

async function boot({ purgeStatus = 200 } = {}) {
  const purges = [];
  const fetchImpl = async (url, init = {}) => {
    if (url === `${SB}/functions/v1/purge-photos`) {
      const body = JSON.parse(init.body);
      purges.push(body);
      return { ok: purgeStatus === 200, status: purgeStatus, json: async () => (purgeStatus === 200 ? { removed: body.paths.length } : { error: 'boom' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const config = {
    ...baseConfig, telegramToken: '', adminPassword: 'admin-pw', intakeSecret: 's', crmPassword: 'studio-pw',
    limits: { photosMb: 800, dbMb: 500 },
    instagram: { accessToken: '', appSecret: '', verifyToken: '', handle: '', apiVersion: 'v23.0' },
    storage: { url: SB, key: 'anon', bucket: 'studio-photos', purgeSecret: 'secret' },
  };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: async () => ({ refused: [] }), fetchImpl, debounceMs: 0, log: silent });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/crm-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'studio-pw' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const api = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie } });
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

  let n = 0;
  // a lead whose last message was `ageDays` ago, with `photos` stored photos of the given sizes
  const lead = async ({ name, ageDays, status = 'closed', photos = [], channel = 'instagram' }) => {
    const l = await app.store.createLead({ channel, chat_id: `${channel}:${name}`, name, source: 'instagram', meta: { turns: 1, crm_status: status }, last_inbound_at: Date.now() - ageDays * DAY });
    const paths = [];
    for (const size of photos) {
      const mid = await app.store.addMessage({ lead_id: l.id, direction: 'in', role: 'user', text: '[Photo] a room', status: 'received', processed: true });
      const path = `${l.id}/${(++n).toString(16).padStart(32, '0')}.jpg`;
      await app.store.addMedia({ lead_id: l.id, message_id: mid, mime: 'image/jpeg', path, size });
      paths.push(path);
    }
    return { lead: l, paths };
  };
  return { app, server, base, api, post, purges, lead };
}

test('the storage meter reports photos and database used against this client\'s allowance', async () => {
  const { app, server, api, base, lead } = await boot();
  try {
    await lead({ name: 'A', ageDays: 1, photos: [1000, 2000] });
    await lead({ name: 'B', ageDays: 1, photos: [500] });
    const u = await (await api('/api/crm/usage')).json();
    assert.deepStrictEqual([u.photos.count, u.photos.used], [3, 3500]);
    assert.strictEqual(u.photos.limit, 800 * 1024 * 1024);
    assert.strictEqual(u.database.limit, 500 * 1024 * 1024);
    assert.ok(u.database.used > 0, 'the database size is measured');
    assert.strictEqual(u.leads, 2);
    assert.strictEqual(u.can_delete_photos, true);
    assert.strictEqual((await fetch(`${base}/api/crm/usage`)).status, 401);
    // removed photos stop counting
    await app.store.markMediaRemoved([(await app.store.all('SELECT id FROM media ORDER BY id'))[0].id]);
    assert.strictEqual((await (await api('/api/crm/usage')).json()).photos.used, 2500);
  } finally { server.close(); }
});

test('preview says exactly what a clean-up would remove, by age and status, and never counts recent or test leads', async () => {
  const { server, post, lead } = await boot();
  try {
    await lead({ name: 'OldClosedPhotos', ageDays: 100, photos: [1000, 3000] });
    await lead({ name: 'OldClosedNone', ageDays: 200 });
    await lead({ name: 'OldNew', ageDays: 100, status: 'new', photos: [700] });
    await lead({ name: 'RecentClosed', ageDays: 5, photos: [900] });
    await lead({ name: 'OldSim', ageDays: 300, channel: 'sim', photos: [99] });

    let p = await (await post('/api/crm/cleanup/preview', { days: 90, status: 'closed', scope: 'leads' })).json();
    assert.deepStrictEqual([p.leads, p.photos, p.bytes], [2, 2, 4000]);
    p = await (await post('/api/crm/cleanup/preview', { days: 90, status: 'any', scope: 'leads' })).json();
    assert.deepStrictEqual([p.leads, p.photos, p.bytes], [3, 3, 4700]);
    p = await (await post('/api/crm/cleanup/preview', { days: 30, status: 'any', scope: 'photos' })).json();
    assert.deepStrictEqual([p.leads, p.matching_leads, p.photo_leads, p.photos], [0, 3, 2, 3], 'photos only: no leads would be deleted, and only leads that have photos are counted as affected');
    assert.strictEqual((await post('/api/crm/cleanup/preview', { status: 'closed', scope: 'leads' })).status, 400, 'an age is required');
  } finally { server.close(); }
});

test('clean-up of photos only: files go, leads stay with a "photo removed" note, newer leads are untouched', async () => {
  const { app, server, post, api, purges, lead } = await boot();
  try {
    const old = await lead({ name: 'Old', ageDays: 120, photos: [1000, 2000] });
    const recent = await lead({ name: 'Recent', ageDays: 3, photos: [500] });
    const r = await (await post('/api/crm/cleanup', { days: 90, status: 'closed', scope: 'photos' })).json();
    assert.deepStrictEqual([r.ok, r.leads, r.photos, r.bytes, r.remaining], [true, 0, 2, 3000, 0]);
    assert.deepStrictEqual(purges, [{ bucket: 'studio-photos', paths: old.paths }]);
    assert.ok(await app.store.getLead(old.lead.id), 'the lead is still there');
    const crm = (await (await api('/api/crm/leads')).json()).leads;
    assert.ok(crm.find((l) => l.name === 'Old').transcript.every((t) => t.removed));
    assert.ok(crm.find((l) => l.name === 'Recent').transcript[0].image, 'a recent photo is untouched');
    assert.strictEqual((await app.store.mediaOfLeads([recent.lead.id])).length, 1);
  } finally { server.close(); }
});

test('clean-up of whole leads deletes chat, details and photos, and only the matching leads', async () => {
  const { app, server, post, purges, lead } = await boot();
  try {
    const gone = await lead({ name: 'Gone', ageDays: 150, photos: [1000] });
    const gone2 = await lead({ name: 'GoneToo', ageDays: 150 });
    const keepNew = await lead({ name: 'KeepNew', ageDays: 150, status: 'new', photos: [100] });
    const keepRecent = await lead({ name: 'KeepRecent', ageDays: 2, photos: [100] });
    const r = await (await post('/api/crm/cleanup', { days: 90, status: 'closed', scope: 'leads' })).json();
    assert.deepStrictEqual([r.leads, r.photos, r.remaining], [2, 1, 0]);
    assert.strictEqual(await app.store.getLead(gone.lead.id), null);
    assert.strictEqual(await app.store.getLead(gone2.lead.id), null);
    assert.ok(await app.store.getLead(keepNew.lead.id));
    assert.ok(await app.store.getLead(keepRecent.lead.id));
    assert.strictEqual((await app.store.get('SELECT COUNT(*) c FROM messages WHERE lead_id=?', gone.lead.id)).c, 0);
    assert.strictEqual((await app.store.get('SELECT COUNT(*) c FROM media WHERE lead_id=?', gone.lead.id)).c, 0);
    assert.deepStrictEqual(purges[0].paths, gone.paths, 'the photo file was deleted from storage too');
  } finally { server.close(); }
});

test('if storage cannot delete the files, no lead is deleted', async () => {
  const { app, server, post, lead } = await boot({ purgeStatus: 500 });
  try {
    const l = await lead({ name: 'Stuck', ageDays: 150, photos: [1000] });
    const r = await post('/api/crm/cleanup', { days: 90, status: 'closed', scope: 'leads' });
    assert.strictEqual(r.status, 502);
    assert.ok(await app.store.getLead(l.lead.id), 'the lead is still there, so nothing is orphaned');
    assert.strictEqual((await app.store.mediaOfLeads([l.lead.id])).length, 1);
  } finally { server.close(); }
});

test('large clean-ups run in batches of 100 and say how many are left', async () => {
  const { app, server, post, lead } = await boot();
  try {
    for (let i = 0; i < 105; i++) await lead({ name: `Old${i}`, ageDays: 200 });
    const a = await (await post('/api/crm/cleanup', { days: 90, status: 'closed', scope: 'leads' })).json();
    assert.deepStrictEqual([a.leads, a.remaining], [100, 5]);
    const b = await (await post('/api/crm/cleanup', { days: 90, status: 'closed', scope: 'leads' })).json();
    assert.deepStrictEqual([b.leads, b.remaining], [5, 0]);
    assert.strictEqual((await app.store.get("SELECT COUNT(*) c FROM leads")).c, 0);
  } finally { server.close(); }
});

test('ticked leads can be deleted in one go; unknown and test leads are ignored', async () => {
  const { app, server, post, lead } = await boot();
  try {
    const a = await lead({ name: 'A', ageDays: 1, photos: [10] });
    const b = await lead({ name: 'B', ageDays: 1 });
    const keep = await lead({ name: 'Keep', ageDays: 1 });
    const sim = await lead({ name: 'Sim', ageDays: 1, channel: 'sim' });
    const r = await (await post('/api/crm/leads/delete', { ids: [a.lead.id, b.lead.id, sim.lead.id, 99999, 'x'], scope: 'leads' })).json();
    assert.strictEqual(r.leads, 2);
    assert.strictEqual(await app.store.getLead(a.lead.id), null);
    assert.ok(await app.store.getLead(keep.lead.id));
    assert.ok(await app.store.getLead(sim.lead.id), 'a test lead is not touched through this door');
    assert.strictEqual((await post('/api/crm/leads/delete', { ids: [], scope: 'leads' })).status, 400);
    assert.strictEqual((await post('/api/crm/leads/delete', { ids: [keep.lead.id], scope: 'everything' })).status, 400);
  } finally { server.close(); }
});

test('the studio can choose how long photos are kept, from a short list', async () => {
  const { app, server, api } = await boot();
  try {
    const put = (days) => api('/api/crm/retention', { method: 'PUT', body: JSON.stringify({ photo_days: days }) });
    assert.strictEqual((await put(60)).status, 200);
    assert.strictEqual(app.settings.get().retention.photo_days, 60);
    assert.strictEqual((await (await api('/api/crm/usage')).json()).photo_days, 60);
    assert.strictEqual((await put(45)).status, 400);
    assert.strictEqual((await put(0)).status, 200, 'never delete is allowed');
    assert.strictEqual(app.settings.get().retention.photo_days, 0);
  } finally { server.close(); }
});
