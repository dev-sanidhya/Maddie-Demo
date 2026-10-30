'use strict';
// Storage. One async interface, two drivers: Postgres (production on Vercel,
// DATABASE_URL) and SQLite (local development and tests, a file or ':memory:').
// Every method returns a promise, so no caller cares which one is underneath.

const fs = require('node:fs');
const path = require('node:path');

// ---------- schema ----------
// Written once in a neutral form; the driver swaps the few dialect differences.
const TABLES = (d) => `
CREATE TABLE IF NOT EXISTS leads (
  id ${d.pk},
  chat_id TEXT UNIQUE,
  channel TEXT NOT NULL DEFAULT 'telegram',
  tg_username TEXT,
  name TEXT, phone TEXT, email TEXT,
  source TEXT, campaign TEXT,
  project_type TEXT, city TEXT,
  budget_amount ${d.real}, budget_text TEXT,
  timeline_months ${d.real}, timeline_text TEXT,
  notes TEXT,
  stage TEXT NOT NULL DEFAULT 'new',
  stage_reason TEXT,
  stage_locked ${d.int} NOT NULL DEFAULT 0,
  score ${d.int} NOT NULL DEFAULT 0,
  designer_id ${d.big},
  ai_paused ${d.int} NOT NULL DEFAULT 0,
  opted_out ${d.int} NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  summary_upto ${d.big} NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  start_token TEXT UNIQUE,
  created_at ${d.big} NOT NULL,
  updated_at ${d.big} NOT NULL,
  last_inbound_at ${d.big},
  last_outbound_at ${d.big},
  qualified_at ${d.big},
  callback_at ${d.big}, callback_text TEXT, callback_status TEXT, callback_kind TEXT,
  property TEXT, scope TEXT, style TEXT, contact_pref TEXT,
  fu_step ${d.int} NOT NULL DEFAULT 0,
  reminded_at ${d.big},
  lock_until ${d.big}
);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_updated ON leads(updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id ${d.pk},
  lead_id ${d.big} NOT NULL,
  direction TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  tg_update_id ${d.big} UNIQUE,
  ext_id TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  processed ${d.int} NOT NULL DEFAULT 0,
  attempts ${d.int} NOT NULL DEFAULT 0,
  error TEXT,
  claimed_at ${d.big},
  created_at ${d.big} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(status, processed);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_ext ON messages(ext_id);

CREATE TABLE IF NOT EXISTS events (
  id ${d.pk},
  lead_id ${d.big},
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at ${d.big} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id, id);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Every Instagram conversation on the account (the studio's own messages included), so the assistant can read a person's whole
-- history and the team's own way of talking before it writes anything. msgs is a JSON array: [{mid, at, fromUs, text}], oldest first.
CREATE TABLE IF NOT EXISTS ig_archive (
  conv_id TEXT PRIMARY KEY,
  chat_key TEXT,
  igsid TEXT,
  username TEXT,
  last_at ${d.big},
  n ${d.int} NOT NULL DEFAULT 0,
  team_n ${d.int} NOT NULL DEFAULT 0,
  msgs TEXT NOT NULL DEFAULT '[]',
  synced_at ${d.big} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archive_igsid ON ig_archive(igsid);

CREATE TABLE IF NOT EXISTS designers (
  id ${d.pk},
  name TEXT NOT NULL,
  title TEXT,
  phone TEXT,
  telegram_chat_id TEXT,
  specialties TEXT NOT NULL DEFAULT '',
  cities TEXT NOT NULL DEFAULT '',
  min_budget ${d.real} NOT NULL DEFAULT 0,
  bio TEXT,
  active ${d.int} NOT NULL DEFAULT 1,
  created_at ${d.big} NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id ${d.pk},
  lead_id ${d.big} NOT NULL,
  message_id ${d.big},
  mime TEXT NOT NULL,
  data ${d.blob},
  storage_path TEXT,
  removed_at ${d.big},
  size ${d.big},
  created_at ${d.big} NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_lead ON media(lead_id);
CREATE INDEX IF NOT EXISTS idx_media_message ON media(message_id);

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id ${d.pk},
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts ${d.int} NOT NULL DEFAULT 0,
  next_at ${d.big} NOT NULL,
  last_error TEXT,
  created_at ${d.big} NOT NULL
);
`;

