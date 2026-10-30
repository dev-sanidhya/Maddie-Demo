'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const { createServer } = require('../core/server');
const { chunk } = require('../core/instagram');
const baseConfig = require('../core/config');

const silent = { log() {}, warn() {}, error() {} };
const IG_ID = '17841400000000000';

function fakeLlm() {
  return async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) {
      const text = (o.messages[0].content.match(/"""\n([\s\S]*?)\n"""/) || [])[1] || '';
      const out = { refused: [] };
      if (/full home/i.test(text)) out.project_type = 'Full home';
      const lakh = text.match(/(\d+(?:\.\d+)?)\s*lakh/i);
      if (lakh) out.budget_amount = Number(lakh[1]) * 100000;
      return out;
    }
    const first = sys.match(/FIRST message to (\S+)/);
    if (first) return `Hi ${first[1]}, thanks for your enquiry. What kind of space are you planning?`;
    return 'Thanks, noted. What else can you tell me?';
  };
}

async function build({ thread = null, mode, debounceMs = 0, llm } = {}) {
  const graph = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    graph.push({ url, method: init.method, body, auth: init.headers && init.headers.Authorization });
    let data = { message_id: 'm_out', recipient_id: 'x' };
    if (/\/me\?/.test(url)) data = { user_id: IG_ID, username: 'brandstudio' };
    else if (/\/me\/conversations/.test(url)) data = { data: thread ? [{ id: 'conv1' }] : [] };
    else if (/\/conv1\?/.test(url)) data = { messages: { data: [...(thread || [])].reverse() } };
    else if (/\/\d+\?fields=name/.test(url)) data = { name: 'Riya Kapoor', username: 'riya.k' };
    return { ok: true, status: 200, json: async () => data };
  };
  const config = {
    ...baseConfig, telegramToken: '', demoMode: true, adminPassword: 'pw', intakeSecret: 's3cret',
    instagram: { accessToken: 'tok', appSecret: 'appsecret', verifyToken: 'verify-me', handle: 'brandstudio', apiVersion: 'v23.0', teamThreadMode: mode || 'pause' },
  };
  const app = await createApp(config, { store: await Store.open({ file: ':memory:' }), llmOverride: llm || fakeLlm(), fetchImpl, debounceMs, log: silent });
  return { app, graph, config };
}

const sends = (graph) => graph.filter((g) => /\/me\/messages$/.test(g.url) && g.body && g.body.message);
const settle = async (app, id) => { await app.engine.idle(id); await new Promise((r) => setTimeout(r, 30)); await app.engine.idle(id); };
const msgEvent = (sender, text, mid, extra = {}) => ({ object: 'instagram', entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid, text }, ...extra }] }] });
const refEvent = (sender, ref) => ({ object: 'instagram', entry: [{ id: IG_ID, messaging: [{ sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), referral: { ref, source: 'SHORTLINK', type: 'OPEN_THREAD' } }] }] });

test('webhook verification and signature checking', async () => {
  const { app } = await build();
  const ig = app.instagram;
  assert.strictEqual(ig.verifyChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '42' })), '42');
  assert.strictEqual(ig.verifyChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '42' })), null);
  const raw = Buffer.from('{"a":1}');
  const good = `sha256=${crypto.createHmac('sha256', 'appsecret').update(raw).digest('hex')}`;
  assert.strictEqual(ig.validSignature(raw, good), true);
  assert.strictEqual(ig.validSignature(raw, 'sha256=deadbeef'), false);
  assert.strictEqual(ig.validSignature(raw, undefined), false);
  ig.cfg.appSecret = '';
  assert.strictEqual(ig.validSignature(raw, good), false, 'unsigned deployments reject everything rather than trust forged leads');
});

