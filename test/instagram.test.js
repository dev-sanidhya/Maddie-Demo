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

async function build({ thread = null, mode, debounceMs = 0, llm, agentMode, agentShadow } = {}) {
  const graph = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    graph.push({ url, method: init.method, body, auth: init.headers && init.headers.Authorization });
    let data = { message_id: 'm_out', recipient_id: 'x' };
    if (/\/me\?/.test(url)) data = { user_id: IG_ID, username: 'brandstudio' };
    else if (/\/me\/conversations/.test(url)) data = { data: thread ? [{ id: `conv1:${new URL(url).searchParams.get('user_id')}` }] : [] };
    else if (/\/conv1:[^?]*\?/.test(url)) data = { messages: { data: [...(thread || [])].reverse() } };
    else if (/\/\d+\?fields=name/.test(url)) data = { name: 'Riya Kapoor', username: 'riya.k' };
    return { ok: true, status: 200, json: async () => data };
  };
  const config = {
    ...baseConfig, agentMode: agentMode || 'script', agentShadow: !!agentShadow, telegramToken: '', demoMode: true, adminPassword: 'pw', intakeSecret: 's3cret',
    instagram: { accessToken: 'tok', appSecret: 'appsecret', verifyToken: 'verify-me', handle: 'brandstudio', apiVersion: 'v23.0', accountId: IG_ID },
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

test('a first message into a chat the team already started: earlier messages are loaded in order and the assistant still answers (history is context, not a pause)', async () => {
  const { app, graph } = await build({ thread: teamThread() });
  await app.instagram.handleWebhook(msgEvent('u77', 'Can we do 5k? That is my minimum', 'm_new'));
  const lead = await app.store.getLeadByChat('ig:u77');
  await settle(app, lead.id);
  const rows = await app.store.all('SELECT direction, role, text FROM messages WHERE lead_id=? ORDER BY id', lead.id);
  assert.deepStrictEqual(rows.map((r) => `${r.direction}:${r.role}`), ['out:admin', 'in:user', 'out:admin', 'in:user', 'out:assistant'], 'history first, then the new message, then the assistant');
  assert.match(rows[0].text, /Etimya/);
  assert.ok(!(await app.store.getLead(lead.id)).ai_paused, 'earlier team involvement never pauses the assistant');
  assert.strictEqual(sends(graph).length, 1, 'it answered');
});

test('a brand new chat with no history still gets the normal greeting', async () => {
  const { app, graph } = await build({ thread: null });
  await app.instagram.handleWebhook(msgEvent('u88', 'Hi, I need a full home redesign', 'm_x'));
  const lead = await app.store.getLeadByChat('ig:u88');
  await settle(app, lead.id);
  assert.ok(!(await app.store.getLead(lead.id)).ai_paused);
  assert.ok(sends(graph).length >= 1);
});

test('a message the team sends from the Instagram app is recorded in the transcript (the assistant own echo is ignored) and nothing is paused', async () => {
  const { app } = await build();
  await app.instagram.handleWebhook(msgEvent('u99', 'Hi, I need a full home redesign', 'm_y'));
  const lead = await app.store.getLeadByChat('ig:u99');
  await settle(app, lead.id);
  const botReply = (await app.store.all("SELECT text FROM messages WHERE lead_id=? AND direction='out' ORDER BY id DESC LIMIT 1", lead.id))[0].text;
  const echo = (text, mid) => ({ object: 'instagram', entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: IG_ID }, recipient: { id: 'u99' }, timestamp: Date.now(), message: { mid, text, is_echo: true } }] }] });
  const n0 = (await app.store.all('SELECT id FROM messages WHERE lead_id=?', lead.id)).length;
  await app.instagram.handleWebhook(echo(botReply, 'echo_bot'));
  assert.strictEqual((await app.store.all('SELECT id FROM messages WHERE lead_id=?', lead.id)).length, n0, "the assistant's own echo adds nothing");
  await app.instagram.handleWebhook(echo('Hey, this is Sam from the team, calling you shortly', 'echo_human'));
  const last = (await app.store.all("SELECT text, role FROM messages WHERE lead_id=? ORDER BY id DESC LIMIT 1", lead.id))[0];
  assert.match(last.text, /Sam from the team/);
  assert.strictEqual(last.role, 'admin');
  assert.ok(!(await app.store.getLead(lead.id)).ai_paused, 'recording a team message does not pause the chat');
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

