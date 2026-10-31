'use strict';
// Instagram Messaging via "Instagram API with Instagram Login".
//
// Rules this module respects (Meta platform constraints):
//  - the customer must message first; after that we may reply freely for 24 hours
//  - after 24h only a human can reply, using the HUMAN_AGENT tag, for up to 7 days
//  - text messages are limited to 1000 characters
//  - webhooks are signed with the app secret (X-Hub-Signature-256)
//
// Lead identity: the enquiry form sends people to https://ig.me/m/<handle>?ref=<token>.
// Instagram echoes that ref back in a referral webhook, which ties the DM
// conversation to the lead created at form submit.

const crypto = require('node:crypto');
const { chatKey } = require('./chatkey');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fingerprint = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
const WINDOW_MS = 24 * 3600 * 1000;
const HUMAN_AGENT_MS = 7 * 24 * 3600 * 1000;
const MAX_TEXT = 950;
const IMAGE_HOSTS = /(^|\.)(fbsbx\.com|cdninstagram\.com|fbcdn\.net|instagram\.com)$/i;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // Vercel returns at most about 4.5 MB per response, so anything bigger could never be shown
// Attachments a customer really sent (as opposed to empty companion events, hearts and the like).
const MEDIA = { image: 'a photo', video: 'a video', audio: 'a voice note', file: 'a file', share: 'a post', ig_reel: 'a reel', reel: 'a reel', story_mention: 'a story', ig_story: 'a story' }; // under the 1000 character limit, with headroom for multibyte text

class InstagramError extends Error {
  constructor(msg, { permanent = false, status = 0, code = 0 } = {}) { super(msg); this.permanent = permanent; this.status = status; this.code = code; }
}

function chunk(text, size = MAX_TEXT) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = Math.max(rest.lastIndexOf('. ', size), rest.lastIndexOf('\n', size), rest.lastIndexOf(' ', size));
    if (cut < size * 0.4) cut = size;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

class Instagram {
  constructor({ cfg, engine, store, config, log = console, fetchImpl }) {
    this.cfg = cfg;
    this.channel = 'instagram'; // Facebook Messenger reuses this class with channel 'facebook'
    this.prefix = 'ig:';
    this.engine = engine;
    this.store = store;
    this.config = config;
    this.log = log;
    this.fetch = fetchImpl || globalThis.fetch;
    this.me = null;
    this.status = { enabled: !!cfg.accessToken, connected: false, lastWebhookAt: null, lastError: null, webhookSigned: !!cfg.appSecret };
  }

  get enabled() { return !!(this.cfg.accessToken || this.storedToken); }
  // A refreshed token (stored by refreshToken, shared through the database) wins over the one in the environment.
  get token() { return this.storedToken || this.cfg.accessToken; }
  async loadToken({ maxAgeMs = 60000 } = {}) {
    if (this.tokenLoadedAt && Date.now() - this.tokenLoadedAt < maxAgeMs) return this.token;
    const stored = await this.store.kvGet('ig_token', null);
    const info = await this.store.kvGet('ig_token_info', {});
    // A token pasted into the environment after the stored one was refreshed must win (the stored one is
    // stale, and may be dead). Rows written before this check carry no fingerprint and stay trusted.
    const replaced = info && info.from && this.cfg.accessToken && info.from !== fingerprint(this.cfg.accessToken);
    this.storedToken = replaced ? null : stored;
    this.tokenLoadedAt = Date.now();
    return this.token;
  }
  get handle() { return (this.me && this.me.username) || this.cfg.handle || null; }
  get base() { return `https://graph.instagram.com/${this.cfg.apiVersion}`; }
  chatLink(ref) { return this.handle ? `https://ig.me/m/${this.handle}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}` : null; }

