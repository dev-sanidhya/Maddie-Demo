'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Store } = require('../core/db');
const { createApp } = require('../core/app');
const config = require('../core/config');
const { parseWhen, partsIn, zonedEpoch } = require('../core/when');
const { isAvailable, suggestSlots, pickOrdinal, GoogleCalendar, Calendar } = require('../core/calendar');
const { DEFAULTS, sanitize } = require('../core/settings');

const TZ = 'Asia/Kolkata';
const MIN = 60000;
const HOUR = 3600000;
const silent = { log() {}, warn() {}, error() {} };
const ist = (iso) => Date.parse(`${iso}+05:30`);
const CFG = { enabled: true, calendar_id: 'owner@example.com', work_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], work_start_hour: 10, work_end_hour: 19, slot_minutes: 30, buffer_min: 15, min_notice_min: 120, max_days_ahead: 14 };
const MON_MORNING = ist('2026-10-12T08:00:00'); // a Monday, before opening

test('a slot is available only inside working hours, on working days, with notice and no clash', () => {
  const busy = [{ start: ist('2026-10-12T14:00:00'), end: ist('2026-10-12T15:00:00') }];
  assert.ok(isAvailable(ist('2026-10-12T11:00:00'), CFG, busy, TZ, MON_MORNING));
  assert.ok(!isAvailable(ist('2026-10-12T09:00:00'), CFG, busy, TZ, MON_MORNING), 'before opening');
  assert.ok(!isAvailable(ist('2026-10-12T18:45:00'), CFG, busy, TZ, MON_MORNING), 'would run past closing');
  assert.ok(!isAvailable(ist('2026-10-12T14:30:00'), CFG, busy, TZ, MON_MORNING), 'inside a busy block');
  assert.ok(!isAvailable(ist('2026-10-12T13:40:00'), CFG, busy, TZ, MON_MORNING), 'the 15 minute buffer before a meeting');
  assert.ok(isAvailable(ist('2026-10-12T15:15:00'), CFG, busy, TZ, MON_MORNING), 'free again after the buffer');
  assert.ok(!isAvailable(ist('2026-10-18T11:00:00'), CFG, [], TZ, MON_MORNING), 'Sunday is a day off');
  assert.ok(!isAvailable(ist('2026-10-12T09:30:00'), { ...CFG, work_start_hour: 6 }, [], TZ, ist('2026-10-12T08:00:00')), 'less than 2 hours notice');
});

test('suggestions are real free slots: nearest to a request, or spread over days when none was made', () => {
  const busy = [{ start: ist('2026-10-12T16:00:00'), end: ist('2026-10-12T18:00:00') }];
  const near = suggestSlots(CFG, busy, TZ, { now: MON_MORNING, requested: ist('2026-10-12T17:00:00') });
  assert.strictEqual(near.length, 3);
  for (const t of near) assert.ok(isAvailable(t, CFG, busy, TZ, MON_MORNING));
  const spread = suggestSlots(CFG, busy, TZ, { now: MON_MORNING });
  assert.strictEqual(spread.length, 3);
  const days = new Set(spread.map((t) => partsIn(t, TZ).d));
  assert.strictEqual(days.size, 3, 'three different days');
  for (const t of spread) assert.ok(isAvailable(t, CFG, busy, TZ, MON_MORNING));
  assert.deepStrictEqual(suggestSlots({ ...CFG, work_days: ['Sun'], max_days_ahead: 3 }, [], TZ, { now: ist('2026-10-12T08:00:00') }), [], 'nothing free means no options, not made-up ones');
});

test('"the second one" picks the right option', () => {
  assert.strictEqual(pickOrdinal('the second one works', 3), 1);
  assert.strictEqual(pickOrdinal('option 3 please', 3), 2);
  assert.strictEqual(pickOrdinal('first', 3), 0);
  assert.strictEqual(pickOrdinal('hmm none of these', 3), -1);
  assert.strictEqual(pickOrdinal('third', 2), -1, 'there is no third option');
});

test('settings keep the calendar values sane', () => {
  const s = sanitize({ ...JSON.parse(JSON.stringify(DEFAULTS)), calendar: { ...CFG, work_days: 'mon, wed, xyz', work_start_hour: 30, work_end_hour: 2, slot_minutes: 5 } });
  assert.deepStrictEqual(s.calendar.work_days, ['mon', 'wed']);
  assert.ok(s.calendar.work_end_hour > s.calendar.work_start_hour);
  assert.strictEqual(s.calendar.slot_minutes, 15);
});