test('HOLD: the team already answered the latest customer message, so the assistant holds back; the NEXT message it answers again', async () => {
  const thread = [];
  const { app, graph } = await build({ thread });
  await app.instagram.handleWebhook(msgEvent('u52', 'Hi, I need a full home redesign', 'm_d1'));
  const lead = await app.store.getLeadByChat('ig:u52');
  await settle(app, lead.id);
  const before = sends(graph).length;
  assert.ok(before >= 1);
  // the customer writes; before the assistant answers, a team member answers in the Instagram app
  await app.instagram.handleWebhook(msgEvent('u52', 'Great, what are your rates?', 'm_d2'));
  thread.push({ id: 'cust2', created_time: new Date(Date.now() - 1000).toISOString(), from: { id: 'u52', username: 'x' }, message: 'Great, what are your rates?' });
  thread.push({ id: 'human1', created_time: new Date(Date.now() + 500).toISOString(), from: { id: IG_ID, username: 'brandstudio' }, message: 'Hey, Sam here, our rates start at 50k' });
  await settle(app, lead.id);
  assert.strictEqual(sends(graph).length, before, 'no new assistant message: the team already replied');
  assert.ok(!(await app.store.getLead(lead.id)).ai_paused, 'the chat is NOT paused');
  const texts = (await app.store.all('SELECT text FROM messages WHERE lead_id=? ORDER BY id', lead.id)).map((r) => r.text);
  assert.ok(texts.some((t) => /Sam here/.test(t)), "the team's message is in the transcript");
  // a later customer message that nobody has answered gets an answer
  thread.push({ id: 'cust3', created_time: new Date(Date.now() + 5000).toISOString(), from: { id: 'u52', username: 'x' }, message: 'ok and the timeline?' });
  await app.instagram.handleWebhook(msgEvent('u52', 'ok and the timeline?', 'm_d3'));
  await settle(app, lead.id);
  assert.strictEqual(sends(graph).length, before + 1, 'the assistant answered the unanswered message');
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

test('someone our team approached is treated as a creator in talks with the team, not as a new client', async () => {
  const seen = [];
  const base = fakeLlm();
  const llm = async (o) => {
    if ((o.system || '').includes('You extract structured facts')) { seen.push(o.messages[0].content); return { refused: [], contact_type: 'creator_in_campaign', creator: { issue: 'asks for 5k' } }; }
    return base(o);
  };
  const { app } = await build({ thread: teamThread(), llm });
  await app.instagram.handleWebhook(msgEvent('u78', 'Can we do 5k?', 'm_k1'));
  const lead = await app.store.getLeadByChat('ig:u78');
  await settle(app, lead.id);
  const after = await app.store.getLead(lead.id);
  assert.strictEqual(after.meta.flags.routed, 'creator_in_campaign');
  assert.strictEqual(after.stage, 'human');
  assert.match(seen[0], /STUDIO TEAM \(a person on our team\): Hi pls see your dm/, 'the model is told which earlier messages were the team');
});

test('in a chat the team is part of, the assistant only sends a short safe acknowledgement (never numbers, prices or questions), and the team gets a follow-up flag', async () => {
  const base = fakeLlm();
  let replySystem = '';
  const llm = async (o) => {
    if ((o.system || '').includes('You extract structured facts')) return { refused: [], phone: '9999061377' };
    replySystem = o.system;
    return 'Thanks! I have noted 9999061377 and our payment terms are 50 percent upfront. Which city is the campaign in?';
  };
  const { app, graph } = await build({ thread: teamThread(), llm });
  await app.instagram.handleWebhook(msgEvent('u79', 'Great, it is 9999061377', 'm_t1'));
  const lead = await app.store.getLeadByChat('ig:u79');
  await settle(app, lead.id);
  assert.match(replySystem, /A person on the studio team has been talking with this person/, 'told it is a team chat');
  const out = sends(graph).map((g) => g.body.message.text);
  assert.strictEqual(out.length, 1);
  assert.ok(!/\d{5,}|payment|\?/.test(out[0]), `unsafe reply was replaced: ${out[0]}`);
  assert.match(out[0], /team will take it forward/);
  const { attentionFor } = require('../core/attention');
  const fresh = await app.store.getLead(lead.id);
  assert.ok(attentionFor(fresh, app.settings.get()).some((i) => i.kind === 'team_followup'), 'the team is told to follow up');
});

const conciergeLlm = (answer) => {
  const base = fakeLlm();
  const seen = [];
  const fn = async (o) => {
    if ((o.system || '').includes('You work the Instagram inbox')) { seen.push(o); return typeof answer === 'function' ? answer(o) : answer; }
    return base(o);
  };
  fn.seen = seen;
  return fn;
};

test('CONCIERGE: reads the whole chat (team messages included) and writes its own reply, no script question', async () => {
  const llm = conciergeLlm({ action: 'reply', reply: 'Got it, thanks! The team will reach out to you there.', needs_team: false, why: 'acknowledged contact details' });
  const { app, graph } = await build({ thread: teamThread(), llm, agentMode: 'concierge' });
  await app.instagram.handleWebhook(msgEvent('u81', 'Great, it is 9999061377', 'm_z1'));
  const lead = await app.store.getLeadByChat('ig:u81');
  await settle(app, lead.id);
  const out = sends(graph).map((g) => g.body.message.text);
  assert.deepStrictEqual(out, ['Got it, thanks! The team will reach out to you there.']);
  const prompt = llm.seen[0].messages[0].content;
  assert.match(prompt, /TEAM \(a person\): Hi pls see your dm/, 'the whole chat, with the team labelled, is in front of the model');
  assert.match(prompt, /CUSTOMER: Could you tell me the commercials/);
  assert.match(llm.seen[0].system, /Today is /, 'it knows the date today');
});

test('CONCIERGE: it can stay silent, and a handoff flags the chat for the team', async () => {
  const llm = conciergeLlm({ action: 'handoff', reply: '', needs_team: true, why: 'asked about her fee' });
  const { app, graph } = await build({ thread: teamThread(), llm, agentMode: 'concierge' });
  await app.instagram.handleWebhook(msgEvent('u82', 'Can we do 5k? That is my minimum', 'm_z2'));
  const lead = await app.store.getLeadByChat('ig:u82');
  await settle(app, lead.id);
  assert.strictEqual(sends(graph).length, 0, 'nothing sent');
  const { attentionFor } = require('../core/attention');
  const items = attentionFor(await app.store.getLead(lead.id), app.settings.get());
  assert.ok(items.some((i) => i.kind === 'concierge' && i.level === 'urgent'), 'the team is told');
});

test('CONCIERGE: a reply that states a price nobody gave it is never sent; the chat goes to a person', async () => {
  const llm = conciergeLlm({ action: 'reply', reply: 'Sure, our fee is Rs 85,000 for that.', needs_team: false, why: 'x' });
  const { app, graph } = await build({ thread: teamThread(), llm, agentMode: 'concierge' });
  await app.instagram.handleWebhook(msgEvent('u83', 'what is your fee', 'm_z3'));
  const lead = await app.store.getLeadByChat('ig:u83');
  await settle(app, lead.id);
  const sentTexts = sends(graph).map((g) => g.body.message.text);
  assert.ok(!sentTexts.some((t) => /85,000/.test(t)), 'the invented price never went out');
  assert.deepStrictEqual(sentTexts, ['Thanks, noted. I have flagged this for the team.'], 'only the safe holding line was sent');
  assert.strictEqual(llm.seen.length, 3, 'it was asked to try again twice, then gave up');
});

test('CONCIERGE shadow mode: the draft is kept on the history and nothing is sent', async () => {
  const llm = conciergeLlm({ action: 'reply', reply: 'Noted, the team will get back to you.', needs_team: false, why: 'x' });
  const { app, graph } = await build({ thread: teamThread(), llm, agentMode: 'concierge', agentShadow: true });
  await app.instagram.handleWebhook(msgEvent('u84', 'ok great', 'm_z4'));
  const lead = await app.store.getLeadByChat('ig:u84');
  await settle(app, lead.id);
  assert.strictEqual(sends(graph).length, 0);
  const ev = (await app.store.all("SELECT data FROM events WHERE lead_id=? AND type='concierge'", lead.id)).map((e) => JSON.parse(e.data));
  assert.strictEqual(ev[0].draft, 'Noted, the team will get back to you.');
});

test('CONCIERGE: scripted nudges and reminders are never sent on Instagram', async () => {
  const llm = conciergeLlm({ action: 'silent', reply: '', needs_team: false, why: 'just thanks' });
  const { app, graph } = await build({ llm, agentMode: 'concierge' });
  await app.instagram.handleWebhook(msgEvent('u85', 'Hi I need a full home redesign', 'm_z5'));
  const lead = await app.store.getLeadByChat('ig:u85');
  await settle(app, lead.id);
  const before = sends(graph).length;
  assert.strictEqual(await app.engine.nudge(lead.id, 'followup'), null);
  assert.strictEqual(sends(graph).length, before);
});

test('ARCHIVE: every chat is stored under its own hash key, and the agent is given that one chat only', async () => {
  const { chatKey } = require('../core/chatkey');
  const llm = conciergeLlm({ action: 'silent', reply: '', needs_team: false, why: 'x' });
  const { app } = await build({ thread: teamThread(), llm, agentMode: 'concierge' });
  await app.instagram.handleWebhook(msgEvent('u91', 'Hello from the FIRST person, about banana campaigns', 'm_a1'));
  await app.instagram.handleWebhook(msgEvent('u92', 'Hello from the SECOND person, about kiwi campaigns', 'm_a2'));
  for (const id of ['ig:u91', 'ig:u92']) { const l = await app.store.getLeadByChat(id); await settle(app, l.id); }
  const prompts = llm.seen.map((o) => o.messages[0].content);
  const first = prompts.find((p) => /banana/.test(p));
  const second = prompts.find((p) => /kiwi/.test(p));
  assert.ok(first && !/kiwi/.test(first), 'the first chat prompt holds nothing from the second');
  assert.ok(second && !/banana/.test(second), 'the second chat prompt holds nothing from the first');
  assert.notStrictEqual(chatKey(IG_ID, 'u91'), chatKey(IG_ID, 'u92'));
  assert.strictEqual(chatKey(IG_ID, 'u91'), chatKey(IG_ID, 'u91'), 'the key is stable');
  assert.match(chatKey(IG_ID, 'u91'), /^[0-9a-f]{24}$/);
  const stored = await app.store.archiveGet(chatKey(IG_ID, 'u91'));
  assert.ok(stored && stored.msgs.length === 4 && stored.msgs[0].text.match(/Etimya|dm/) && /FIRST person/.test(stored.msgs[3].text), 'the earlier chat plus the new message are stored by key, read back with one lookup');
  const ev = (await app.store.all("SELECT lead_id, data FROM events WHERE type='concierge'")).map((e) => JSON.parse(e.data));
  assert.ok(ev.every((e) => /^[0-9a-f]{24}$/.test(e.chat)) && ev.every((e) => e.read_msgs >= 1), 'each decision records which chat key it read and how much');
});

test('CONCIERGE: an email address or link the model made up is never sent; one it was actually given is fine', async () => {
  let n = 0;
  const llm = conciergeLlm(() => (++n <= 3 ? { action: 'reply', reply: 'Sure, reach the team at hello@madeup-agency.com anytime.', needs_team: false, why: 'x' } : { action: 'reply', reply: 'Sure, the team will be in touch here.', needs_team: false, why: 'x' }));
  const { app, graph } = await build({ thread: teamThread(), llm, agentMode: 'concierge' });
  await app.instagram.handleWebhook(msgEvent('u93', 'what is your email', 'm_e1'));
  const lead = await app.store.getLeadByChat('ig:u93');
  await settle(app, lead.id);
  assert.ok(!sends(graph).some((g) => /madeup/.test(g.body.message.text)), 'the invented address never went out');
  assert.strictEqual(sends(graph).length, 1, 'only the safe holding line was sent');
  assert.strictEqual(llm.seen.length, 3, 'it was asked to try again twice before giving up');
  const { checkReply } = require('../core/concierge');
  assert.strictEqual(checkReply('Write to hello@real.com', 'our email is hello@real.com'), 'Write to hello@real.com');
  assert.strictEqual(checkReply('Write to hello@fake.com', 'our email is hello@real.com'), '');
});

test('CONCIERGE: an unreadable first answer is retried and the readable one is used', async () => {
  let n = 0;
  const llm = conciergeLlm(() => (++n === 1 ? 'sorry, here is my thinking...' : { action: 'reply', reply: 'Got it, the team will reach out here.', needs_team: false, why: 'x' }));
  const { app, graph } = await build({ thread: teamThread(), llm, agentMode: 'concierge' });
  await app.instagram.handleWebhook(msgEvent('u94', 'ok send me details', 'm_f1'));
  const lead = await app.store.getLeadByChat('ig:u94');
  await settle(app, lead.id);
  assert.deepStrictEqual(sends(graph).map((g) => g.body.message.text), ['Got it, the team will reach out here.']);
});

test('"are u a bot or a real person?" is a question about the assistant, not a request for a human: the chat is not paused', async () => {
  const base = fakeLlm();
  const llm = async (o) => {
    if ((o.system || '').includes('You extract structured facts')) return { refused: [], wants_human: true };
    if ((o.system || '').includes('You work the Instagram inbox')) return { action: 'reply', reply: 'I am the team assistant, a teammate will follow up.', needs_team: true, why: 'asked if bot' };
    return base(o);
  };
  for (const text of ['wait are u a bot or a real person?', 'r u a bot or real person??', 'is this a bot', 'bot or human? just wanna know']) {
    const { app } = await build({ thread: teamThread(), llm, agentMode: 'concierge' });
    await app.instagram.handleWebhook(msgEvent('u95', text, 'm_bot1'));
    const lead = await app.store.getLeadByChat('ig:u95');
    await settle(app, lead.id);
    const after = await app.store.getLead(lead.id);
    assert.ok(!after.ai_paused, `"${text}" must not pause the chat`);
    assert.ok(!(after.meta.flags || {}).wants_human, `"${text}" must not count as asking for a person`);
  }
});

test('CONCIERGE reply checks: no confirmed call times, no bullet lists, nothing long', () => {
  const { checkReply } = require('../core/concierge');
  const g = 'chat text';
  assert.strictEqual(checkReply('Got it, we will have the team call you on Monday at 11 am.', g), '', 'a settled call time is rejected');
  assert.strictEqual(checkReply('Sure, I will ask the team to confirm a Monday 11 am slot with you.', g), 'Sure, I will ask the team to confirm a Monday 11 am slot with you.', 'a call time the team will confirm is fine');
  assert.strictEqual(checkReply('Here is the recap:\n- Option one\n- Option two', g), '');
  assert.strictEqual(checkReply('Option 1 • reel • repost', g), '');
  assert.strictEqual(checkReply('a'.repeat(400), g), '');
  assert.strictEqual(checkReply('Thanks, the team will be in touch here shortly.', g), 'Thanks, the team will be in touch here shortly.');
});

test('CONCIERGE: a video or file is handed to the concierge with the whole chat, not answered with the canned "cannot open attachments" line', async () => {
  const llm = conciergeLlm({ action: 'reply', reply: 'Got it, thanks for sending it over. The team will review it.', needs_team: true, why: 'sent the video the team asked for' });
  const { app, graph } = await build({ thread: teamThread(), llm, agentMode: 'concierge' });
  const ev = { object: 'instagram', entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: 'u96' }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid: 'm_v1', attachments: [{ type: 'video', payload: { url: 'https://cdn.example.com/v.mp4' } }] } }] }] };
  await app.instagram.handleWebhook(ev);
  const lead = await app.store.getLeadByChat('ig:u96');
  await settle(app, lead.id);
  const out = sends(graph).map((g) => g.body.message.text);
  assert.deepStrictEqual(out, ['Got it, thanks for sending it over. The team will review it.']);
  assert.ok(!out.some((t) => /cannot open attachments/i.test(t)));
  assert.match(llm.seen[0].messages[0].content, /\[sent a video\]/);
});