const SQLITE_DIALECT = { pk: 'INTEGER PRIMARY KEY AUTOINCREMENT', int: 'INTEGER', big: 'INTEGER', real: 'REAL', blob: 'BLOB' };
const PG_DIALECT = { pk: 'BIGSERIAL PRIMARY KEY', int: 'INTEGER', big: 'BIGINT', real: 'DOUBLE PRECISION', blob: 'BYTEA' };

const LEAD_COLUMNS = new Set([
  'chat_id', 'channel', 'tg_username', 'name', 'phone', 'email', 'source', 'campaign',
  'project_type', 'city', 'budget_amount', 'budget_text', 'timeline_months', 'timeline_text',
  'notes', 'stage', 'stage_reason', 'stage_locked', 'score', 'designer_id', 'ai_paused',
  'opted_out', 'summary', 'summary_upto', 'meta', 'start_token', 'last_inbound_at',
  'last_outbound_at', 'qualified_at',
  'callback_at', 'callback_text', 'callback_status', 'callback_kind', 'property', 'scope', 'style', 'contact_pref',
  'fu_step', 'reminded_at', 'lock_until',
]);

const now = () => Date.now();
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function normalizePhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length < 7) return '';
  return d.slice(-10); // compare on the last 10 digits so +91 / 0 prefixes match
}

// ---------- drivers ----------
// A driver exposes: run(sql,...p) -> {changes}, insert(sql,...p) -> id, get, all, exec,
// and withTx(fn) which hands fn a driver bound to one transaction.
class SqliteDriver {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.kind = 'sqlite';
    this.like = 'LIKE';
    this.gate = Promise.resolve();
  }
  async exec(sql) { this.db.exec(sql); }
  async run(sql, ...p) { const r = this.db.prepare(sql).run(...p); return { changes: Number(r.changes) }; }
  async insert(sql, ...p) { const r = this.db.prepare(sql).run(...p); return Number(r.lastInsertRowid); }
  async get(sql, ...p) { return this.db.prepare(sql).get(...p); }
  async all(sql, ...p) { return this.db.prepare(sql).all(...p); }
  async withTx(fn) {
    // One transaction at a time on the single connection.
    const prev = this.gate;
    let release;
    this.gate = new Promise((r) => { release = r; });
    await prev;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(this);
        this.db.exec('COMMIT');
        return out;
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    } finally { release(); }
  }
  async tableColumns(table) { return this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }
  async close() { this.db.close(); }
}

class PgDriver {
  constructor(urlOrPool, { pool } = {}) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, (v) => Number(v)); // bigint columns hold epoch milliseconds and counts: always numbers
    this.kind = 'pg';
    this.like = 'ILIKE';
    if (pool) { this.pool = pool; return; }
    this.pool = new Pool({
      connectionString: urlOrPool,
      max: Number(process.env.PG_POOL_MAX || 4),
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 8000,
      ssl: /localhost|127\.0\.0\.1/.test(urlOrPool) ? false : { rejectUnauthorized: false },
    });
    this.pool.on('error', () => { /* an idle connection dropped; the next query opens a new one */ });
  }
  static text(sql) { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }
  async exec(sql) { await this.pool.query(sql); }
  async run(sql, ...p) { const r = await this.pool.query(PgDriver.text(sql), p); return { changes: r.rowCount }; }
  async insert(sql, ...p) { const r = await this.pool.query(`${PgDriver.text(sql)} RETURNING id`, p); return Number(r.rows[0].id); }
  async get(sql, ...p) { const r = await this.pool.query(PgDriver.text(sql), p); return r.rows[0]; }
  async all(sql, ...p) { const r = await this.pool.query(PgDriver.text(sql), p); return r.rows; }
  async withTx(fn) {
    const client = await this.pool.connect();
    const bound = new PgTxDriver(client);
    try {
      await client.query('BEGIN');
      const out = await fn(bound);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
      throw e;
    } finally { client.release(); }
  }
  async tableColumns(table) {
    const r = await this.pool.query('SELECT column_name FROM information_schema.columns WHERE table_name=$1', [table]);
    return r.rows.map((c) => c.column_name);
  }
  async close() { await this.pool.end(); }
}

class PgTxDriver extends PgDriver {
  constructor(client) { super(null, { pool: client }); this.kind = 'pg'; this.like = 'ILIKE'; }
  async withTx(fn) { return fn(this); } // already inside a transaction
}

// ---------- store ----------
class Store {
  constructor(driver) { this.d = driver; }

  // Store.open({ url }) for Postgres, Store.open({ file }) for SQLite. Pass migrate:false in production.
  static async open({ url, file, migrate = true } = {}) {
    const store = new Store(url ? new PgDriver(url) : new SqliteDriver(file || ':memory:'));
    if (migrate) await store.migrate();
    return store;
  }

