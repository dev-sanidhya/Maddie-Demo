'use strict';
// Telegram Bot API over long polling (no public URL needed). Reliability notes:
//  - the update offset is persisted only AFTER the inbound message is stored, so
//    a crash re-delivers instead of dropping; engine.receive dedupes by update_id
//  - 429 honours retry_after, 5xx/network errors back off, 403/400 are permanent
//  - one poller per token: a 409 (another instance polling) backs off, not crashes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TelegramError extends Error {
  constructor(msg, { permanent = false, status = 0 } = {}) { super(msg); this.permanent = permanent; this.status = status; }
}

function chunk(text, size = 3900) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.3) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

class Telegram {
  constructor({ token, engine, store, settings, config, log = console, fetchImpl }) {
    this.token = token;
    this.engine = engine;
    this.store = store;
    this.settings = settings;
    this.config = config;
    this.log = log;
    this.fetch = fetchImpl || globalThis.fetch;
    this.me = null;
    this.running = false;
    this.status = { enabled: !!token, connected: false, lastPollAt: null, lastError: null };
    this.rate = new Map();
  }

  get enabled() { return !!this.token; }
  get botUsername() { return this.me ? this.me.username : null; }
  deepLink(payload) { return this.botUsername ? `https://t.me/${this.botUsername}${payload ? `?start=${encodeURIComponent(payload)}` : ''}` : null; }