test('ARCHIVE LOOKUP: the assistant looks the chat up by its hash key and reads history that is only in the archive; each message once; the archive stays complete', async () => {
  const { chatKey } = require('../core/chatkey');
  const llm = conciergeLlm({ action: 'reply', reply: 'Noted, the team will look at it.', needs_team: false, why: 'x' });
  const { app, graph } = await build({ llm, agentMode: 'concierge' }); // no live thread from Instagram: the history exists ONLY in the archive
  const T = Date.now() - 5 * 86400000;
  await app.store.archiveUpsert({ conv_id: 'c-arch', chat_key: chatKey(IG_ID, 'u98'), igsid: 'u98', username: 'someone', last_at: T + 7200000, msgs: [
    { mid: 'a1', at: T, fromUs: true, text: 'Hi! We have a barter collab with Maison Attire for you, a talking story.' },
    { mid: 'a2', at: T + 3600000, fromUs: false, text: 'Sounds interesting, what do I get?' },
    { mid: 'a3', at: T + 7200000, fromUs: true, text: 'You keep the outfit they send.' },
  ] });
  await app.instagram.handleWebhook(msgEvent('u98', 'ok when do I have to post it', 'm_arch1'));
  const lead = await app.store.getLeadByChat('ig:u98');
  await settle(app, lead.id);
  const prompt = llm.seen[0].messages[0].content;
  assert.match(prompt, /TEAM \(a person\): Hi! We have a barter collab with Maison Attire/, 'history came from the archive, found by the hash key');
  assert.match(prompt, /CUSTOMER: Sounds interesting, what do I get\?/);
  assert.strictEqual((prompt.match(/You keep the outfit/g) || []).length, 1, 'each message appears once');
  const ev = (await app.store.all("SELECT data FROM events WHERE lead_id=? AND type='concierge'", lead.id)).map((e) => JSON.parse(e.data))[0];
  assert.strictEqual(ev.chat, chatKey(IG_ID, 'u98'));
  assert.strictEqual(ev.archive_msgs, 3);
  const after = await app.store.archiveGet(chatKey(IG_ID, 'u98'));
  assert.deepStrictEqual(after.msgs.map((m) => m.text).slice(-2), ['ok when do I have to post it', 'Noted, the team will look at it.'], 'the new message and the reply were added to the archive under the same key');
  assert.strictEqual(sends(graph).length, 1);
});