test('Google client: signs a valid JWT, reads busy time and writes the event', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { client_email: 'funnel@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('oauth2.googleapis.com')) {
      const jwt = new URLSearchParams(opts.body).get('assertion');
      const [h, p, sig] = jwt.split('.');
      assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')), 'signature verifies');
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      assert.strictEqual(claims.iss, account.client_email);
      assert.match(claims.scope, /auth\/calendar/);
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    }
    if (String(url).endsWith('/freeBusy')) return { ok: true, status: 200, json: async () => ({ calendars: { 'owner@example.com': { busy: [{ start: '2026-10-12T09:00:00Z', end: '2026-10-12T10:00:00Z' }] } } }) };
    if (opts.method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'evt1', htmlLink: 'https://cal/evt1' }) };
    return { ok: true, status: 204, json: async () => ({}) };
  };
  const g = new GoogleCalendar({ account, fetchImpl });
  assert.ok(g.configured);
  const busy = await g.busy('owner@example.com', 0, 1e12);
  assert.deepStrictEqual(busy, [{ start: Date.parse('2026-10-12T09:00:00Z'), end: Date.parse('2026-10-12T10:00:00Z') }]);
  const ev = await g.createEvent('owner@example.com', { summary: 'x' });
  assert.strictEqual(ev.id, 'evt1');
  assert.strictEqual(calls.filter((c) => c.url.includes('oauth2')).length, 1, 'token is cached');
  assert.ok(await g.test('owner@example.com', TZ));
  assert.ok(calls.some((c) => c.opts.method === 'DELETE'), 'the connection test cleans up after itself');
});

// ---------- the whole chat ----------
function fakeLlm() {
  return async (o) => {
    const sys = o.system || '';
    if (sys.includes('You extract structured facts')) {
      const text = (o.messages[0].content.match(/"""\n([\s\S]*?)\n"""/) || [])[1] || '';
      const out = { refused: [] };
      if (/kitchen/i.test(text)) { out.project_type = 'Modular kitchen'; out.scope = 'modular kitchen'; }
      const city = text.match(/\bin ([A-Z][a-z]+)/);
      if (city) out.city = city[1];
      const lakh = text.match(/(\d+(?:\.\d+)?)\s*lakh/i);
      if (lakh) out.budget_amount = Number(lakh[1]) * 100000;
      const months = text.match(/(\d+)\s*months?/i);
      if (months) { out.timeline_months = Number(months[1]); out.timeline_text = `${months[1]} months`; }
      return out;
    }
    const offer = sys.match(/call times and no others: (.+?)\. Ask which/);
    if (offer) return `${/is not available/.test(sys) ? 'That time is taken. ' : ''}I can do ${offer[1]}. Which suits you?`;
    const confirm = sys.match(/ on (.+?)\."/);
    if (confirm) return `Perfect, we will call you ${confirm[1]}.`;
    return 'Thanks, noted.';
  };
}

async function build() {
  const sent = [];
  const events = [];
  let busy = [];
  const app = await createApp({ ...config, telegramToken: '' }, { store: await Store.open({ file: ':memory:' }), llmOverride: fakeLlm(), debounceMs: 0, log: silent });
  app.engine.transports.instagram = { send: async (lead, text) => { sent.push(text); }, typing: async () => {}, sendRaw: async () => {} };
  await app.settings.update({ calendar: { ...CFG, work_days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], work_start_hour: 0, work_end_hour: 24, min_notice_min: 0, buffer_min: 0 } });
  let n = 0;
  const google = {
    configured: true, email: 'funnel@proj.iam.gserviceaccount.com',
    busy: async () => busy,
    createEvent: async (id, ev) => { events.push({ op: 'create', ev }); return { id: `e${++n}`, htmlLink: `https://cal/e${n}` }; },
    updateEvent: async (id, eid, ev) => { events.push({ op: 'update', eid, ev }); return { id: eid, htmlLink: `https://cal/${eid}` }; },
    deleteEvent: async (id, eid) => { events.push({ op: 'delete', eid }); },
  };
  app.engine.calendar = new Calendar({ google, settings: app.settings, log: silent });
  return { app, sent, events, setBusy: (b) => { busy = b; } };
}
const settle = async (app, id) => { await app.engine.idle(id); await new Promise((r) => setTimeout(r, 25)); await app.engine.idle(id); await app.engine.settle(); };