  async api(method, params = {}, { timeoutMs = 20000, retries = 3 } = {}) {
    if (!this.token) throw new TelegramError('Telegram is not configured');
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (data.ok) return data.result;
        const desc = data.description || `HTTP ${res.status}`;
        const code = data.error_code || res.status;
        if (code === 429) {
          lastErr = new TelegramError(desc, { status: 429 });
          await sleep(((data.parameters && data.parameters.retry_after) || 2) * 1000 + 200);
          continue;
        }
        if (code === 409) throw new TelegramError(desc, { status: 409 });
        if (code >= 400 && code < 500) throw new TelegramError(desc, { permanent: true, status: code });
        lastErr = new TelegramError(desc, { status: code });
      } catch (e) {
        if (e instanceof TelegramError && (e.permanent || e.status === 409)) throw e;
        lastErr = e.name === 'AbortError' ? new TelegramError('Telegram request timed out') : e;
      } finally {
        clearTimeout(timer);
      }
      await sleep(500 * 2 ** attempt);
    }
    throw lastErr || new TelegramError('Telegram request failed');
  }

  async sendRaw(chatId, text, extra = {}) {
    const parts = chunk(text);
    let last;
    for (let i = 0; i < parts.length; i++) {
      last = await this.api('sendMessage', { chat_id: chatId, text: parts[i], disable_web_page_preview: true, ...(i === parts.length - 1 ? extra : {}) });
    }
    return last && last.message_id;
  }

  get transport() {
    return {
      send: (lead, text) => this.sendRaw(lead.chat_id, text),
      typing: (chatId) => this.api('sendChatAction', { chat_id: chatId, action: 'typing' }, { retries: 1, timeoutMs: 5000 }),
      sendRaw: (chat, text) => this.sendRaw(chat, text),
    };
  }

  // webhook: { url, secret } switches to push delivery (serverless); without it the bot long-polls.
  async start({ webhook } = {}) {
    if (!this.enabled) { this.log.warn('[telegram] no TELEGRAM_BOT_TOKEN, running without Telegram (admin + simulator still work)'); return; }
    this.me = await this.api('getMe');
    this.status.connected = true;
    if (webhook) await this.api('setWebhook', { url: webhook.url, secret_token: webhook.secret, allowed_updates: ['message'] });
    else await this.api('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    await this.api('setMyCommands', {
      commands: [
        { command: 'start', description: 'Start or restart the conversation' },
        { command: 'help', description: 'What this assistant can do' },
        { command: 'stop', description: 'Stop receiving messages' },
      ],
    }).catch(() => {});
    this.log.log(`[telegram] connected as @${this.me.username}${webhook ? ' (webhook)' : ''}`);
    if (webhook) return;
    this.running = true;
    this.poll().catch((e) => this.log.error('[telegram] poller crashed', e));
  }

  stop() { this.running = false; }

  async poll() {
    let backoff = 1000;
    while (this.running) {
      try {
        const offset = await this.store.kvGet('tg_offset', 0);
        const updates = await this.api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, { timeoutMs: 40000, retries: 1 });
        this.status.lastPollAt = Date.now();
        this.status.connected = true;
        this.status.lastError = null;
        backoff = 1000;
        for (const u of updates) {
          try { await this.handleUpdate(u); } catch (e) { this.log.error('[telegram] update failed', u.update_id, e); }
          await this.store.kvSet('tg_offset', u.update_id + 1);
        }
      } catch (e) {
        this.status.connected = false;
        this.status.lastError = String(e.message).slice(0, 200);
        if (e.status === 409) { this.log.warn('[telegram] 409: another instance is polling this bot token'); backoff = 8000; }
        else this.log.warn('[telegram] poll error:', e.message);
        await sleep(backoff);
        backoff = Math.min(30000, backoff * 2);
      }
    }
  }

  tooFast(chatId) {
    const now = Date.now();
    const arr = (this.rate.get(chatId) || []).filter((t) => now - t < 60000);
    arr.push(now);
    this.rate.set(chatId, arr);
    return arr.length > 25;
  }

  async handleUpdate(u) {
    const m = u.message;
    if (!m || !m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot) return;
    const chatId = String(m.chat.id);
    const profile = { first_name: m.from.first_name, username: m.from.username };
    if (this.tooFast(chatId)) return;

    if (m.contact) return this.handleContact(m, chatId, profile);
    if (typeof m.text !== 'string') {
      const lead = await this.store.getLeadByChat(chatId);
      if (lead) await this.store.addMessage({ lead_id: lead.id, direction: 'in', role: 'user', text: '[sent a non-text message]', tg_update_id: u.update_id, processed: true });
      await this.sendRaw(chatId, "I can only read text messages for now. Could you type that out for me?").catch(() => {});
      return;
    }
    const text = m.text.trim();
    if (!text) return;
    if (text.startsWith('/')) return this.handleCommand(text, chatId, profile, u.update_id);

    const lead = await this.store.getLeadByChat(chatId);
    if (lead && lead.meta.awaiting_match) {
      if (/^skip$/i.test(text)) return this.finishMatch(lead, chatId, false);
      const { extractContact } = require('./facts');
      const c = extractContact(text);
      if (c.phone) return this.matchPhone(chatId, c.phone, lead);
    }
    await this.engine.receive({ channel: 'telegram', chatId, text, profile, updateId: u.update_id });
  }

  async handleCommand(text, chatId, profile, updateId) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase();
    const arg = rest.join(' ').trim();
    const e = this.engine;

    if (cmd === '/start') {
      const payload = arg;
      const { lead, linked } = await e.bindChat(chatId, profile, { token: payload && payload !== 'gform' ? payload : undefined, source: payload ? `telegram:${payload.slice(0, 20)}` : 'telegram' });
      if (lead.opted_out) await e.store.updateLead(lead.id, { opted_out: 0 });
      if ((await e.store.countMessages(lead.id)) > 0) {
        const first = (lead.name || '').split(/\s+/)[0] || 'there';
        await this.sendRaw(chatId, `Welcome back, ${first}! Just tell me whatever you would like to add or ask, and we can pick up from where we left off.`, { reply_markup: { remove_keyboard: true } }).catch(() => {});
        return;
      }
      if (payload === 'gform' && !lead.phone && !linked) {
        const meta = { ...lead.meta, awaiting_match: true };
        await e.store.updateLead(lead.id, { meta });
        await this.sendRaw(chatId, `Hi ${profile.first_name || 'there'}! To connect this chat to the enquiry you just filled in, tap "Share my number" below, or just type the phone number you used on the form.`, {
          reply_markup: { keyboard: [[{ text: 'Share my number', request_contact: true }], [{ text: 'Skip' }]], resize_keyboard: true, one_time_keyboard: true },
        }).catch(() => {});
        return;
      }
      await e.start(lead.id).catch((err) => this.log.error('[telegram] start failed', err));
      return;
    }

    if (cmd === '/help') {
      const s = this.settings.get();
      return this.sendRaw(chatId, `I'm ${s.agent.name}, the virtual assistant for ${s.business.name}. I ask a few quick questions about your project so the right designer can help you. Just chat with me normally. Send /stop at any time to stop messages.`).catch(() => {});
    }
    if (cmd === '/stop') {
      const lead = await e.store.getLeadByChat(chatId);
      if (lead) { await e.store.updateLead(lead.id, { opted_out: 1 }); await e.store.addEvent(lead.id, 'opted_out', {}); e.changed('lead', lead.id); }
      return this.sendRaw(chatId, "Understood, I won't message you any more. Send /start any time if you change your mind.").catch(() => {});
    }
    if (cmd === '/reset' && this.config.demoMode) {
      const lead = await e.store.getLeadByChat(chatId);
      if (lead) {
        await e.resetLead(lead.id);
        await this.sendRaw(chatId, 'Demo reset done. Starting fresh...').catch(() => {});
        await e.start(lead.id).catch(() => {});
      }
      return;
    }
    if (cmd === '/setup') {
      if (arg && arg === this.config.adminPassword) {
        await this.settings.update({ handoff: { notify_chat_id: chatId } });
        return this.sendRaw(chatId, 'Done. This chat will now receive team alerts for new active leads. (Delete your /setup message, it contains the password.)').catch(() => {});
      }
      return this.sendRaw(chatId, 'Usage: /setup <admin password>').catch(() => {});
    }
    // Unknown command: treat as normal text so nothing is silently swallowed.
    await this.engine.receive({ channel: 'telegram', chatId, text, profile, updateId });
  }

  async handleContact(m, chatId, profile) {
    const c = m.contact;
    if (c.user_id && m.from && c.user_id !== m.from.id) {
      return this.sendRaw(chatId, 'Please share your own number using the button, or type it.').catch(() => {});
    }
    const lead = (await this.store.getLeadByChat(chatId)) || (await this.engine.bindChat(chatId, profile)).lead;
    return this.matchPhone(chatId, c.phone_number, lead);
  }

  async matchPhone(chatId, phone, lead) {
    const linked = await this.engine.linkByPhone(chatId, phone);
    let target = linked;
    if (!target) {
      await this.store.updateLead(lead.id, { phone });
      target = await this.store.getLead(lead.id);
    }
    return this.finishMatch(target, chatId, !!linked);
  }

  async finishMatch(lead, chatId) {
    const fresh = (await this.store.getLeadByChat(chatId)) || lead;
    const meta = { ...fresh.meta };
    delete meta.awaiting_match;
    await this.store.updateLead(fresh.id, { meta });
    await this.sendRaw(chatId, 'Thanks!', { reply_markup: { remove_keyboard: true } }).catch(() => {});
    await this.engine.start(fresh.id).catch((err) => this.log.error('[telegram] start failed', err));
  }
}

module.exports = { Telegram, TelegramError, chunk };
