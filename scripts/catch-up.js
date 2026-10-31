'use strict';
// Catches the inbox up after an outage (for example a dead Instagram token): finds the customers who wrote and never got an answer,
// then lets the assistant answer them with the whole chat in front of it.
//
//   node scripts/catch-up.js --hours=3 --dry-run     only list what it would do
//   node scripts/catch-up.js --hours=3               do it (sends real replies)
//   add --skip-api to work from the database only (no Instagram calls; useful while the token is still dead)
//
// 1. Replies that were written but never left (status failed/pending) are removed from the chat, and the customer messages they were
//    answering are marked unprocessed again, so the assistant answers them once the token works.
// 2. Instagram is asked for the conversations updated in the window; any customer message that never reached the database
//    (a missed webhook) is fed in as if it had just arrived.
// 3. Everything unprocessed is answered.
const config = require('../core/config');
const { createApp } = require('../core/app');
const { Store } = require('../core/db');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const hours = Number(arg('hours', 3));
const dry = flag('dry-run');
const skipApi = flag('skip-api');
const since = Date.now() - hours * 3600 * 1000;
const quiet = { log() {}, warn() {}, error() {} };
const say = (s) => console.log(s);

(async () => {
  const store = await Store.open({ url: config.databaseUrl, file: config.dbPath });
  const app = await createApp({ ...config, agentMode: 'concierge', agentShadow: false }, { store, log: quiet, seed: false });
  const ig = app.instagram;
  let acct = String(config.instagram.accountId || '');

  if (!skipApi) {
    try { await ig.start(); await ig.api('GET', '/me', { query: { fields: 'user_id,username' } }, { retries: 1 }); acct = String((ig.me && ig.me.user_id) || acct); app.engine.igAccountId = acct; config.instagram.accountId = acct; say(`Instagram token works for @${ig.handle} (account ${acct})`); }
    catch (e) { say(`Instagram token does not work: ${e.message}`); process.exit(1); }
  }

  // 1. replies that never left
  const ghosts = await store.all("SELECT id, lead_id, text, status, created_at FROM messages WHERE direction='out' AND role<>'admin' AND status IN ('failed','pending','sending') AND created_at>=? ORDER BY id", since);
  const reset = new Set();
  for (const g of ghosts) {
    const lastSent = await store.get("SELECT MAX(id) AS id FROM messages WHERE lead_id=? AND direction='out' AND status='sent'", g.lead_id);
    const redo = await store.all("SELECT id FROM messages WHERE lead_id=? AND direction='in' AND id>? AND id<?", g.lead_id, (lastSent && lastSent.id) || 0, g.id);
    say(`lead ${g.lead_id}: reply never sent (${g.status}): "${String(g.text).slice(0, 70)}"; ${redo.length} customer message(s) to answer again`);
    if (!dry) {
      await store.run('DELETE FROM messages WHERE id=?', g.id);
      for (const r of redo) await store.run('UPDATE messages SET processed=0 WHERE id=?', r.id);
    }
    reset.add(g.lead_id);
  }

  // 2. customer messages the database never received
  let injected = 0;
  if (!skipApi) {
    const list = await ig.api('GET', '/me/conversations', { query: { platform: 'instagram', fields: 'id,updated_time', limit: '50' } }, { retries: 2 });
    for (const c of (list.data || []).filter((x) => Date.parse(x.updated_time) >= since)) {
      const conv = await ig.api('GET', `/${c.id}`, { query: { fields: 'messages.limit(8){id,created_time,from,message}' } }, { retries: 2 });
      const msgs = ((conv.messages && conv.messages.data) || []).sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
      const last = msgs[msgs.length - 1];
      if (!last || !last.from || String(last.from.id) === acct || !String(last.message || '').trim()) continue; // last word is ours, or not text
      const inDb = await store.get('SELECT id FROM messages WHERE ext_id=?', last.id);
      if (inDb) continue;
      say(`missed message from ${last.from.username || last.from.id} at ${last.created_time}: "${String(last.message).slice(0, 70)}"`);
      injected++;
      if (!dry) await ig.handleEvent({ sender: { id: String(last.from.id) }, recipient: { id: acct }, timestamp: Date.parse(last.created_time), message: { mid: last.id, text: last.message } }, acct);
    }
  }

  // 3. answer everything that is waiting
  const waiting = await store.all("SELECT DISTINCT lead_id FROM messages WHERE direction='in' AND processed=0");
  say(`${waiting.length} chat(s) waiting for an answer${dry ? ' (dry run: nothing changed)' : ''}`);
  if (!dry) {
    await app.engine.recover({ olderThanMs: 0, backfill: false, wait: true });
    await app.engine.idle?.();
    say('Done. Replies sent:');
    for (const w of waiting) {
      const out = await store.get("SELECT text, status FROM messages WHERE lead_id=? AND direction='out' ORDER BY id DESC LIMIT 1", w.lead_id);
      say(`  lead ${w.lead_id}: [${out ? out.status : 'none'}] ${out ? String(out.text).slice(0, 110) : ''}`);
    }
  }
  say(`Summary: ${reset.size} chat(s) reset, ${injected} missed message(s) found.`);
  await store.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