async function qualified(app, chat = 'ig:6001') {
  const lead = await app.store.createLead({ channel: 'instagram', chat_id: chat, name: 'Riya', source: 'instagram', meta: {} });
  let n = 0;
  const say = async (t) => { await app.engine.receive({ channel: 'instagram', chatId: chat, text: t, externalId: `${chat}-${++n}` }); await settle(app, lead.id); };
  await say('Hi');
  await say('modular kitchen in Pune');
  await say('my budget is 9 lakh');
  await say('want to start in 2 months');
  return { lead, say };
}

test('a qualified lead is offered real free call times, and a free time they name is booked', async () => {
  const { app, sent, events } = await build();
  const { lead, say } = await qualified(app);
  assert.match(sent[sent.length - 1], /I can do .*(AM|PM)/, 'concrete options from the calendar, not "what suits you"');
  assert.strictEqual((await app.store.getLead(lead.id)).meta.offered.length, 3);

  await say('tomorrow 5 pm works');
  const want = parseWhen('tomorrow 5 pm', Date.now(), TZ).at;
  const l = await app.store.getLead(lead.id);
  assert.strictEqual(l.callback_at, want);
  assert.strictEqual(events.filter((e) => e.op === 'create').length, 1);
  assert.strictEqual(events[0].ev.start.dateTime, new Date(want).toISOString());
  assert.match(events[0].ev.summary, /Riya/);
  assert.strictEqual(l.meta.cal.event_id, 'e1');
  assert.match(sent[sent.length - 1], /we will call you/);
  assert.ok((await app.store.getEvents(lead.id)).some((e) => e.type === 'calendar_booked'));
});

test('a busy time is refused with alternatives, and "the second one" books that option', async () => {
  const { app, sent, events, setBusy } = await build();
  const { lead, say } = await qualified(app, 'ig:6002');
  const want = parseWhen('tomorrow 5 pm', Date.now(), TZ).at;
  setBusy([{ start: want - 30 * MIN, end: want + 60 * MIN }]);

  await say('tomorrow 5 pm works');
  let l = await app.store.getLead(lead.id);
  assert.strictEqual(l.callback_at, null, 'the busy time is not kept');
  assert.strictEqual(events.length, 0, 'nothing is put on the calendar');
  assert.match(sent[sent.length - 1], /That time is taken/);
  const offered = l.meta.offered;
  assert.strictEqual(offered.length, 3);
  for (const t of offered) assert.ok(t < want - 30 * MIN || t >= want + 60 * MIN, 'every option avoids the busy block');

  await say('the second one please');
  l = await app.store.getLead(lead.id);
  assert.strictEqual(l.callback_at, offered[1]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].ev.start.dateTime, new Date(offered[1]).toISOString());
  assert.strictEqual(l.meta.offered, undefined, 'the options are cleared once one is chosen');
});

test('rescheduling in the admin moves the calendar event, cancelling removes it', async () => {
  const { app, events } = await build();
  const { lead, say } = await qualified(app, 'ig:6003');
  await say('tomorrow 5 pm works');
  assert.strictEqual(events.length, 1);
  const later = parseWhen('tomorrow 5 pm', Date.now(), TZ).at + 2 * HOUR;
  await app.engine.setCallback(lead.id, later);
  await app.engine.settle();
  assert.deepStrictEqual(events.map((e) => e.op), ['create', 'update']);
  assert.strictEqual(events[1].ev.start.dateTime, new Date(later).toISOString());
  await app.engine.setCallback(lead.id, null);
  await app.engine.settle();
  assert.strictEqual(events[2].op, 'delete');
  assert.strictEqual((await app.store.getLead(lead.id)).meta.cal, undefined);
});

test('sample and test leads never touch the real calendar; a calendar outage never breaks the chat', async () => {
  const { app, sent, events } = await build();
  const demo = await app.store.createLead({ channel: 'instagram', chat_id: 'ig:demo1', name: 'Demo', stage: 'active', callback_at: Date.now() + 3 * HOUR, callback_status: 'scheduled', meta: { demo: true } });
  await app.engine.syncCalendar(demo.id);
  assert.strictEqual(events.length, 0);

  app.engine.calendar.google.busy = async () => { throw new Error('Google is down'); };
  const { lead, say } = await qualified(app, 'ig:6004');
  await say('tomorrow 5 pm works');
  assert.ok(sent.length >= 5, 'Aria still answered every message');
  assert.ok((await app.store.getEvents(lead.id)).some((e) => e.type === 'calendar_error'));
});

test('with the calendar off, behaviour is exactly as before (Aria asks for a time)', async () => {
  const { app, sent } = await build();
  await app.settings.update({ calendar: { enabled: false } });
  await qualified(app, 'ig:6005');
  assert.doesNotMatch(sent[sent.length - 1], /I can do/);
});
