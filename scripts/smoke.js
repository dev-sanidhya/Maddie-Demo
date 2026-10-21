'use strict';
// End-to-end smoke test against the RUNNING server through its public URL:
//   node scripts/smoke.js            (uses PUBLIC_URL from .env)
//   node scripts/smoke.js http://localhost:3000
// Creates a few temporary leads and deletes them at the end.
const config = require('../core/config');

const BASE = (process.argv[2] || config.publicUrl).replace(/\/$/, '');
const H = { 'ngrok-skip-browser-warning': '1' };
let cookie = '';
let failed = 0;
const created = [];

const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { failed++; console.log(`  FAIL  ${m}`); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

async function call(path, { method = 'GET', body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, res };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReplies(leadId, n, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const d = await call(`/api/leads/${leadId}`);
    const out = d.json.messages.filter((m) => m.direction === 'out');
    if (out.length >= n && !out.some((m) => m.status === 'pending')) return d.json;
    await sleep(1000);
  }
  return (await call(`/api/leads/${leadId}`)).json;
}

(async () => {
  console.log(`Smoke test against ${BASE}\n`);

  console.log('Public pages');
  for (const p of ['/api/health', '/form', '/privacy', '/admin']) {
    const r = await call(p);
    check(r.status === 200, `${p} answers 200`);
  }
  const cfg = await call('/api/public-config');
  check(cfg.status === 200 && cfg.json.options && cfg.json.options.budgets.length >= 5, 'form options load (budgets, timelines, property types)');
  check(cfg.json.primary === 'instagram' && !!cfg.json.instagram, `form routes people to ${cfg.json.primary} (@${cfg.json.instagram})`);

  console.log('\nSecurity');
  check((await call('/api/leads')).status === 401, 'admin API refuses requests with no login');
  check((await call('/webhook/instagram', { method: 'POST', raw: '{"entry":[]}', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' } })).status === 401, 'forged Instagram webhook is rejected');
  check((await call('/webhook/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status === 403, 'wrong verify token is rejected');
  const hs = await call(`/webhook/instagram?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(config.instagram.verifyToken)}&hub.challenge=pong42`);
  check(hs.status === 200 && hs.text === 'pong42', 'Meta verification handshake succeeds');

  console.log('\nAdmin console');
  const login = await call('/api/login', { method: 'POST', body: { password: config.adminPassword } });
  check(login.status === 200, 'admin login works');
  const sc = login.res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const st = await call('/api/status');
  check(st.status === 200, 'status endpoint answers');
  const s = st.json || {};
  check(s.instagram && s.instagram.connected, `Instagram connected as @${s.instagram && s.instagram.username}`);
  check(s.llm && s.llm.enabled, 'AI configured');
  console.log(`        AI providers: ${(s.llm.providers || []).map((p) => `${p.name}${p.cooling ? ' (cooling)' : ''}`).join(', ')}`);
  check((s.llm.providers || []).some((p) => p.configured && !p.cooling), 'at least one AI provider is usable right now');
  const boot = await call('/api/bootstrap');
  check(boot.status === 200 && boot.json.designers.length > 0, `${boot.json.designers.length} designers configured`);
  check((await call('/api/leads?sim=0')).status === 200, 'lead list loads');
  check((await call('/api/export.csv')).status === 200, 'CSV export works');
  check((await call('/api/activity')).status === 200, 'activity feed loads');

  console.log('\nEnquiry form to lead');
  const intake = await call('/api/intake', { method: 'POST', body: {
    name: 'Smoke Test', phone: '+91 90000 11122', contact_pref: 'Evening', scope: ['Modular kitchen'], property_type: 'Apartment', size: '3 BHK',
    city: 'Pune', locality: 'Kharadi', budget: '₹5 to 10 lakh', timeline: 'In 1 to 3 months', notes: 'smoke', campaign: 'smoke',
  } });
  check(intake.status === 200 && /^https:\/\/ig\.me\/m\/[\w.]+\?ref=/.test(intake.json.chat_url || ''), 'form submit returns the Instagram chat link with the lead tag');
  const list = await call('/api/leads?sim=0');
  const lead = (list.json.leads || []).find((l) => l.name === 'Smoke Test');
  if (lead) created.push(lead.id);
  check(lead && lead.property === '3BHK apartment' && lead.city === 'Kharadi, Pune' && lead.budget_amount === 1000000, 'lead arrives with property, city and budget filled in');
  check(lead && lead.brief && lead.next_step, 'lead has a summary and a next step');

  console.log('\nAssistant conversation (live AI)');
  const start = await call('/api/chat/test', { method: 'POST', body: { name: 'Smoke Customer', phone: '' } });
  const id = start.json.leadId; created.push(id);
  let d = await waitReplies(id, 1);
  check(d.messages.some((m) => m.direction === 'out' && m.status === 'sent'), 'assistant greets first');
  console.log(`        bot: ${d.messages.filter((m) => m.direction === 'out').slice(-1)[0].text.slice(0, 140)}`);
  const say = async (text, n) => { await call('/api/chat/test', { method: 'POST', body: { leadId: id, text } }); return waitReplies(id, n); };
  d = await say('Hi, I want modular kitchen interiors for my 3BHK flat in Pune', 2);
  d = await say('around 9 lakh', 3);
  d = await say('we want to start in 2 months', 4);
  d = await say('Tomorrow 5 p.m. works', 5);
  const l = d.lead;
  check(l.project_type && /pune/i.test(l.city || ''), `understood the project (${l.project_type}, ${l.city})`);
  check(l.budget_amount === 900000, 'budget captured as 9 lakh');
  check(l.stage === 'active', `qualified as Active (${l.stage})`);
  check(!!l.callback_at && l.callback_status === 'scheduled', `call time booked (${l.callback_at ? new Date(l.callback_at).toISOString() : 'none'})`);
  check(!!l.designer, `designer assigned (${l.designer})`);
  const replies = d.messages.filter((m) => m.direction === 'out').map((m) => m.text);
  check(new Set(replies.filter((t) => /\?/.test(t))).size === replies.filter((t) => /\?/.test(t)).length, 'no question was repeated');
  check(!d.events.some((e) => e.type === 'llm_error'), 'no AI errors during the conversation');
  console.log(`        last bot: ${replies[replies.length - 1].slice(0, 160)}`);

  console.log('\nBackground jobs');
  const tick = await call('/api/scheduler/run', { method: 'POST', body: {} });
  check(tick.status === 200, 'scheduler runs');

  console.log('\nCleanup');
  for (const lid of created) await call(`/api/leads/${lid}`, { method: 'DELETE' });
  ok(`removed ${created.length} temporary leads`);

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL SMOKE CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('Smoke test crashed:', e.message); process.exit(2); });