test('CONCIERGE reply checks: it never claims an action it did not take, and never promises an outcome the team has not decided', () => {
  const { checkReply } = require('../core/concierge');
  const g = 'chat';
  for (const bad of ["We've resent our contact email, please check spam.", 'I have emailed the details to you.', 'We have booked the shoot for you.', "We'll check for paid opportunities and get back to you.", "I'll try to get you a better rate.", 'We just sent it again.']) assert.strictEqual(checkReply(bad, g), '', `should be rejected: ${bad}`);
  for (const ok of ['Got it, I have passed this to the team and they will reply here.', 'Noted, the team will look into it and get back to you.', 'Thanks, the team will confirm the time with you.']) assert.strictEqual(checkReply(ok, g), ok, `should be allowed: ${ok}`);
});

test('CONCIERGE: it never repeats its own previous message word for word', () => {
  const { checkReply } = require('../core/concierge');
  const prev = 'Got it, we will have the team review your commercial details and get back to you shortly.';
  assert.strictEqual(checkReply('Got it, we will have the team review your commercial details and get back to you shortly.', 'x', { previous: prev }), '');
  assert.notStrictEqual(checkReply('Thanks, noted. Anything else you want the team to know?', 'x', { previous: prev }), '');
});

test('CONCIERGE guards read curly apostrophes, and catch the overpromises found in the real-chat replays', () => {
  const { checkReply } = require('../core/concierge');
  const g = 'chat';
  const bad = [
    'Sure, we’ll arrange a call. Could you share a few time slots?',
    'Got it, we’ll check for paid opportunities and get back to you soon.',
    'We’ll have the team review your details and get back with paid collaboration options.',
    'Sure, we’ll send over the reference story video shortly.',
    'We’ll share the reference video and follow up on the details.',
    'Got it, we’ll have the team resend the contact details to your email right away.',
    'Enjoy your break and we’ll touch base after 4 Nov.',
    'Got it, I’ll pass this to the team and they’ll get back to you about the payout details.',
  ];
  for (const b of bad) assert.strictEqual(checkReply(b, g), '', `should be rejected: ${b}`);
  const ok = ['Got it, I’ll pass this to the team and they’ll get back to you shortly.', 'Thanks for sharing your rate, I’ll pass it to the team.', 'Sure, I’ll ask the team to confirm a Monday 11 am slot with you.', 'You’re welcome!'];
  for (const o of ok) assert.notStrictEqual(checkReply(o, g), '', `should be allowed: ${o}`);
});