  get kind() { return this.d.kind; }

  async migrate() {
    const dialect = this.d.kind === 'pg' ? PG_DIALECT : SQLITE_DIALECT;
    const statements = TABLES(dialect).split(';').map((s) => s.trim()).filter(Boolean);
    for (const s of statements) await this.d.exec(s);
    // Additive upgrades for databases created by earlier versions.
    const cols = await this.d.tableColumns('leads');
    const add = {
      callback_at: dialect.big, callback_text: 'TEXT', callback_status: 'TEXT', callback_kind: 'TEXT', property: 'TEXT', scope: 'TEXT', style: 'TEXT', contact_pref: 'TEXT',
      fu_step: `${dialect.int} NOT NULL DEFAULT 0`, reminded_at: dialect.big, lock_until: dialect.big,
    };
    for (const [c, type] of Object.entries(add)) if (!cols.includes(c)) await this.d.exec(`ALTER TABLE leads ADD COLUMN ${c} ${type}`);
    // The chat archive is addressed by a hash key per chat (see core/chatkey.js): add it to older databases and fill it in.
    const acols = await this.d.tableColumns('ig_archive');
    if (!acols.includes('chat_key')) await this.d.exec('ALTER TABLE ig_archive ADD COLUMN chat_key TEXT');
    await this.d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_key ON ig_archive(chat_key)');
    const keyless = await this.all('SELECT conv_id, igsid FROM ig_archive WHERE chat_key IS NULL AND igsid IS NOT NULL LIMIT 5000');
    if (keyless.length && process.env.INSTAGRAM_ACCOUNT_ID) {
      const { chatKey } = require('./chatkey');
      for (const r of keyless) await this.run('UPDATE ig_archive SET chat_key=? WHERE conv_id=?', chatKey(process.env.INSTAGRAM_ACCOUNT_ID, r.igsid), r.conv_id).catch(() => {});
    }
    const mcols = await this.d.tableColumns('messages');
    if (!mcols.includes('ext_id')) await this.d.exec('ALTER TABLE messages ADD COLUMN ext_id TEXT');
    if (!mcols.includes('claimed_at')) await this.d.exec(`ALTER TABLE messages ADD COLUMN claimed_at ${dialect.big}`);
    await this.d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_ext ON messages(ext_id)');
    // Photos moved from the database to Supabase Storage: a row now holds either the bytes or the storage path.
    const media = await this.d.tableColumns('media');
    if (!media.includes('storage_path')) await this.d.exec('ALTER TABLE media ADD COLUMN storage_path TEXT');
    if (!media.includes('removed_at')) await this.d.exec(`ALTER TABLE media ADD COLUMN removed_at ${dialect.big}`);
    if (!media.includes('size')) {
      await this.d.exec(`ALTER TABLE media ADD COLUMN size ${dialect.big}`);
      await this.d.exec(`UPDATE media SET size=${this.d.kind === 'pg' ? 'octet_length(data)' : 'length(data)'} WHERE data IS NOT NULL AND size IS NULL`);
    }
    if (this.d.kind === 'pg') await this.d.exec('ALTER TABLE media ALTER COLUMN data DROP NOT NULL');
  }

  // Runs fn(txStore) inside one transaction. Use the store handed to fn, not this one.
  tx(fn) { return this.d.withTx((driver) => fn(new Store(driver))); }

  run(sql, ...p) { return this.d.run(sql, ...p); }
  get(sql, ...p) { return this.d.get(sql, ...p); }
  all(sql, ...p) { return this.d.all(sql, ...p); }
  isDuplicate(e) { return /UNIQUE|duplicate key/i.test(String(e && e.message)) || (e && e.code === '23505'); }

