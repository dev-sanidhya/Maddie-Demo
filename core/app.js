'use strict';
// Composition root: builds every service and wires them together. Used by the
// server entrypoint, the CLI simulator and the tests.

const { Store } = require('./db');
const { Settings } = require('./settings');
const { Llm } = require('./llm');
const { Agent } = require('./agent');
const { Engine } = require('./engine');
const { Telegram } = require('./telegram');
const { Instagram } = require('./instagram');
const { Facebook } = require('./facebook');
const { Scheduler } = require('./scheduler');
const { Calendar, GoogleCalendar } = require('./calendar');
const { PhotoStore } = require('./storage');
const { Simulator } = require('./simulator');

const SEED_DESIGNERS = [
  { name: 'Priya Sharma', title: 'Senior Residential Designer', specialties: 'Full home, Modular kitchen', cities: 'Pune', bio: '12 years of turnkey home interiors.' },
  { name: 'Arjun Nair', title: 'Principal Designer, Commercial', specialties: 'Office', cities: 'Pune, Mumbai', bio: 'Offices, clinics and retail fit-outs.' },
  { name: 'Meera Iyer', title: 'Renovation Specialist', specialties: 'Renovation, Other', cities: '', bio: 'Renovations and design-only consultations.' },
];

// Builds the whole object graph. Storage is chosen by config: DATABASE_URL (Postgres) in production,
// a SQLite file locally, or a store passed in by tests. migrate:false skips the schema step on serverless cold starts.
async function createApp(config, { store, llmOverride, fetchImpl, debounceMs, log = console, seed = true, migrate = true } = {}) {
  store = store || await Store.open({ url: config.databaseUrl, file: config.dbPath, migrate });
  const settings = new Settings(store);
  await settings.refresh();
  const llm = new Llm(config.llm, { fetchImpl });
  if (llmOverride) llm.override = llmOverride;
  const agent = new Agent({ llm });
  const engine = new Engine({
    store, settings, agent, config, log,
    debounceMs: debounceMs === undefined ? (Number(process.env.DEBOUNCE_MS) || 6000) : debounceMs, // quiet time before replying, so a burst of messages gets one answer
    transports: { sim: { send: async () => ({}) } },
  });
  const calendar = new Calendar({ google: new GoogleCalendar({ account: config.googleServiceAccount, fetchImpl, log }), settings, log });
  engine.calendar = calendar;
  engine.photos = new PhotoStore(config.storage, { fetchImpl, log });
  const telegram = new Telegram({ token: config.telegramToken, engine, store, settings, config, log, fetchImpl });
  engine.transports.telegram = telegram.transport;
  const instagram = new Instagram({ cfg: config.instagram, engine, store, config, log, fetchImpl });
  engine.transports.instagram = instagram.transport;
  const facebook = new Facebook({ cfg: config.facebook, engine, store, config, log, fetchImpl });
  engine.transports.facebook = facebook.transport;
  const scheduler = new Scheduler({ engine, store, settings, instagram, log });
  const simulator = new Simulator({ engine, store, settings, llm, log });
  if (seed && !(await store.listDesigners()).length) for (const d of SEED_DESIGNERS) await store.saveDesigner(d);
  return { config, store, settings, llm, agent, engine, telegram, instagram, facebook, scheduler, simulator, calendar };
}

module.exports = { createApp };