test('form lead + ig.me referral: lead is linked, greeted by name, then qualified', async () => {
  const { app, graph } = await build();
  const lead = await app.engine.createLeadFromIntake({ name: 'Riya Kapoor', phone: '+91 97000 11111', city: 'Pune', source: 'form' });
  await app.instagram.handleWebhook(refEvent('9001', lead.start_token));
  await app.instagram.handleWebhook(msgEvent('9001', 'Hi', 'mid.1'));
  await settle(app, lead.id);
  let l = await app.store.getLead(lead.id);
  assert.strictEqual(l.chat_id, 'ig:9001');
  assert.strictEqual(l.channel, 'instagram');
  const first = sends(graph)[0];
  assert.strictEqual(first.body.recipient.id, '9001');
  assert.match(first.body.message.text, /Riya/, 'greets with the form name on the first inbound message');
  assert.strictEqual(first.auth, 'Bearer tok');

  await app.instagram.handleWebhook(msgEvent('9001', 'full home, budget is 12 lakh', 'mid.2'));
  await settle(app, lead.id);
  l = await app.store.getLead(lead.id);
  assert.strictEqual(l.project_type, 'Full home');
  assert.strictEqual(l.budget_amount, 1200000);
  assert.ok(sends(graph).length >= 2);
});

test('referral arriving after the first message merges the organic placeholder into the form lead', async () => {
  const { app } = await build();
  const lead = await app.engine.createLeadFromIntake({ name: 'Late Ref', phone: '+91 97000 22222', source: 'form' });
  await app.instagram.handleWebhook(msgEvent('9002', 'hello there', 'mid.a'));
  const organic = await app.store.getLeadByChat('ig:9002');
  assert.ok(organic && organic.id !== lead.id);
  await settle(app, organic.id);
  await app.instagram.handleWebhook(refEvent('9002', lead.start_token));
  await settle(app, lead.id);
  assert.strictEqual((await app.store.getLeadByChat('ig:9002')).id, lead.id);
  assert.strictEqual(await app.store.getLead(organic.id), null, 'placeholder removed');
  assert.ok((await app.store.getMessages(lead.id)).some((m) => m.text === 'hello there'), 'their first message moved over');
});

test('duplicate message ids, echoes and non-text messages are handled', async () => {
  const { app, graph } = await build();
  await app.instagram.handleWebhook(msgEvent('9003', 'hi', 'mid.dup'));
  await app.instagram.handleWebhook(msgEvent('9003', 'hi', 'mid.dup'));
  const lead = await app.store.getLeadByChat('ig:9003');
  await settle(app, lead.id);
  assert.strictEqual((await app.store.all("SELECT * FROM messages WHERE direction='in'")).length, 1);
  const before = sends(graph).length;
  await app.instagram.handleWebhook(msgEvent('9003', 'echo of our own message', 'mid.echo', {}));
  const echo = msgEvent('9003', 'ignored', 'mid.e2'); echo.entry[0].messaging[0].message.is_echo = true;
  await app.instagram.handleWebhook(echo);
  await app.instagram.handleWebhook({ entry: [{ id: IG_ID, messaging: [{ sender: { id: IG_ID }, recipient: { id: '9003' }, message: { mid: 'mid.self', text: 'from us' } }] }] });
  await settle(app, lead.id);
  assert.ok(!(await app.store.getMessages(lead.id)).some((m) => m.text === 'ignored' || m.text === 'from us'));
  const att = msgEvent('9003', '', 'mid.att'); delete att.entry[0].messaging[0].message.text; att.entry[0].messaging[0].message.attachments = [{ type: 'image' }];
  await app.instagram.handleWebhook(att);
  assert.ok(sends(graph).length > before, 'asks them to type instead');
});

test('24 hour window: AI replies are blocked after it closes, humans may use the HUMAN_AGENT tag', async () => {
  const { app, graph } = await build();
  const old = Date.now() - 30 * 3600 * 1000;
  const lead = await app.store.createLead({ channel: 'instagram', chat_id: 'ig:9004', name: 'Old', last_inbound_at: old });
  await assert.rejects(() => app.instagram.sendText(lead, 'hello', { role: 'assistant' }), /24 hour/);
  await app.instagram.sendText(lead, 'a human follow-up', { role: 'admin' });
  const m = sends(graph).pop();
  assert.strictEqual(m.body.messaging_type, 'MESSAGE_TAG');
  assert.strictEqual(m.body.tag, 'HUMAN_AGENT');
  const ancient = await app.store.createLead({ channel: 'instagram', chat_id: 'ig:9005', name: 'Ancient', last_inbound_at: Date.now() - 9 * 24 * 3600 * 1000 });
  await assert.rejects(() => app.instagram.sendText(ancient, 'hi', { role: 'admin' }), /window/);
});

