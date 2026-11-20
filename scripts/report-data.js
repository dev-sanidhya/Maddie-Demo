'use strict';
// Dumps every assistant reply with its lead's category/stage to JSON (for the client report). node scripts/report-data.js out.json
const fs = require('node:fs');
const config = require('../core/config');
const { Store } = require('../core/db');
(async () => {
  const store = await Store.open({ url: config.databaseUrl, file: config.dbPath });
  const leads = await store.all("SELECT id, name, channel, stage, meta, created_at FROM leads WHERE channel='instagram'");
  const msgs = await store.all("SELECT lead_id, direction, role, text, status, created_at FROM messages ORDER BY created_at");
  const parse = (m) => { try { return typeof m === 'string' ? JSON.parse(m || '{}') : m || {}; } catch { return {}; } };
  const L = {}; for (const l of leads) { const m = parse(l.meta); L[l.id] = { id: l.id, name: l.name, stage: l.stage, category: (m.crm_ai || {}).category || null, reason: (m.crm_ai || {}).reason || '', handle: m.username || m.handle || '', msgs: [] }; }
  for (const m of msgs) if (L[m.lead_id]) L[m.lead_id].msgs.push({ d: m.direction, r: m.role, t: m.text, s: m.status, at: Number(m.created_at) });
  fs.writeFileSync(process.argv[2], JSON.stringify(Object.values(L)));
  const all = Object.values(L);
  const bot = msgs.filter((m) => m.direction === 'out' && m.role !== 'admin');
  console.log(all.length, 'leads;', msgs.length, 'msgs;', bot.length, 'assistant msgs; roles:', [...new Set(msgs.map(m=>m.role))].join(','), 'statuses:', [...new Set(bot.map(m=>m.status))].join(','));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