test('CONCIERGE: it does not ask for the same thing again when the customer has not given it, even in different words', () => {
  const { checkReply } = require('../core/concierge');
  const recent = ['Could you share your Instagram handle, city and the content niche you focus on?'];
  assert.strictEqual(checkReply('Could you also share your Instagram handle and the niche you create content in?', 'x', { recent }), '');
  assert.strictEqual(checkReply('Could you share your Instagram handle so we can check your profile?', 'x', { recent }), '');
  assert.notStrictEqual(checkReply('Got it, thanks. The team will review and get back to you here.', 'x', { recent }), '');
  assert.notStrictEqual(checkReply('Which brand are you reaching out for?', 'x', { recent }), '');
});

test('CONCIERGE: contact details may only come from the approved business facts, never from the chat (the customer\'s own email is not ours)', () => {
  const { checkReply } = require('../core/concierge');
  const chat = 'customer wrote: my email is itsme@rjaditi.com and my number is +91 8591610679';
  const facts = 'Business facts: reach the studio at hello@approved-agency.com';
  assert.strictEqual(checkReply('Sure, you can reach us at itsme@rjaditi.com.', chat + facts, { contactGrounding: facts }), '');
  assert.strictEqual(checkReply('You can save Jyoti\'s contact: Phone 8591610679.', chat + facts, { contactGrounding: facts }), '');
  assert.strictEqual(checkReply('You can reach us at hello@approved-agency.com.', chat + facts, { contactGrounding: facts }), 'You can reach us at hello@approved-agency.com.');
  assert.notStrictEqual(checkReply('Thanks, the team will reach out to you there.', chat + facts, { contactGrounding: facts }), '');
});