  // ---------- Graph API ----------
  // once: for calls that must never run twice (sending a message). A rate limit may be retried (nothing was delivered), but a timeout or a
  // server error is ambiguous: Instagram may have delivered the message anyway, so the caller gets error.ambiguous and decides.
  async api(method, path, { body, query } = {}, { retries = 3, once = false } = {}) {
    await this.loadToken();
    if (!this.token) throw new InstagramError('Instagram is not configured', { permanent: true });
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const res = await this.fetch(`${path.startsWith('http') ? path : this.base + path}${qs}`, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && !data.error) return data;
        const e = data.error || {};
        const msg = e.message || `HTTP ${res.status}`;
        const code = e.code || 0;
        // 190 = token invalid/expired, 10/200 = permission, 100 = bad request, 551/2534014 = user unreachable, 613/4/17/32 = rate limits
        const rateLimited = [4, 17, 32, 613].includes(code) || res.status === 429;
        if (rateLimited) { lastErr = new InstagramError(msg, { status: res.status, code }); await sleep(1500 * 2 ** attempt); continue; }
        if (res.status >= 500) {
          lastErr = new InstagramError(msg, { status: res.status, code });
          if (once) { lastErr.ambiguous = true; throw lastErr; }
          await sleep(500 * 2 ** attempt); continue;
        }
        // A dead token is noticed on the first failed call, so the inbox can ask the studio to reconnect.
        if (code === 190) { this.status.connected = false; this.status.lastError = msg; this.probed = { at: Date.now(), value: { connected: false, reason: 'expired', error: msg } }; }
        throw new InstagramError(msg, { permanent: true, status: res.status, code });
      } catch (e) {
        if (e instanceof InstagramError && (e.permanent || e.ambiguous)) throw e;
        lastErr = e instanceof InstagramError ? e : new InstagramError(e.name === 'AbortError' ? 'Instagram request timed out' : e.message);
        if (once) { lastErr.ambiguous = true; throw lastErr; }
        await sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new InstagramError('Instagram request failed');
  }

  async start() {
    if (!this.enabled) { this.log.warn('[instagram] no INSTAGRAM_ACCESS_TOKEN, Instagram channel disabled'); return; }
    try {
      this.me = await this.api('GET', '/me', { query: { fields: 'user_id,username,name' } }, { retries: 2 });
      this.status.connected = true;
      this.status.lastError = null;
      this.log.log(`[instagram] connected as @${this.me.username}`);
      this.refreshToken().catch(() => {});
      this.refreshTimer = setInterval(() => this.refreshToken().catch(() => {}), 24 * 3600 * 1000);
      this.refreshTimer.unref?.();
    } catch (e) {
      this.status.connected = false;
      this.status.lastError = e.message;
      this.log.error('[instagram] could not connect:', e.message);
    }
  }

