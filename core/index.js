'use strict';
// Long-running server for local development and any always-on host. Production on Vercel
// uses api/index.js instead (same app, request-scoped).
const config = require('./config');
const { createApp } = require('./app');
const { createServer } = require('./server');

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

async function main() {
  const app = await createApp(config);
  if (config.adminPassword === 'demo') console.warn('[warn] ADMIN_PASSWORD is the default "demo". Change it before exposing this publicly.');
  if (!app.llm.enabled) console.warn('[warn] No LLM key set (LLM_API_KEY). The agent will use templated replies only.');
  console.log(`[db] ${app.store.kind === 'pg' ? 'Postgres' : `SQLite ${config.dbPath}`}`);

  const server = createServer(app);
  server.listen(config.port, () => {
    console.log(`[server] admin console  ${config.publicUrl}/admin`);
    console.log(`[server] enquiry form   ${config.publicUrl}/form`);
    console.log(`[server] IG webhook     ${config.publicUrl}/webhook/instagram`);
  });

  const recovered = await app.engine.recover();
  if (recovered) console.log(`[engine] resuming ${recovered} unprocessed conversation(s)`);
  app.scheduler.start();
  await app.instagram.start();
  await app.facebook.start();
  try {
    await app.telegram.start();
    if (app.telegram.botUsername) console.log(`[telegram] chat link    https://t.me/${app.telegram.botUsername}?start=gform`);
  } catch (e) {
    console.error('[telegram] could not start:', e.message);
  }

  const shutdown = () => {
    console.log('\n[server] shutting down');
    app.telegram.stop();
    app.scheduler.stop();
    server.close();
    setTimeout(() => { Promise.resolve(app.store.close()).catch(() => {}).finally(() => process.exit(0)); }, 400);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
