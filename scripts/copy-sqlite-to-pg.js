'use strict';
// One-off: copies settings, kv (Instagram token), designers, and optionally the leads, from the local
// SQLite file into Postgres.   DATABASE_URL=... node scripts/copy-sqlite-to-pg.js [--with-leads]
const { DatabaseSync } = require('node:sqlite');
const config = require('../core/config');
const { Store } = require('../core/db');

(async () => {
  if (!config.databaseUrl) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const src = new DatabaseSync(config.dbPath, { readOnly: true });
  const dst = await Store.open({ url: config.databaseUrl });
  const withLeads = process.argv.includes('--with-leads');
  const tables = ['settings', 'kv', 'designers', ...(withLeads ? ['leads', 'messages', 'events'] : [])];
  for (const t of tables) {
    const rows = src.prepare(`SELECT * FROM ${t}`).all();
    await dst.run(`DELETE FROM ${t}`);
    for (const r of rows) {
      const cols = Object.keys(r);
      await dst.run(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map((c) => r[c]));
    }
    if (rows.length && rows[0].id !== undefined) await dst.run(`SELECT setval(pg_get_serial_sequence('${t}','id'), (SELECT MAX(id) FROM ${t}))`);
    console.log(`${t}: ${rows.length} row(s)`);
  }
  await dst.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
