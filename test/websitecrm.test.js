'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { createServer } = require('../core/server');
const baseConfig = require('../core/config');
const { plan } = require('../core/followups');

const silent = { log() {}, warn() {}, error() {} };

async function boot() {
  const config = { ...baseConfig, telegramToken: '', adminPassword: 'studio-pw', intakeSecret: 's', instagram: { accessToken: '', appSecret: '', verifyToken: '', handle: '', apiVersion: 'v23.0' } };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: async () => ({ refused: [] }), debounceMs: 0, log: silent });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'studio-pw' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}), cookie } });
  const ingest = (body, headers = {}) => fetch(`${base}/api/crm/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, server, base, api, ingest };
}

const widgetLead = (over = {}) => ({
  id: 1760000000001, name: 'Neha Kulkarni', phone: '9876500011', email: '', location: 'Kharadi, Pune', bhk: '3BHK', budget: '₹15 lakh', projectType: 'Full home',
  transcript: [{ role: 'user', content: 'Hi, I need interiors for my 3BHK' }, { role: 'assistant', content: 'Lovely, which area is it in?' }, { role: 'user', content: 'Kharadi, Pune' }], ...over,
});

test('the website widget feeds the same inbox: create, then update with the AI summary, without duplicating', async () => {
  const { server, api, ingest } = await boot();
  try {
    assert.ok((await (await ingest(widgetLead())).json()).ok);
    await ingest(widgetLead({ summary: 'Wants a full 3BHK in Kharadi, budget 15 lakh.', location: '', phone: '' }));
    const { leads } = await (await api('/api/crm/leads')).json();
    assert.strictEqual(leads.length, 1, 'same widget id, same lead');
    const l = leads[0];
    assert.strictEqual(l.name, 'Neha Kulkarni');
    assert.strictEqual(l.phone, '9876500011', 'a later record with blanks does not erase what we know');
    assert.strictEqual(l.location, 'Kharadi, Pune');
    assert.strictEqual(l.source, 'Website chatbot');
    assert.strictEqual(l.summary, 'Wants a full 3BHK in Kharadi, budget 15 lakh.');
    assert.strictEqual(l.status, 'new');
    assert.deepStrictEqual(l.transcript.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(l.budget, /15/);
  } finally { server.close(); }
});

test('Instagram leads show up in the same inbox with their conversation', async () => {
  const { app, server, api } = await boot();
  try {
    const lead = await app.store.createLead({ channel: 'instagram', chat_id: 'ig:5', name: 'Riya', tg_username: 'riya.k', source: 'instagram', city: 'Pune', project_type: 'Full home', meta: { turns: 2 } });
    await app.store.addMessage({ lead_id: lead.id, direction: 'in', role: 'user', text: 'hello', processed: true });
    await app.store.addMessage({ lead_id: lead.id, direction: 'out', role: 'assistant', text: 'Welcome ✨', status: 'sent', processed: true });
    const { leads } = await (await api('/api/crm/leads')).json();
    const l = leads.find((x) => x.id === lead.id);
    assert.strictEqual(l.source, 'Instagram DM');
    assert.strictEqual(l.contact, '@riya.k');
    assert.strictEqual(l.transcript[1].content, 'Welcome ✨');
  } finally { server.close(); }
});

test('marking a lead contacted or closed is saved, and the inbox needs the studio password', async () => {
  const { server, api, base, ingest } = await boot();
  try {
    await ingest(widgetLead());
    const { leads } = await (await api('/api/crm/leads')).json();
    const id = leads[0].id;
    assert.strictEqual((await api(`/api/crm/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'contacted' }) })).status, 200);
    assert.strictEqual((await (await api('/api/crm/leads')).json()).leads[0].status, 'contacted');
    assert.strictEqual((await api(`/api/crm/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'bogus' }) })).status, 400);
    assert.strictEqual((await fetch(`${base}/api/crm/leads`)).status, 401, 'no cookie, no leads');
    assert.strictEqual((await fetch(`${base}/api/crm/leads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'closed' }) })).status, 401);
    const page = await fetch(`${base}/crm`);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Lead Inbox/);
    assert.strictEqual((await fetch(`${base}/crm-assets/crm.js`)).status, 200);
    assert.strictEqual((await fetch(`${base}/crm-assets/db.js`)).status, 404, 'only the two page assets are served');
  } finally { server.close(); }
});

test('ingest is public but guarded: bad input is refused, an optional site key is honoured, CORS allows the website', async () => {
  const { server, ingest } = await boot();
  try {
    assert.strictEqual((await ingest({ name: 'No id' })).status, 400);
    assert.strictEqual((await ingest({ id: 7 })).status, 400, 'a lead needs a name, phone or email');
    const ok = await ingest(widgetLead({ id: 8 }));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('access-control-allow-origin'), '*');
    process.env.CRM_INGEST_KEY = 'site-key-1';
    assert.strictEqual((await ingest(widgetLead({ id: 9 }))).status, 401);
    assert.strictEqual((await ingest(widgetLead({ id: 9 }), { 'X-Site-Key': 'site-key-1' })).status, 200);
  } finally { delete process.env.CRM_INGEST_KEY; server.close(); }
});

test('website-chatbot leads are never chased by the follow-up scheduler', async () => {
  const { app, server, ingest } = await boot();
  try {
    await ingest(widgetLead());
    const lead = await app.store.getLeadByChat('web:1760000000001');
    assert.strictEqual(lead.channel, 'web');
    assert.strictEqual(plan({ ...lead, last_outbound_at: Date.now() - 9 * 3600000, last_inbound_at: Date.now() - 10 * 3600000 }, app.settings.get(), Date.now()), null);
  } finally { server.close(); }
});