  // ---- archive of every Instagram conversation ----
  async archiveUpsert(c) {
    const msgs = c.msgs || [];
    await this.run(
      'INSERT INTO ig_archive(conv_id,chat_key,igsid,username,last_at,n,team_n,msgs,synced_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(conv_id) DO UPDATE SET chat_key=excluded.chat_key, igsid=excluded.igsid, username=excluded.username, last_at=excluded.last_at, n=excluded.n, team_n=excluded.team_n, msgs=excluded.msgs, synced_at=excluded.synced_at',
      c.conv_id, c.chat_key || null, c.igsid || null, c.username || null, c.last_at || 0, msgs.length, msgs.filter((m) => m.fromUs).length, JSON.stringify(msgs), Date.now(),
    );
  }
  async archiveMeta() { return this.all('SELECT conv_id, last_at FROM ig_archive'); }
  // One chat, by its key: a primary-key lookup. This is the only way the assistant reads the archive.
  async archiveGet(chatKey) {
    const r = await this.get('SELECT * FROM ig_archive WHERE chat_key=?', chatKey);
    return r ? { ...r, msgs: JSON.parse(r.msgs) } : null;
  }
  // Adds messages to a chat that is already in the archive (new customer messages, the assistant's replies, the team's replies).
  async archiveAppend(chatKey, add) {
    const r = await this.get('SELECT msgs FROM ig_archive WHERE chat_key=?', chatKey);
    if (!r || !add || !add.length) return false;
    const have = JSON.parse(r.msgs);
    const seen = new Set(have.map((m) => m.mid).filter(Boolean));
    const merged = have.concat(add.filter((m) => m && m.text && (!m.mid || !seen.has(m.mid)))).sort((a, b) => a.at - b.at);
    await this.run('UPDATE ig_archive SET msgs=?, n=?, team_n=?, last_at=?, synced_at=? WHERE chat_key=?', JSON.stringify(merged), merged.length, merged.filter((m) => m.fromUs).length, merged.length ? merged[merged.length - 1].at : 0, Date.now(), chatKey);
    return true;
  }
  async archiveByIgsid(igsid) {
    const r = await this.get('SELECT * FROM ig_archive WHERE igsid=?', String(igsid));
    return r ? { ...r, msgs: JSON.parse(r.msgs) } : null;
  }
  async archiveAll({ minTeam = 0, limit = 5000 } = {}) {
    return (await this.all('SELECT conv_id, igsid, username, last_at, n, team_n, msgs FROM ig_archive WHERE team_n>=? ORDER BY last_at DESC LIMIT ?', minTeam, limit)).map((r) => ({ ...r, msgs: JSON.parse(r.msgs) }));
  }

  // ---- kv / settings ----
  async kvGet(key, fallback = null) {
    const r = await this.get('SELECT value FROM kv WHERE key=?', key);
    return r ? JSON.parse(r.value) : fallback;
  }
  async kvSet(key, value) {
    await this.run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  }
  async settingsRaw() {
    const out = {};
    for (const r of await this.all('SELECT key,value FROM settings')) out[r.key] = JSON.parse(r.value);
    return out;
  }
  async settingsSetRaw(key, value) {
    await this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  }