test('CONCIERGE: the last overpromises from the real-chat replays are blocked', () => {
  const { checkReply } = require('../core/concierge');
  for (const b of ['Sure, we can set up a call.', 'Noted, 4 pm works for us.', 'We’ll review your rate and get back to you after the 4th.', 'Got it, we’ll keep you in mind for paid collaborations only.', 'Sure, we’ll get the story reference over to you shortly.', 'We’ll consider it when matching you with campaigns.']) assert.strictEqual(checkReply(b, 'x'), '', `should be rejected: ${b}`);
  for (const o of ['Sure, I will ask the team to confirm a call with you.', 'Got it, we’ll get back to you shortly.', 'Thanks, noted. I have flagged this for the team.']) assert.notStrictEqual(checkReply(o, 'x'), '', `should be allowed: ${o}`);
});

test('CONCIERGE: when every attempt is rejected the customer still gets a short holding line (a person is flagged), but nothing when they only said ok', async () => {
  const llm = conciergeLlm({ action: 'reply', reply: 'Sure, we can set up a call and we’ll send you the brief.', needs_team: false, why: 'x' });
  const { app, graph } = await build({ thread: teamThread(), llm, agentMode: 'concierge' });
  await app.instagram.handleWebhook(msgEvent('u99', 'Is it possible to get on a call with someone from the team?', 'm_h1'));
  const lead = await app.store.getLeadByChat('ig:u99');
  await settle(app, lead.id);
  assert.deepStrictEqual(sends(graph).map((g) => g.body.message.text), ['Thanks, noted. I have flagged this for the team.']);
  await app.instagram.handleWebhook(msgEvent('u99', 'ok', 'm_h2'));
  await settle(app, lead.id);
  assert.strictEqual(sends(graph).length, 1, 'a bare ok gets nothing');
});