  // Long-lived tokens last 60 days and can be refreshed once they are 24h old.
  async refreshToken({ force = false } = {}) {
    await this.loadToken({ maxAgeMs: 0 });
    const info = await this.store.kvGet('ig_token_info', {});
    if (!force && info.refreshedAt && Date.now() - info.refreshedAt < 7 * 24 * 3600 * 1000) return { skipped: true };
    const res = await this.fetch(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: this.token })}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) throw new InstagramError((data.error && data.error.message) || 'Token refresh failed', { permanent: true });
    await this.store.kvSet('ig_token', data.access_token);
    this.storedToken = data.access_token;
    await this.store.kvSet('ig_token_info', { refreshedAt: Date.now(), expiresAt: Date.now() + (data.expires_in || 5184000) * 1000, from: fingerprint(this.cfg.accessToken) });
    return { refreshed: true, expires_in: data.expires_in };
  }

  tokenInfo() { return this.store.kvGet('ig_token_info', {}); }

  // ---------- "Connect Instagram" (the studio re-authorises its own account, no token pasting) ----------
  get canConnect() { return !!(this.cfg.appId && this.cfg.appSecret); }

  // Where the studio is sent to approve the app on Instagram's own page.
  connectUrl({ redirectUri, state }) {
    const q = new URLSearchParams({
      client_id: this.cfg.appId, redirect_uri: redirectUri, response_type: 'code', state, force_reauth: 'true',
      scope: 'instagram_business_basic,instagram_business_manage_messages',
    });
    return `https://www.instagram.com/oauth/authorize?${q}`;
  }

  // Trades the code Instagram sent back for a long-lived (60 day) token and starts using it straight away.
  async completeConnect({ code, redirectUri }) {
    const json = async (res) => res.json().catch(() => ({}));
    const fail = (d, fallback) => new InstagramError((d && (d.error_message || (d.error && d.error.message))) || fallback, { permanent: true });
    const d1 = await json(await this.fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: this.cfg.appId, client_secret: this.cfg.appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code }),
    }));
    const short = d1.access_token || (d1.data && d1.data[0] && d1.data[0].access_token);
    if (!short) throw fail(d1, 'Instagram did not accept that sign-in');
    const d2 = await json(await this.fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: this.cfg.appSecret, access_token: short })}`));
    if (!d2.access_token) throw fail(d2, 'Could not get a long-lived token');
    const me = await json(await this.fetch(`${this.base}/me?${new URLSearchParams({ fields: 'user_id,username', access_token: d2.access_token })}`));
    if (!me.user_id) throw fail(me, 'Could not read the Instagram account');
    // Never let the wrong account take over this studio's inbox.
    if (this.cfg.accountId && String(me.user_id) !== String(this.cfg.accountId)) {
      throw new InstagramError(`That was @${me.username || 'another account'}. Please sign in with the studio's own Instagram account.`, { permanent: true });
    }
    const now = Date.now();
    await this.store.kvSet('ig_token', d2.access_token);
    await this.store.kvSet('ig_token_info', { refreshedAt: now, expiresAt: now + (d2.expires_in || 5184000) * 1000, from: fingerprint(this.cfg.accessToken) });
    this.storedToken = d2.access_token;
    this.tokenLoadedAt = now;
    this.me = me;
    this.probed = null;
    this.status.connected = true;
    this.status.lastError = null;
    try { await this.subscribe(); } catch (e) { this.log.warn('[instagram] subscribe after reconnect failed:', e.message); }
    return { username: me.username, expiresAt: now + (d2.expires_in || 5184000) * 1000 };
  }

  // Is the stored token still accepted by Instagram right now? Cached briefly so the inbox can ask often.
  async probe({ maxAgeMs = 60000 } = {}) {
    if (this.probed && Date.now() - this.probed.at < maxAgeMs) return this.probed.value;
    let value;
    try {
      await this.loadToken({ maxAgeMs: 0 });
      if (!this.token) value = { connected: false, reason: 'not_configured' };
      else {
        const me = await this.api('GET', '/me', { query: { fields: 'user_id,username' } }, { retries: 1 });
        this.me = me;
        value = { connected: true, username: me.username };
      }
    } catch (e) {
      value = { connected: false, reason: e.code === 190 ? 'expired' : 'error', error: e.message };
    }
    this.probed = { at: Date.now(), value };
    return value;
  }

  // Subscribe this account to the webhook fields we handle.
  async subscribe() {
    const id = (this.me && this.me.user_id) || 'me';
    return this.api('POST', `/${id}/subscribed_apps`, { query: { subscribed_fields: 'messages,messaging_postbacks,messaging_referral' } });
  }

  // Tappable conversation starters shown when someone opens the DM thread.
  async setIceBreakers(questions) {
    const qs = (questions || []).map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
    if (!qs.length) throw new InstagramError('Add at least one conversation starter', { permanent: true });
    return this.api('POST', '/me/messenger_profile', {
      body: { platform: 'instagram', ice_breakers: [{ call_to_actions: qs.map((q) => ({ question: q.slice(0, 80), payload: q.slice(0, 80) })), locale: 'default' }] },
    });
  }

  async profile(igsid) {
    try { return await this.api('GET', `/${igsid}`, { query: { fields: 'name,username' } }, { retries: 1 }); } catch { return {}; }
  }

  // The earlier messages of one chat (newest 40, oldest first), so the assistant knows what the studio's own team
  // already said. Each item is { mid, at, fromUs, text }. Returns [] if Instagram will not say.
  async fetchThread(igsid, limit = 40) {
    try {
      const list = await this.api('GET', '/me/conversations', { query: { platform: 'instagram', user_id: String(igsid), fields: 'id' } }, { retries: 1 });
      const cid = list && list.data && list.data[0] && list.data[0].id;
      if (!cid) return [];
      const conv = await this.api('GET', `/${cid}`, { query: { fields: `messages.limit(${limit}){id,created_time,from,message,attachments}` } }, { retries: 1 });
      const ours = new Set([this.me && this.me.user_id, this.me && this.me.id, this.cfg.accountId].filter(Boolean).map(String));
      const handle = String(this.handle || '').toLowerCase();
      const out = (((conv && conv.messages && conv.messages.data) || []).map((m) => {
        const from = m.from || {};
        const fromUs = ours.has(String(from.id)) || (!!handle && String(from.username || '').toLowerCase() === handle);
        const hasMedia = m.attachments && ((m.attachments.data && m.attachments.data.length) || (Array.isArray(m.attachments) && m.attachments.length));
        return { mid: m.id, at: Date.parse(m.created_time) || Date.now(), fromUs, text: String(m.message || '').trim() || (hasMedia ? '[sent a photo or link]' : '') };
      }).filter((m) => m.text)).sort((a, b) => a.at - b.at);
      // keep the archive current: one row per chat, addressed by its hash key (written through every time a chat is read)
      const acct = (this.me && this.me.user_id) || this.cfg.accountId;
      if (acct && out.length) await this.store.archiveUpsert({ conv_id: cid, chat_key: chatKey(acct, igsid), igsid: String(igsid), last_at: out[out.length - 1].at, msgs: out }).catch(() => {});
      return out;
    } catch (e) {
      this.log.warn(`[instagram] could not read earlier messages: ${e.message}`);
      return [];
    }
  }

  // A person writes for the first time since the assistant was switched on, but the chat may already have a history
  // (the studio's own outreach, a negotiation in progress). Load it BEFORE their new message is stored, so the
  // transcript is in order and the assistant does not greet or interrogate someone mid-conversation.
  async importHistory(chatId, senderId, prof, ev) {
    if (await this.store.getLeadByChat(chatId)) return;
    const mid = ev.message && ev.message.mid;
    const text = ev.message && typeof ev.message.text === 'string' ? ev.message.text.trim() : '';
    const recent = Date.now() - 2 * 60000;
    const thread = (await this.fetchThread(senderId)).filter((m) => m.mid !== mid && !(m.text === text && !m.fromUs && m.at > recent));
    if (!thread.length) return;
    const { lead } = await this.engine.bindChat(chatId, prof, { channel: this.channel, source: this.channel });
    if (await this.store.countMessages(lead.id)) return; // another webhook got here first
    for (const m of thread) {
      const id = await this.store.addMessage({
        lead_id: lead.id, direction: m.fromUs ? 'out' : 'in', role: m.fromUs ? 'admin' : 'user', text: m.text.slice(0, 4000),
        ext_id: m.mid || null, status: m.fromUs ? 'sent' : 'received', processed: true, created_at: m.at,
      }).catch(() => null);
      if (!id) continue;
    }
    const lastIn = [...thread].reverse().find((m) => !m.fromUs);
    const lastOut = [...thread].reverse().find((m) => m.fromUs);
    const team = thread.some((m) => m.fromUs);
    const lastTeam = [...thread].reverse().find((m) => m.fromUs);
    const meta = { ...lead.meta, history_imported: thread.length, ...(team ? { team_thread: true, team_last_at: lastTeam.at } : {}) };
    await this.store.updateLead(lead.id, { meta, last_inbound_at: lastIn ? lastIn.at : null, last_outbound_at: lastOut ? lastOut.at : null });
    await this.store.addEvent(lead.id, 'history_imported', { messages: thread.length, team });
  }

  // Rebuilds the transcript of a chat that already exists from Instagram's own copy of the conversation (for chats
  // started before history was loaded). The assistant's old replies are kept as the assistant's, anything else from
  // our account is the team's. The chat's pause is left exactly as it is.
  async reloadHistory(leadId) {
    const lead = await this.store.getLead(leadId);
    if (!lead || !lead.chat_id || !String(lead.chat_id).startsWith(this.prefix)) throw new InstagramError('Not an Instagram chat', { permanent: true });
    const thread = await this.fetchThread(this.igsid(lead), 100);
    if (!thread.length) return { reloaded: false, reason: 'Instagram returned no messages' };
    if (Number((await this.store.get('SELECT COUNT(*) c FROM media WHERE lead_id=? AND removed_at IS NULL', lead.id)).c)) return { reloaded: false, reason: 'This chat has photos, which a reload would detach' };
    const old = await this.store.all('SELECT direction, role, text, ext_id FROM messages WHERE lead_id=?', lead.id);
    const botTexts = old.filter((r) => r.direction === 'out' && r.role === 'assistant').map((r) => r.text);
    const isBot = (m) => m.fromUs && botTexts.some((t) => t === m.text || t.includes(m.text) || (t.length > 40 && m.text.startsWith(t.slice(0, 40))));
    await this.store.tx(async (t) => {
      await t.run('DELETE FROM messages WHERE lead_id=?', lead.id);
      for (const m of thread) {
        const bot = isBot(m);
        await t.addMessage({ lead_id: lead.id, direction: m.fromUs ? 'out' : 'in', role: m.fromUs ? (bot ? 'assistant' : 'admin') : 'user', text: m.text.slice(0, 4000), ext_id: m.mid || null, status: m.fromUs ? 'sent' : 'received', processed: true, created_at: m.at });
      }
    });
    const lastIn = [...thread].reverse().find((m) => !m.fromUs);
    const lastOut = [...thread].reverse().find((m) => m.fromUs);
    const team = thread.some((m) => m.fromUs && !isBot(m));
    const lastTeam = [...thread].reverse().find((m) => m.fromUs && !isBot(m));
    const meta = { ...lead.meta, history_imported: thread.length, ...(team ? { team_thread: true, team_last_at: lastTeam.at } : {}) };
    await this.store.updateLead(lead.id, { meta, summary: '', summary_upto: 0, last_inbound_at: lastIn ? lastIn.at : lead.last_inbound_at, last_outbound_at: lastOut ? lastOut.at : lead.last_outbound_at });
    await this.store.addEvent(lead.id, 'history_reloaded', { messages: thread.length, was: old.length, team });
    this.engine.changed('lead', lead.id);
    return { reloaded: true, messages: thread.length, was: old.length, team };
  }

  // A message the studio's team sent from the Instagram app or phone. The assistant never saw it, so keep it in the
  // transcript, and (default) stand down: a person is already talking to them.
  async handleEcho(ev) {
    const customerId = ev.recipient && String(ev.recipient.id);
    const mid = ev.message.mid || null;
    const text = typeof ev.message.text === 'string' ? ev.message.text.trim() : '';
    if (!customerId || !text) return;
    const lead = await this.store.getLeadByChat(`${this.prefix}${customerId}`);
    if (!lead) return; // no chat with us yet: importHistory reads it if they ever write back
    if (mid && (await this.store.get('SELECT id FROM messages WHERE ext_id=?', mid))) return;
    // The assistant's own replies echo back too, sometimes before their id is saved: match by text.
    const mine = await this.store.all("SELECT text FROM messages WHERE lead_id=? AND direction='out' ORDER BY id DESC LIMIT 6", lead.id);
    if (mine.some((r) => r.text === text || (r.text.length > 40 && r.text.startsWith(text.slice(0, 40))))) return;
    await this.store.addMessage({ lead_id: lead.id, direction: 'out', role: 'admin', text: text.slice(0, 4000), ext_id: mid, status: 'sent', processed: true });
    const acct = this.cfg.accountId || (this.me && this.me.user_id) || this.engine.igAccountId;
    if (acct) await this.store.archiveAppend(chatKey(acct, customerId), [{ mid: mid || `local:echo${Date.now()}`, at: Date.now(), fromUs: true, text: text.slice(0, 4000) }]).catch(() => {});
    const meta = { ...lead.meta, team_thread: true, team_last_at: Date.now() };
    await this.store.updateLead(lead.id, { meta, last_outbound_at: Date.now() });
    await this.store.addEvent(lead.id, 'team_message', {});
    this.engine.changed('lead', lead.id);
  }

  // ---------- sending ----------
  igsid(lead) { return String(lead.chat_id).slice(this.prefix.length); }

  get transport() {
    return {
      send: (lead, text, opts = {}) => this.sendText(lead, text, opts),
      typing: (chatId) => this.api('POST', '/me/messages', { body: { recipient: { id: String(chatId).slice(this.prefix.length) }, sender_action: 'typing_on' } }, { retries: 1 }).catch(() => {}),
      sendRaw: async () => {}, // team alerts go through Telegram or the webhook, not Instagram
    };
  }

  // Last look before the assistant speaks: has a person on the team ALREADY ANSWERED what the customer last said?
  // Older team involvement (a month-old negotiation, the studio's own outreach) does not matter: that is only context.
  // It reads the live chat, so it does not depend on the echo webhook arriving. A message from our own account that
  // the assistant did not write (not matched by id or by its text) is a person's. It counts only if it is NEWER than the
  // customer's latest message (the later of Instagram's time and the moment we received it).
  async teamReplied(lead, { dryRun = false } = {}) {
    const thread = await this.fetchThread(this.igsid(lead), 10);
    const mine = await this.store.all("SELECT text, ext_id FROM messages WHERE lead_id=? AND direction='out' AND role!='admin' ORDER BY id DESC LIMIT 12", lead.id);
    const known = new Set((await this.store.all("SELECT ext_id FROM messages WHERE lead_id=? AND ext_id IS NOT NULL ORDER BY id DESC LIMIT 60", lead.id)).map((r) => r.ext_id));
    const lastCustomer = Math.max(lead.last_inbound_at || 0, ...thread.filter((m) => !m.fromUs).map((m) => m.at));
    const isBot = (m) => mine.some((r) => r.text.includes(m.text) || (r.text.length > 40 && m.text.startsWith(r.text.slice(0, 40))));
    const answered = thread.filter((m) => m.fromUs && m.at > lastCustomer && !isBot(m));
    if (!answered.length) return false;
    if (dryRun) return answered.map((m) => ({ at: m.at, text: m.text.slice(0, 80) }));
    for (const m of answered) {
      if (known.has(m.mid)) continue;
      await this.store.addMessage({ lead_id: lead.id, direction: 'out', role: 'admin', text: m.text.slice(0, 4000), ext_id: m.mid, status: 'sent', processed: true, created_at: Math.min(m.at, Date.now()) }).catch(() => null);
    }
    const fresh = await this.store.getLead(lead.id);
    await this.store.updateLead(lead.id, { last_outbound_at: Date.now(), meta: { ...fresh.meta, team_thread: true, team_last_at: Date.now() } });
    this.engine.changed('lead', lead.id);
    return true;
  }

  async sendText(lead, text, { role } = {}) {
    if (role !== 'admin' && (await this.teamReplied(lead).catch(() => false))) {
      const e = new InstagramError('The team has already replied to this message, so the assistant held back.', { permanent: true });
      e.heldBack = true;
      throw e;
    }
    const age = Date.now() - (lead.last_inbound_at || 0);
    let extra = {};
    if (age > WINDOW_MS) {
      if (role === 'admin' && age <= HUMAN_AGENT_MS) extra = { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' };
      else {
        throw new InstagramError('Outside Instagram\'s 24 hour messaging window. Only a human can reply (up to 7 days after their last message) using Send from the lead view.', { permanent: true });
      }
    }
    let last;
    for (const part of chunk(text)) {
      const send = () => this.api('POST', '/me/messages', { body: { recipient: { id: this.igsid(lead) }, message: { text: part }, ...extra } }, { once: true });
      const startedAt = Date.now();
      try {
        last = await send();
      } catch (e) {
        if (!e.ambiguous) throw e;
        // The request failed in a way that does not tell us whether the message left. Look at the chat before sending again, so a message
        // that was delivered is never sent a second or third time.
        await sleep(2500);
        const thread = await this.fetchThread(this.igsid(lead), 8);
        const hit = [...thread].reverse().find((m) => m.fromUs && m.text === part.trim() && m.at >= startedAt - 15000);
        last = hit ? { message_id: hit.mid } : await send();
      }
    }
    return last && last.message_id;
  }

  // Downloads a picture the customer sent. Only Meta's own image hosts are fetched, and only images up to 4 MB.
  async fetchImage(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:' || !IMAGE_HOSTS.test(u.hostname)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await this.fetch(u.toString(), { signal: ctrl.signal });
      if (!res.ok) return null;
      const mime = String(res.headers && res.headers.get ? res.headers.get('content-type') || '' : '').split(';')[0].trim().toLowerCase();
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!/^image\//.test(mime) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
      return { mime, bytes };
    } catch { return null; } finally { clearTimeout(timer); }
  }

  // ---------- webhook ----------
  verifyChallenge(query) {
    if (query.get('hub.mode') === 'subscribe' && this.cfg.verifyToken && query.get('hub.verify_token') === this.cfg.verifyToken) return query.get('hub.challenge');
    return null;
  }

  validSignature(raw, header) {
    if (!this.cfg.appSecret) return false; // refuse unsigned webhooks: anyone could forge leads otherwise
    if (!header || !header.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', this.cfg.appSecret).update(raw).digest('hex');
    const got = header.slice(7);
    return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  }

  // Which other deployments need this (already signature-checked) payload: [url, ...] and the same
  // payload without the entries that belong to them.
  split(payload) {
    const fwd = this.cfg.forward || {};
    const targets = new Set();
    const mine = [];
    for (const entry of (payload && payload.entry) || []) {
      const url = fwd[String(entry.id)];
      if (url) targets.add(url);
      else if (!this.cfg.accountId || String(entry.id) === this.cfg.accountId) mine.push(entry); // events for accounts that are not ours are dropped
    }
    return { targets: [...targets], local: { ...payload, entry: mine } };
  }

  // Passes the ORIGINAL body and signature on untouched, so the receiving deployment verifies it itself.
  async forward(url, raw, signature) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        const res = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature || '' }, body: raw, signal: ctrl.signal }).finally(() => clearTimeout(timer));
        if (res.ok) return true;
        this.log.warn(`[instagram] forward to ${url} answered ${res.status}`);
      } catch (e) { this.log.warn(`[instagram] forward to ${url} failed: ${e.message}`); }
    }
    return false;
  }

  // Processes a verified webhook payload. Never throws: Meta retries on non-200,
  // and a poison event must not block the queue.
  async handleWebhook(payload) {
    this.status.lastWebhookAt = Date.now();
    const events = [];
    for (const entry of (payload && payload.entry) || []) {
      if (entry.id) this.engine.igAccountId = String(entry.id);
      for (const ev of entry.messaging || []) events.push({ ev, igId: String(entry.id || (ev.recipient && ev.recipient.id) || '') });
    }
    // Referrals first, so a message in the same batch lands on the right lead.
    events.sort((a, b) => (b.ev.referral ? 1 : 0) - (a.ev.referral ? 1 : 0));
    for (const { ev, igId } of events) {
      try { await this.handleEvent(ev, igId); } catch (e) { this.log.error('[instagram] event failed', e); }
    }
  }

  async handleEvent(ev, igId) {
    const senderId = ev.sender && String(ev.sender.id);
    if (senderId && senderId === igId && ev.message && ev.message.is_echo) return this.handleEcho(ev); // the team wrote from the app
    if (!senderId || senderId === igId) return; // our own account
    if (!ev.message && !ev.postback && !ev.referral) return; // read receipts, deliveries and reactions need no answer
    const chatId = `${this.prefix}${senderId}`;
    const ref = (ev.referral && ev.referral.ref) || (ev.postback && ev.postback.referral && ev.postback.referral.ref) || (ev.message && ev.message.referral && ev.message.referral.ref) || null;

    let profile = {};
    const known = await this.store.getLeadByChat(chatId);
    if (!known) profile = await this.profile(senderId);
    const prof = { first_name: (profile.name || '').split(/\s+/)[0] || null, username: profile.username || null };

    if (ref) await this.engine.linkReferral(chatId, ref, prof, this.channel);
    if (!known && !ref && !(ev.message && ev.message.is_echo)) await this.importHistory(chatId, senderId, prof, ev).catch((e) => this.log.warn(`[instagram] history import failed: ${e.message}`));

    if (ev.message) {
      if (ev.message.is_echo) return; // messages sent from our own account/app
      const text = typeof ev.message.text === 'string' ? ev.message.text.trim() : '';
      if (!text) {
        const lead = (await this.store.getLeadByChat(chatId)) || (await this.engine.bindChat(chatId, prof, { channel: this.channel, source: this.channel })).lead;
        const types = (Array.isArray(ev.message.attachments) ? ev.message.attachments : []).map((a) => String((a && a.type) || '').toLowerCase());
        const kind = types.find((t) => MEDIA[t]);
        // Instagram also sends empty companion events (for example 0.4 seconds after a message that contains a
        // phone number or a link), hearts and unsupported items. The customer did not send those, so they get no
        // reply and no transcript line: only a note for diagnosis.
        if (!kind) {
          await this.store.addEvent(lead.id, 'non_text_ignored', { types, unsupported: !!ev.message.is_unsupported });
          return;
        }
        // A photo is looked at and kept: the assistant answers what is in it and the picture shows in the CRM.
        if (kind === 'image') {
          const shots = (ev.message.attachments || []).filter((a) => a && String(a.type).toLowerCase() === 'image' && a.payload && a.payload.url).slice(0, 4);
          let handled = 0;
          for (const [i, a] of shots.entries()) {
            const img = await this.fetchImage(a.payload.url);
            if (!img) continue;
            await this.engine.receiveImage({ channel: this.channel, chatId, bytes: img.bytes, mime: img.mime, profile: prof, externalId: ev.message.mid ? `${ev.message.mid}${i ? `:${i}` : ''}` : null, token: ref });
            handled++;
          }
          if (handled) return;
        }
        // The concierge decides what to say about a video, file or link from the whole chat (a video the team asked for is not "something I cannot open").
        if (this.config.agentMode === 'concierge') {
          await this.engine.receive({ channel: this.channel, chatId, text: `[sent ${MEDIA[kind]}]`, profile: prof, externalId: ev.message.mid || null, token: ref });
          return;
        }
        try { await this.store.addMessage({ lead_id: lead.id, direction: 'in', role: 'user', text: `[sent ${MEDIA[kind]}]`, ext_id: ev.message.mid || null, processed: true }); } catch { return; }
        await this.store.updateLead(lead.id, { last_inbound_at: Date.now() });
        const first = (lead.name || '').split(/\s+/)[0];
        const reply = `Thanks${first ? `, ${first}` : ''}, I can see you sent ${MEDIA[kind]}. I cannot open attachments in this chat yet, so could you tell me in a few words what it shows or what you would like us to see? I will pass it to the team.`;
        // several shares in a row get one acknowledgement, not one each
        const lastOut = await this.store.get("SELECT text, created_at FROM messages WHERE lead_id=? AND direction='out' ORDER BY id DESC LIMIT 1", lead.id);
        if (lastOut && lastOut.text === reply && Date.now() - Number(lastOut.created_at) < 30 * 60000) return;
        const id = await this.store.addMessage({ lead_id: lead.id, direction: 'out', role: 'assistant', text: reply, status: 'pending' });
        await this.engine.deliver(id).catch(() => {});
        return;
      }
      await this.engine.receive({ channel: this.channel, chatId, text, profile: prof, externalId: ev.message.mid || null, token: ref });
      return;
    }
    if (ev.postback) {
      // Ice breaker taps arrive as postbacks; treat the tapped question as the customer's message.
      const text = String(ev.postback.title || ev.postback.payload || '').trim();
      if (text) await this.engine.receive({ channel: this.channel, chatId, text, profile: prof, externalId: ev.postback.mid || null, token: ref });
    }
  }
}

module.exports = { Instagram, InstagramError, chunk, WINDOW_MS, HUMAN_AGENT_MS };
