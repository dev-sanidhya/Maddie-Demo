'use strict';
// Files every Instagram lead with the CRM judge (category + stage), reading each whole chat.
//   node scripts/place-all.js --dry-run          show what would change, write nothing
//   node scripts/place-all.js                    do it (quietly: no team alerts, no webhooks)
//   options: --only=ID,ID   --limit=N   --concurrency=N
const config = require('../core/config');
const { createApp } = require('../core/app');
const { Store } = require('../core/db');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const dry = process.argv.includes('--dry-run');
const only = arg('only', '') ? arg('only', '').split(',').map(Number) : null;
const limit = Number(arg('limit', 0)) || 0;
const conc = Number(arg('concurrency', 4));
const quiet = { log() {}, warn() {}, error() {} };

(async () => {
  const store = await Store.open({ url: config.databaseUrl, file: config.dbPath });
  const app = await createApp({ ...config, agentMode: 'concierge', agentShadow: true }, { store, log: quiet, seed: false });
  const acct = String(config.instagram.accountId || '');
  app.engine.igAccountId = acct;
  let leads = await store.all("SELECT id, name, stage, stage_locked, ai_paused, meta FROM leads WHERE channel='instagram' ORDER BY id");
  if (only) leads = leads.filter((l) => only.includes(l.id));
  if (limit) leads = leads.slice(0, limit);
  const parse = (m) => (typeof m === 'string' ? JSON.parse(m || '{}') : m || {});
  const settings = app.settings.get();
  const before = {}; const after = {};
  const moves = [];
  let failed = 0; let skipped = 0; let i = 0;
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const one = async (l) => {
    bump(before, l.stage);
    if (dry) {
      const lead = await store.getLead(l.id);
      const ctx = await app.engine.concierge.loadChat({ lead, newRows: [], accountId: acct });
      if (!ctx.rows.some((m) => m.direction === 'in')) { skipped++; bump(after, l.stage); return; }
      const p = await app.engine.concierge.classify({ lead, rows: ctx.rows, settings, current: { category: parse(l.meta).crm_ai && parse(l.meta).crm_ai.category, stage: l.stage, by: l.stage_locked ? 'admin' : 'agent' } });
      if (!p) { failed++; bump(after, l.stage); return; }
      const finalStage = l.stage_locked ? l.stage : (l.ai_paused ? 'human' : p.stage);
      bump(after, finalStage);
      if (finalStage !== l.stage) moves.push(`#${l.id} ${l.name || ''}: ${l.stage} -> ${finalStage} [${p.category}] ${p.reason}`);
      return;
    }
    const r = await app.engine.placeLead(l.id, { quiet: true });
    const fresh = await store.getLead(l.id);
    bump(after, fresh.stage);
    if (r.skipped) skipped++;
    else if (r.failed) failed++;
    else if (r.stage !== r.prevStage) moves.push(`#${l.id} ${l.name || ''}: ${r.prevStage} -> ${r.stage} [${r.category}] ${r.reason}`);
  };
  const queue = leads.slice();
  await Promise.all(Array.from({ length: conc }, async () => { while (queue.length) { const l = queue.shift(); try { await one(l); } catch (e) { failed++; console.log(`#${l.id} error: ${e.message}`); } if (++i % 25 === 0) console.log(`... ${i}/${leads.length}`); } }));
  await app.engine.settle();
  console.log(moves.join('\n'));
  console.log(`\n${dry ? 'DRY RUN. ' : ''}${leads.length} leads: ${moves.length} moved, ${skipped} skipped, ${failed} could not be decided (left as they were)`);
  console.log('before:', JSON.stringify(before));
  console.log('after: ', JSON.stringify(after));
  process.exit(0);
})();
