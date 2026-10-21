'use strict';
// Creates or upgrades the Postgres schema.   DATABASE_URL=... npm run migrate
const config = require('../core/config');
const { Store } = require('../core/db');

(async () => {
  if (!config.databaseUrl) { console.error('Set DATABASE_URL first.'); process.exit(1); }
  const store = await Store.open({ url: config.databaseUrl });
  const r = await store.get('SELECT COUNT(*) c FROM leads');
  console.log(`schema ready, ${r.c} lead(s) in the database`);
  await store.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