  // ---- leads ----
  hydrate(row) {
    if (!row) return null;
    let meta = {};
    try { meta = JSON.parse(row.meta || '{}'); } catch { /* corrupt meta resets */ }
    return { ...row, meta };
  }
  async createLead(fields = {}) {
    const t = now();
    const data = { channel: 'telegram', stage: 'new', ...fields };
    const meta = JSON.stringify(data.meta || {});
    const cols = Object.keys(data).filter((k) => LEAD_COLUMNS.has(k) && k !== 'meta');
    const all = [...cols, 'meta', 'created_at', 'updated_at'];
    const sql = `INSERT INTO leads(${all.join(',')}) VALUES(${all.map(() => '?').join(',')})`;
    const id = await this.d.insert(sql, ...cols.map((c) => data[c] ?? null), meta, t, t);
    return this.getLead(id);
  }
  async getLead(id) { return this.hydrate(await this.get('SELECT * FROM leads WHERE id=?', id)); }
  async getLeadByChat(chatId) { return this.hydrate(await this.get('SELECT * FROM leads WHERE chat_id=?', String(chatId))); }
  async getLeadByToken(token) { return this.hydrate(await this.get('SELECT * FROM leads WHERE start_token=?', token)); }
  async updateLead(id, patch) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!LEAD_COLUMNS.has(k)) continue;
      sets.push(`${k}=?`);
      vals.push(k === 'meta' ? JSON.stringify(v) : v === undefined ? null : v);
    }
    if (!sets.length) return this.getLead(id);
    sets.push('updated_at=?');
    vals.push(now(), id);
    await this.run(`UPDATE leads SET ${sets.join(',')} WHERE id=?`, ...vals);
    return this.getLead(id);
  }
  async deleteLead(id) {
    await this.tx(async (t) => {
      await t.run('DELETE FROM messages WHERE lead_id=?', id);
      await t.run('DELETE FROM events WHERE lead_id=?', id);
      await t.run('DELETE FROM media WHERE lead_id=?', id);
      await t.run('DELETE FROM leads WHERE id=?', id);
    });
  }
  async listLeads({ stage, q, channel, limit = 500 } = {}) {
    const where = [];
    const p = [];
    if (stage) { where.push('stage=?'); p.push(stage); }
    if (channel === 'real') where.push("channel!='sim'");
    else if (channel) { where.push('channel=?'); p.push(channel); }
    if (q) {
      const L = this.d.like;
      where.push(`(name ${L} ? OR phone ${L} ? OR email ${L} ? OR city ${L} ? OR tg_username ${L} ?)`);
      const like = `%${q}%`;
      p.push(like, like, like, like, like);
    }
    const sql = `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`;
    return (await this.all(sql, ...p, limit)).map((r) => this.hydrate(r));
  }
  async findLeadByPhone(phone, { unboundOnly = false } = {}) {
    const digits = normalizePhone(phone);
    if (!digits) return null;
    const rows = await this.all(`SELECT * FROM leads WHERE phone IS NOT NULL ${unboundOnly ? 'AND chat_id IS NULL' : ''} ORDER BY id DESC`);
    return this.hydrate(rows.find((r) => normalizePhone(r.phone) === digits));
  }

  // Atomic per-lead lease, so two serverless instances never run a turn for the same lead at once.
  // Returns a release function, or null when someone else holds it.
  async lease(leadId, ttlMs = 90000) {
    const t = now();
    const r = await this.run('UPDATE leads SET lock_until=? WHERE id=? AND (lock_until IS NULL OR lock_until<?)', t + ttlMs, leadId, t);
    if (!r.changes) return null;
    const until = t + ttlMs;
    return async () => { await this.run('UPDATE leads SET lock_until=NULL WHERE id=? AND lock_until=?', leadId, until).catch(() => {}); };
  }

  // ---- messages ----
  async addMessage(m) {
    return this.d.insert(
      'INSERT INTO messages(lead_id,direction,role,text,tg_update_id,ext_id,status,processed,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      m.lead_id, m.direction, m.role, m.text, m.tg_update_id ?? null, m.ext_id ?? null,
      m.status || (m.direction === 'in' ? 'received' : 'pending'), m.processed ? 1 : 0, m.created_at ?? now(),
    );
  }
  getMessages(leadId, { limit = 300, afterId = 0 } = {}) {
    return this.all('SELECT * FROM messages WHERE lead_id=? AND id>? ORDER BY id ASC LIMIT ?', leadId, afterId, limit);
  }
  async recentMessages(leadId, n) {
    return (await this.all('SELECT * FROM messages WHERE lead_id=? ORDER BY id DESC LIMIT ?', leadId, n)).reverse();
  }
  // What the model must remember, with no gap between the rolling summary and the live window:
  // every message the summary does not yet cover (so nothing falls between them), and never fewer
  // than `min` recent ones, capped at `max` so the prompt stays small however long the chat gets.
  async contextMessages(leadId, { beforeId = null, summaryUpto = 0, min = 14, max = 40 } = {}) {
    const rows = (await this.all(`SELECT * FROM messages WHERE lead_id=? ${beforeId ? 'AND id<?' : ''} ORDER BY id DESC LIMIT ?`, leadId, ...(beforeId ? [beforeId] : []), max)).reverse();
    let firstUncovered = rows.findIndex((m) => m.id > summaryUpto);
    if (firstUncovered === -1) firstUncovered = rows.length;
    return rows.slice(Math.min(firstUncovered, Math.max(0, rows.length - min)));
  }
  async countMessages(leadId) { return Number((await this.get('SELECT COUNT(*) c FROM messages WHERE lead_id=?', leadId)).c); }

  // ---- pictures the customer sent (kept here because Instagram's links expire) ----
  async addMedia({ lead_id, message_id, mime, bytes = null, path = null, size = null }) {
    return this.d.insert('INSERT INTO media(lead_id,message_id,mime,data,storage_path,size,created_at) VALUES(?,?,?,?,?,?,?)', lead_id, message_id ?? null, mime, bytes ? Buffer.from(bytes) : null, path, size ?? (bytes ? bytes.length : null), now());
  }
  async getMedia(id) {
    const r = await this.get('SELECT id, lead_id, message_id, mime, data, storage_path, removed_at FROM media WHERE id=?', id);
    return r ? { ...r, data: r.data ? Buffer.from(r.data) : null } : null;
  }
  // message id -> media id, for photos that are still there
  async mediaIndex(leadIds) {
    const out = new Map();
    if (!leadIds.length) return out;
    for (const r of await this.all(`SELECT id, message_id FROM media WHERE message_id IS NOT NULL AND removed_at IS NULL AND lead_id IN (${leadIds.map(() => '?').join(',')})`, ...leadIds)) out.set(Number(r.message_id), Number(r.id));
    return out;
  }
  // message id -> { id, removed }, so the inbox can show a "photo removed" note where one used to be
  async mediaState(leadIds) {
    const out = new Map();
    if (!leadIds.length) return out;
    for (const r of await this.all(`SELECT id, message_id, removed_at FROM media WHERE message_id IS NOT NULL AND lead_id IN (${leadIds.map(() => '?').join(',')})`, ...leadIds)) out.set(Number(r.message_id), { id: Number(r.id), removed: r.removed_at != null });
    return out;
  }
  // How much room this deployment's data takes: photos still kept, and the database tables themselves.
  async footprint() {
    const p = await this.get('SELECT COUNT(*) c, COALESCE(SUM(size),0) b FROM media WHERE removed_at IS NULL');
    let db = 0;
    if (this.d.kind === 'pg') {
      const r = await this.get("SELECT COALESCE(SUM(pg_total_relation_size(c.oid)),0) b FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r'");
      db = Number(r.b);
    } else {
      const [pc, ps] = [await this.get('PRAGMA page_count'), await this.get('PRAGMA page_size')];
      db = Number(pc.page_count) * Number(ps.page_size);
    }
    return { photos: Number(p.c), photo_bytes: Number(p.b), db_bytes: db };
  }
  // photos (still stored) of the given leads
  async mediaOfLeads(leadIds) {
    if (!leadIds.length) return [];
    return this.all(`SELECT id, lead_id, storage_path, COALESCE(size,0) size FROM media WHERE removed_at IS NULL AND lead_id IN (${leadIds.map(() => '?').join(',')})`, ...leadIds);
  }
  // photos older than the retention period that are still stored
  expiredMedia(beforeMs, limit = 100) {
    return this.all('SELECT id, storage_path FROM media WHERE removed_at IS NULL AND created_at<? ORDER BY id LIMIT ?', beforeMs, limit);
  }
  markMediaRemoved(ids) {
    if (!ids.length) return Promise.resolve();
    return this.run(`UPDATE media SET data=NULL, storage_path=NULL, removed_at=? WHERE id IN (${ids.map(() => '?').join(',')})`, now(), ...ids);
  }

  // ---- events ----
  async addEvent(leadId, type, data = {}) {
    await this.run('INSERT INTO events(lead_id,type,data,created_at) VALUES(?,?,?,?)', leadId, type, JSON.stringify(data), now());
  }
  async getEvents(leadId, limit = 100) {
    return (await this.all('SELECT * FROM events WHERE lead_id=? ORDER BY id DESC LIMIT ?', leadId, limit))
      .map((e) => ({ ...e, data: safeJson(e.data) }));
  }

  // ---- designers ----
  listDesigners() { return this.all('SELECT * FROM designers ORDER BY active DESC, id ASC'); }
  async getDesigner(id) { return (await this.get('SELECT * FROM designers WHERE id=?', id)) || null; }
  async saveDesigner(d) {
    const f = [d.name, d.title || '', d.phone || '', d.telegram_chat_id || '', d.specialties || '', d.cities || '',
      Number(d.min_budget) || 0, d.bio || '', d.active === false || d.active === 0 ? 0 : 1];
    if (d.id) {
      await this.run('UPDATE designers SET name=?,title=?,phone=?,telegram_chat_id=?,specialties=?,cities=?,min_budget=?,bio=?,active=? WHERE id=?', ...f, d.id);
      return this.getDesigner(d.id);
    }
    const id = await this.d.insert('INSERT INTO designers(name,title,phone,telegram_chat_id,specialties,cities,min_budget,bio,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', ...f, now());
    return this.getDesigner(id);
  }
  deleteDesigner(id) { return this.run('DELETE FROM designers WHERE id=?', id); }

  // ---- webhook outbox ----
  enqueueWebhook(event, payload) {
    return this.run('INSERT INTO webhook_outbox(event,payload,next_at,created_at) VALUES(?,?,?,?)', event, JSON.stringify(payload), now(), now());
  }

  close() { return this.d.close(); }
}

module.exports = { Store, normalizePhone, safeJson, now, TABLES, SQLITE_DIALECT, PG_DIALECT };
