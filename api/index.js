'use strict';
// Vercel entry point: every request (pages, API, Instagram webhook, cron) comes through here.
// The app is built once per warm instance and kept; anything it still has to do after the
// response is sent (replying to a DM, for example) is handed to waitUntil so Vercel keeps
// the function alive until it finishes.
const { waitUntil } = require('@vercel/functions');
const config = require('../core/config');
const { createApp } = require('../core/app');
const { createHandler } = require('../core/server');

let booting = null;
function boot() {
  if (!booting) {
    booting = (async () => {
      // The schema is applied by `npm run migrate`, not on every cold start.
      const app = await createApp(config, { migrate: false, seed: false });
      app.engine.defer = (p) => { try { waitUntil(p); } catch { /* not on Vercel (local test): the promise just runs */ } };
      app.instagram.status.connected = app.instagram.enabled;
      return { app, handler: createHandler(app) };
    })().catch((e) => { booting = null; throw e; });
  }
  return booting;
}

module.exports = async (req, res) => {
  try {
    const { handler } = await boot();
    await handler(req, res);
  } catch (e) {
    console.error('[boot]', e);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); }
    res.end(JSON.stringify({ error: 'Service unavailable', detail: String(e.message).slice(0, 200) }));
  }
};
