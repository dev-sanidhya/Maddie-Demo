'use strict';
// Where customers' photos live: Supabase Storage (its own 1 GB, separate from the 500 MB database).
//
// Why the public key is enough: each client has its own bucket, and the only rule granted to the public
// key is "add an image" under a name of the form <lead id>/<128 random bits>.<ext>. It cannot list, read
// through the API, overwrite or delete anything (verified against the live project). A stored photo can be
// opened only by someone who knows its random address, and that address never leaves the server: the Lead
// Inbox asks this app for /api/media/<id>, the app checks the staff login and fetches the file itself.
//
// If storage is not configured, or an upload fails, the photo is kept in the database instead, so
// a photo is never lost because storage was unavailable.

const crypto = require('node:crypto');

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const PATH_OK = /^\d+\/[0-9a-f]{32}\.(jpg|png|webp|gif)$/;

class PhotoStore {
  constructor({ url, key, bucket, purgeSecret } = {}, { fetchImpl, log = console } = {}) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.key = key || '';
    this.bucket = bucket || '';
    this.purgeSecret = purgeSecret || '';
    this.fetch = fetchImpl || globalThis.fetch;
    this.log = log;
  }

  get enabled() { return !!(this.url && this.key && this.bucket); }
  get canDelete() { return this.enabled && !!this.purgeSecret; }

  // Deletes stored photos. The public key cannot delete, so this asks the project's own `purge-photos`
  // function (which holds the service key privately and only deletes well-formed photo names in our buckets).
  async remove(paths) {
    const list = (paths || []).filter((p) => PATH_OK.test(String(p)));
    if (!list.length) return 0;
    if (!this.canDelete) throw new Error('Photo deletion is not set up on this deployment');
    const res = await this.fetch(`${this.url}/functions/v1/purge-photos`, {
      method: 'POST',
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', 'x-purge-secret': this.purgeSecret },
      body: JSON.stringify({ bucket: this.bucket, paths: list.slice(0, 200) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Photo deletion failed (${res.status}): ${data.error || 'unknown error'}`);
    return Number(data.removed) || 0;
  }

  // Returns the stored path, or null when the photo should go to the database instead.
  async put(leadId, mime, bytes) {
    const ext = EXT[String(mime || '').toLowerCase()];
    if (!this.enabled || !ext) return null;
    const path = `${Number(leadId)}/${crypto.randomBytes(16).toString('hex')}.${ext}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await this.fetch(`${this.url}/storage/v1/object/${this.bucket}/${path}`, {
        method: 'POST',
        headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': MIME[ext], 'x-upsert': 'false' },
        body: bytes,
        signal: ctrl.signal,
      });
      if (!res.ok) { this.log.warn(`[storage] upload refused (${res.status}), keeping the photo in the database`); return null; }
      return path;
    } catch (e) {
      this.log.warn(`[storage] upload failed (${e.message}), keeping the photo in the database`);
      return null;
    } finally { clearTimeout(timer); }
  }

  // Fetches a stored photo by the path kept in the database.
  async get(path) {
    if (!this.enabled || !PATH_OK.test(String(path))) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await this.fetch(`${this.url}/storage/v1/object/public/${this.bucket}/${path}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const mime = MIME[path.split('.').pop()];
      return { mime, bytes: Buffer.from(await res.arrayBuffer()) };
    } catch { return null; } finally { clearTimeout(timer); }
  }
}

module.exports = { PhotoStore, PATH_OK, EXT };