test('editor pass: a faulty draft is replaced by the corrected reply, and a failing editor never loses the reply', async () => {
  const { Concierge } = require('../core/concierge');
  const settings = { business: { name: 'Glad U Came', tagline: 'PR', description: 'PR agency', services: ['PR'], areas: 'India', pricing_note: 'on request', timezone: 'Asia/Kolkata' } };
  const store = { kvGet: async (k, d) => d };
  const now = Date.now();
  const rows = [
    { direction: 'out', role: 'admin', text: 'Hi! Could you share your commercials for one reel?', created_at: now - 60000 },
    { direction: 'in', text: 'Sure, 1 reel is 10000 rupees', created_at: now - 1000 },
  ];
  const writer = JSON.stringify({ action: 'reply', reply: 'Thanks for sharing, I have noted your commercials and the team will review them.', needs_team: true, why: 'rate shared' });
  let calls = 0;
  const llm = { complete: async () => { calls++; if (calls === 1) return writer; return JSON.stringify({ verdict: 'fix', issues: 'too generic', reply: 'Thanks, your commercials are noted and with the team. Which beauty brands do you love working with?' }); } };
  const c = new Concierge({ llm, store, log: { log() {}, warn() {}, error() {} } });
  const out = await c.respond({ lead: {}, rows, settings, now });
  assert.equal(out.judge.verdict, 'fixed');
  assert.match(out.text, /beauty brands/);
  calls = 0;
  const llm2 = { complete: async () => { calls++; if (calls === 1) return writer; throw new Error('boom'); } };
  const c2 = new Concierge({ llm: llm2, store, log: { log() {}, warn() {}, error() {} } });
  const out2 = await c2.respond({ lead: {}, rows, settings, now });
  assert.match(out2.text, /commercials/);
  assert.equal(out2.judge.verdict, 'send');
});
