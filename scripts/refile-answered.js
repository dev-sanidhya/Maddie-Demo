'use strict';
// Finds leads that sit in "Needs human" although somebody on the team (or the assistant) already had the last word in the chat,
// refreshing each chat from Instagram first, then lets the CRM judge file them again (quietly: no team alerts, no webhooks).
//   node scripts/refile-answered.js            list them only
//   node scripts/refile-answered.js --apply    re-file them
//   options: --stages=human,qualifying,new   --concurrency=N
const config = require('../core/config');
const { createApp } = require('../core/app');
const { Store } = require('../core/db');
const { chatKey } = require('../core/chatkey');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const apply = process.argv.includes('--apply');
const stages = arg('stages', 'human').split(',');
const conc = Number(arg('concurrency', 3));
const quiet = { log() {}, warn() {}, error() {} };
const parse = (m) => (typeof m === 'string' ? JSON.parse(m || '{}') : m || {});

(async () => {
  const store = await Store.open({ url: config.databaseUrl, file: config.dbPath });
  const app = await createApp({ ...config, agentMode: 'concierge', agentShadow: true }, { store, log: quiet, seed: false });
  await app.instagram.start().catch(() => {});
  const me = await app.instagram.api('GET', '/me', { query: { fields: 'user_id' } }, { retries: 2 });
  const acct = String(me.user_id);
  app.engine.igAccountId = acct;
  const leads = (await store.all("SELECT id, name, stage, ai_paused, stage_locked, chat_id, meta FROM leads WHERE channel='instagram' ORDER BY id")).filter((l) => stages.includes(l.stage));
  console.log(`${leads.length} Instagram leads in ${stages.join('/')}; refreshing each chat from Instagram...`);
  const answered = []; const waiting = []; const failed = [];
  const queue = leads.slice();
  let n = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (queue.length) {
      const l = queue.shift();
      try {
        const igsid = String(l.chat_id || '').replace(/^ig:/, '');
        await app.instagram.fetchThread(igsid, 20);
        const a = await store.archiveGet(chatKey(acct, igsid));
        const msgs = (a && a.msgs) || [];
        const last = msgs.reduce((m, x) => (!m || Number(x.at) >= Number(m.at) ? x : m), null);
        if (!last) { failed.push(l.id); continue; }
        (last.fromUs ? answered : waiting).push({ l, last });
      } catch (e) { failed.push(l.id); }
      if (++n % 40 === 0) console.log(`... ${n}/${leads.length}`);
    }
  }));
  const locked = answered.filter((x) => x.l.stage_locked).length;
  const paused = answered.filter((x) => x.l.ai_paused && !x.l.stage_locked).length;
  console.log(`\nStill waiting on the team (customer spoke last): ${waiting.length}`);
  console.log(`Already answered (we or the team spoke last): ${answered.length}  (${paused} of them are paused chats, ${locked} have a stage set by hand)`);
  console.log(`Could not read: ${failed.length}`);
  if (!apply) { console.log('\nDry run. Add --apply to re-file the answered ones.'); process.exit(0); }
  const moves = []; let undecided = 0;
  const q2 = answered.filter((x) => !x.l.stage_locked).map((x) => x.l.id);
  await Promise.all(Array.from({ length: conc }, async () => {
    while (q2.length) {
      const id = q2.shift();
      try {
        const r = await app.engine.placeLead(id, { quiet: true });
        if (r.failed) undecided++;
        else if (r.placed && r.stage !== r.prevStage) moves.push(`#${id}: ${r.prevStage} -> ${r.stage} [${r.category}] ${r.reason}`);
      } catch (e) { undecided++; }
    }
  }));
  await app.engine.settle();
  console.log(moves.join('\n'));
  console.log(`\nRe-filed ${answered.length - locked}: ${moves.length} moved, ${undecided} could not be decided (left as they were).`);
  const after = {};
  for (const x of answered) { const f = await store.getLead(x.l.id); after[f.stage] = (after[f.stage] || 0) + 1; }
  console.log('stage of the answered leads now:', JSON.stringify(after));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