test('long messages are split under the 1000 character limit', async () => {
  const parts = chunk(('This is a sentence that goes on. ').repeat(80));
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 1000);
});

test('scheduler never nudges Instagram leads outside the 24h window', async () => {
  const { app, graph } = await build();
  const lead = await app.store.createLead({ channel: 'instagram', chat_id: 'ig:9006', name: 'Quiet', stage: 'qualifying', last_inbound_at: Date.now() - 26 * 3600 * 1000, last_outbound_at: Date.now() - 25 * 3600 * 1000, meta: { turns: 1 } });
  const before = sends(graph).length;
  const r = await app.scheduler.tick({ force: true });
  assert.strictEqual(r.followups, 0);
  assert.strictEqual(sends(graph).length, before);
  assert.strictEqual((await app.store.getLead(lead.id)).stage, 'nurture', 'goes to nurture for a human to pick up');
});

test('HTTP: form intake points at Instagram, and the signed webhook works end to end', async () => {
  const { app, graph, config } = await build();
  await app.instagram.start();
  assert.strictEqual(app.instagram.handle, 'brandstudio');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const intake = await (await fetch(`${base}/api/intake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Web Form', phone: '+91 96000 33333', city: 'Pune' }) })).json();
    assert.strictEqual(intake.primary, 'instagram');
    assert.match(intake.chat_url, /^https:\/\/ig\.me\/m\/brandstudio\?ref=[A-Za-z0-9_-]+$/);
    const token = new URL(intake.chat_url).searchParams.get('ref');
    const lead = await app.store.getLeadByToken(token);
    assert.ok(lead);

    const ch = await fetch(`${base}/webhook/instagram?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=777`);
    assert.strictEqual(await ch.text(), '777');
    assert.strictEqual((await fetch(`${base}/webhook/instagram?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1`)).status, 403);

    const payload = JSON.stringify(refEventWithMessage('9100', token, 'Hello!', 'mid.http'));
    const bad = await fetch(`${base}/webhook/instagram`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' }, body: payload });
    assert.strictEqual(bad.status, 401);
    const sig = `sha256=${crypto.createHmac('sha256', 'appsecret').update(payload).digest('hex')}`;
    const ok = await fetch(`${base}/webhook/instagram`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: payload });
    assert.strictEqual(ok.status, 200);
    await new Promise((r) => setTimeout(r, 200));
    await settle(app, lead.id);
    assert.strictEqual((await app.store.getLeadByChat('ig:9100')).id, lead.id);
    assert.ok(sends(graph).some((g) => g.body.recipient.id === '9100'));
  } finally {
    server.close();
  }
  void config;
});

function refEventWithMessage(sender, ref, text, mid) {
  return { object: 'instagram', entry: [{ id: IG_ID, messaging: [
    { sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), referral: { ref, source: 'SHORTLINK', type: 'OPEN_THREAD' } },
    { sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid, text } },
  ] }] };
}

test('INCIDENT: a phone number followed 0.4s later by an empty companion event gets no "I can only read text" reply', async () => {
  const { app, graph } = await build();
  await app.instagram.handleWebhook(msgEvent('9200', 'Hi, I want a full home redesign', 'mid.i1'));
  const lead = await app.store.getLeadByChat('ig:9200');
  await settle(app, lead.id);
  await app.instagram.handleWebhook(msgEvent('9200', '9990052074', 'mid.i2'));
  await settle(app, lead.id); // Aria's real reply to the number
  // what Instagram sent right after the number: a message event with no text and nothing the customer attached
  const companion = msgEvent('9200', '', 'mid.i3'); delete companion.entry[0].messaging[0].message.text;
  const before = sends(graph).length;
  await app.instagram.handleWebhook(companion);
  const heart = msgEvent('9200', '', 'mid.i4'); delete heart.entry[0].messaging[0].message.text; heart.entry[0].messaging[0].message.attachments = [{ type: 'like_heart' }];
  await app.instagram.handleWebhook(heart);
  await settle(app, lead.id);
  const texts = (await app.store.getMessages(lead.id)).map((m) => m.text);
  assert.ok(!texts.some((t) => /non-text|can only read/i.test(t)), 'nothing about non-text appears in the chat');
  assert.strictEqual(sends(graph).length, before, 'no reply was sent for the companion event or the heart');
  assert.strictEqual((await app.store.getLead(lead.id)).phone, '9990052074', 'the number itself was captured');
  assert.ok((await app.store.getEvents(lead.id)).some((e) => e.type === 'non_text_ignored'));
});

test('a real attachment (voice note) is answered, and the exchange is kept in the transcript', async () => {
  const { app, graph } = await build();
  await app.instagram.handleWebhook(msgEvent('9201', 'hello', 'mid.v1'));
  const lead = await app.store.getLeadByChat('ig:9201');
  await settle(app, lead.id);
  const voice = msgEvent('9201', '', 'mid.v2'); delete voice.entry[0].messaging[0].message.text; voice.entry[0].messaging[0].message.attachments = [{ type: 'audio' }];
  const before = sends(graph).length;
  await app.instagram.handleWebhook(voice);
  assert.strictEqual(sends(graph).length, before + 1);
  const texts = (await app.store.getMessages(lead.id)).map((m) => m.text);
  assert.ok(texts.includes('[sent a voice note]'));
  assert.ok(texts.some((t) => /I can see you sent a voice note/.test(t)), 'the reply is recorded too');
});

test('INCIDENT: the assistant is shown the number itself, so "what is my number?" can be answered', async () => {
  const { Agent } = require('../core/agent');
  const { DEFAULTS } = require('../core/settings');
  const seen = [];
  const agent = new Agent({ llm: { complete: async (o) => { seen.push(o.system); return 'Your number is 9990052074.'; } } });
  const settings = JSON.parse(JSON.stringify(DEFAULTS));
  const lead = { meta: {}, name: 'Atharva', phone: '9990052074', email: 'a@x.com' };
  const reply = await agent.reply({ type: 'POST', askCallback: false }, { lead, settings, designer: null, summary: '' }, [{ role: 'user', text: 'What is my number?' }]);
  assert.match(seen[0], /Phone number: 9990052074/);
  assert.match(seen[0], /read it back exactly/);
  assert.match(seen[0], /Email: a@x\.com/);
  assert.strictEqual(reply, 'Your number is 9990052074.');
  await agent.reply({ type: 'POST', gotPhone: true }, { lead, settings, designer: null, summary: '' }, [{ role: 'user', text: '9990052074' }]);
  assert.match(seen[1], /read the digits back/);
});

const T0 = Date.now() - 3 * 86400000;
const teamThread = () => [
  { id: 'm1', created_time: new Date(T0).toISOString(), from: { id: IG_ID, username: 'brandstudio' }, message: 'Hi pls see your dm! We would love to work with you on the Etimya collab' },
  { id: 'm2', created_time: new Date(T0 + 3600000).toISOString(), from: { id: 'u77', username: 'riya.k' }, message: 'Could you tell me the commercials?' },
  { id: 'm3', created_time: new Date(T0 + 7200000).toISOString(), from: { id: IG_ID, username: 'brandstudio' }, message: 'The commercial is 3000, can stretch to 4000' },
];

test('a first message into a chat the team already started: earlier messages are loaded in order and the assistant stays out', async () => {
  const { app, graph } = await build({ thread: teamThread() });
  await app.instagram.handleWebhook(msgEvent('u77', 'Can we do 5k? That is my minimum', 'm_new'));
  const lead = await app.store.getLeadByChat('ig:u77');
  await settle(app, lead.id);
  const rows = await app.store.all('SELECT direction, role, text, processed FROM messages WHERE lead_id=? ORDER BY id', lead.id);
  assert.deepStrictEqual(rows.map((r) => r.direction), ['out', 'in', 'out', 'in'], 'history first, then the new message');
  assert.match(rows[0].text, /Etimya/);
  assert.strictEqual(rows[2].role, 'admin');
  const after = await app.store.getLead(lead.id);
  assert.ok(after.ai_paused, 'assistant paused because the team already spoke');
  assert.strictEqual(sends(graph).length, 0, 'nothing was sent to the customer');
});

test('assist mode: earlier messages are loaded and the assistant carries on without a greeting', async () => {
  const { app, graph } = await build({ thread: teamThread(), mode: 'assist' });
  await app.instagram.handleWebhook(msgEvent('u77', 'Can we do 5k?', 'm_new2'));
  const lead = await app.store.getLeadByChat('ig:u77');
  await settle(app, lead.id);
  assert.ok(!(await app.store.getLead(lead.id)).ai_paused);
  assert.ok(sends(graph).length >= 1, 'it replied');
  assert.ok(!/FIRST message/.test(JSON.stringify(sends(graph).map((g) => g.body))), 'no first-contact greeting');
});

test('a brand new chat with no history still gets the normal greeting', async () => {
  const { app, graph } = await build({ thread: null });
  await app.instagram.handleWebhook(msgEvent('u88', 'Hi, I need a full home redesign', 'm_x'));
  const lead = await app.store.getLeadByChat('ig:u88');
  await settle(app, lead.id);
  assert.ok(!(await app.store.getLead(lead.id)).ai_paused);
  assert.ok(sends(graph).length >= 1);
});

test('a message the team sends from the Instagram app is recorded and pauses the assistant (its own replies do not)', async () => {
  const { app } = await build();
  await app.instagram.handleWebhook(msgEvent('u99', 'Hi, I need a full home redesign', 'm_y'));
  const lead = await app.store.getLeadByChat('ig:u99');
  await settle(app, lead.id);
  const botReply = (await app.store.all("SELECT text FROM messages WHERE lead_id=? AND direction='out' ORDER BY id DESC LIMIT 1", lead.id))[0].text;
  const echo = (text, mid) => ({ object: 'instagram', entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: IG_ID }, recipient: { id: 'u99' }, timestamp: Date.now(), message: { mid, text, is_echo: true } }] }] });
  await app.instagram.handleWebhook(echo(botReply, 'echo_bot'));
  assert.ok(!(await app.store.getLead(lead.id)).ai_paused, "the assistant's own echo is ignored");
  await app.instagram.handleWebhook(echo('Hey, this is Sam from the team, calling you shortly', 'echo_human'));
  const after = await app.store.getLead(lead.id);
  assert.ok(after.ai_paused, 'a human message pauses the assistant');
  const last = (await app.store.all("SELECT text, role FROM messages WHERE lead_id=? ORDER BY id DESC LIMIT 1", lead.id))[0];
  assert.match(last.text, /Sam from the team/);
  assert.strictEqual(last.role, 'admin');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('BURST: ten short messages in a row get ONE answer that covers all of them', async () => {
  const seen = [];
  const base = fakeLlm();
  const llm = async (o) => { seen.push(o); return base(o); };
  const { app, graph } = await build({ debounceMs: 250, llm });
  const parts = ['hi', 'so', 'we', 'are', 'a', 'jewellery', 'brand', 'wanting', 'a', 'full home redesign'];
  for (const [i, t] of parts.entries()) { await app.instagram.handleWebhook(msgEvent('u50', t, `m_b${i}`)); await sleep(40); }
  const lead = await app.store.getLeadByChat('ig:u50');
  await settle(app, lead.id);
  await sleep(700); await settle(app, lead.id);
  assert.strictEqual(sends(graph).length, 1, 'one reply, not ten');
  const inbound = await app.store.all("SELECT processed FROM messages WHERE lead_id=? AND direction='in'", lead.id);
  assert.strictEqual(inbound.length, 10);
  assert.ok(inbound.every((r) => r.processed === 1), 'every part was handled in that one turn');
  const extract = seen.find((o) => (o.system || '').includes('You extract structured facts'));
  assert.ok(extract && /jewellery\s+brand\s+wanting\s+a/.test(extract.messages[0].content), 'the AI read the whole thought together');
});

test('a message that lands while the reply is being written is folded in, still ONE reply', async () => {
  const base = fakeLlm();
  let slowed = false;
  const llm = async (o) => { if (!slowed && !(o.system || '').includes('You extract')) { slowed = true; await sleep(250); } return base(o); };
  const { app, graph } = await build({ debounceMs: 60, llm });
  await app.instagram.handleWebhook(msgEvent('u51', 'I want a full home redesign', 'm_c1'));
  await sleep(200); // the first reply is being written now
  await app.instagram.handleWebhook(msgEvent('u51', 'oh and budget is 20 lakh', 'm_c2'));
  const lead = await app.store.getLeadByChat('ig:u51');
  await settle(app, lead.id); await sleep(600); await settle(app, lead.id);
  assert.strictEqual(sends(graph).length, 1, 'the half-written reply was dropped; one reply covers both messages');
  assert.strictEqual((await app.store.getLead(lead.id)).budget_amount, 2000000, 'the second message was used');
});

test('LAST LOOK: a team member answers between the customer message and the assistant reply: the assistant holds back', async () => {
  const thread = [];
  const { app, graph } = await build({ thread });
  await app.instagram.handleWebhook(msgEvent('u52', 'Hi, I need a full home redesign', 'm_d1'));
  const lead = await app.store.getLeadByChat('ig:u52');
  await settle(app, lead.id);
  const before = sends(graph).length;
  assert.ok(before >= 1);
  thread.push({ id: 'human1', created_time: new Date().toISOString(), from: { id: IG_ID, username: 'brandstudio' }, message: 'Hey, Sam here, I will take it from here' });
  await app.instagram.handleWebhook(msgEvent('u52', 'Great, what are your rates?', 'm_d2'));
  await settle(app, lead.id);
  assert.strictEqual(sends(graph).length, before, 'no new assistant message was sent');
  const after = await app.store.getLead(lead.id);
  assert.ok(after.ai_paused, 'the chat is now paused for the team');
  const texts = (await app.store.all('SELECT text FROM messages WHERE lead_id=? ORDER BY id', lead.id)).map((r) => r.text);
  assert.ok(texts.some((t) => /Sam here/.test(t)), "the team's message is in the transcript");
});

test('RELOAD: an existing chat is rebuilt from Instagram, the assistant\'s old replies stay the assistant\'s, the team\'s are the team\'s', async () => {
  const thread = [];
  const { app } = await build({ thread });
  await app.instagram.handleWebhook(msgEvent('u60', 'Hi, I need a full home redesign', 'm_r1'));
  const lead = await app.store.getLeadByChat('ig:u60');
  await settle(app, lead.id);
  const botReply = (await app.store.all("SELECT text FROM messages WHERE lead_id=? AND direction='out' ORDER BY id DESC LIMIT 1", lead.id))[0].text;
  await app.store.updateLead(lead.id, { ai_paused: 1 });
  const at = (n) => new Date(Date.now() - n * 60000).toISOString();
  thread.push(
    { id: 'h1', created_time: at(3000), from: { id: IG_ID, username: 'brandstudio' }, message: 'Hi pls see your dm! we have a paid collab' },
    { id: 'h2', created_time: at(2900), from: { id: 'u60', username: 'x' }, message: 'Hi, I need a full home redesign' },
    { id: 'h3', created_time: at(2890), from: { id: IG_ID, username: 'brandstudio' }, message: botReply },
    { id: 'h4', created_time: at(10), from: { id: IG_ID, username: 'brandstudio' }, message: 'Sam here, taking over' },
  );
  const r = await app.instagram.reloadHistory(lead.id);
  assert.strictEqual(r.reloaded, true);
  const rows = await app.store.all('SELECT direction, role, text FROM messages WHERE lead_id=? ORDER BY id', lead.id);
  assert.deepStrictEqual(rows.map((x) => `${x.direction}:${x.role}`), ['out:admin', 'in:user', 'out:assistant', 'out:admin']);
  assert.ok((await app.store.getLead(lead.id)).ai_paused, 'a reload never un-pauses a chat');
});

test('the id of the assistant\'s own message is remembered, so its echo is never taken for a person', async () => {
  const { app } = await build();
  await app.instagram.handleWebhook(msgEvent('u61', 'Hi, I need a full home redesign', 'm_s1'));
  const lead = await app.store.getLeadByChat('ig:u61');
  await settle(app, lead.id);
  const out = (await app.store.all("SELECT ext_id FROM messages WHERE lead_id=? AND direction='out'", lead.id))[0];
  assert.strictEqual(out.ext_id, 'm_out');
});
