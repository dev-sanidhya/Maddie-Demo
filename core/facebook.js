'use strict';
// Facebook Messenger for a Page, on the same engine as Instagram.
//
// Messenger and Instagram DMs share almost everything: the same webhook envelope, the same Send API shape, the same
// 24 hour reply window and the same 7 day human-agent tag. So this class reuses the Instagram channel and only changes:
//  - the Graph host (graph.facebook.com) and the token (a Page access token from the environment, which does not expire)
//  - the Send API needs a messaging_type on every message
//  - chats are stored as `fb:<page scoped id>` with channel 'facebook'

const { Instagram, InstagramError, chunk, WINDOW_MS, HUMAN_AGENT_MS } = require('./instagram');

class Facebook extends Instagram {
  constructor({ cfg, ...rest }) {
    super({ cfg: { ...cfg, accountId: cfg.pageId || '' }, ...rest });
    this.channel = 'facebook';
    this.prefix = 'fb:';
    this.status.enabled = !!cfg.accessToken;
  }

  get enabled() { return !!this.cfg.accessToken; }
  get token() { return this.cfg.accessToken; }
  get base() { return `https://graph.facebook.com/${this.cfg.apiVersion}`; }
  get handle() { return (this.me && this.me.name) || this.cfg.handle || null; }
  get canConnect() { return false; }
  async loadToken() { return this.token; } // a Page token lives in the environment, nothing is refreshed or stored
  async refreshToken() { return { skipped: true }; }
  async tokenInfo() { return {}; }
  chatLink() { return this.cfg.pageId ? `https://m.me/${this.cfg.handle || this.cfg.pageId}` : null; }

  // Page tokens are sent as access_token, which the Graph API accepts on every call.
  api(method, path, opts = {}, o) {
    return super.api(method, path, { ...opts, query: { ...(opts.query || {}), access_token: this.token } }, o);
  }

  async start() {
    if (!this.enabled) { this.log.warn('[facebook] no FACEBOOK_PAGE_ACCESS_TOKEN, Messenger channel disabled'); return; }
    try {
      this.me = await this.api('GET', '/me', { query: { fields: 'id,name' } }, { retries: 2 });
      this.status.connected = true;
      this.status.lastError = null;
      this.log.log(`[facebook] connected as ${this.me.name}`);
    } catch (e) {
      this.status.connected = false;
      this.status.lastError = e.message;
      this.log.error('[facebook] could not connect:', e.message);
    }
  }

  async probe({ maxAgeMs = 60000 } = {}) {
    if (this.probed && Date.now() - this.probed.at < maxAgeMs) return this.probed.value;
    let value;
    try {
      if (!this.token) value = { connected: false, reason: 'not_configured' };
      else {
        this.me = await this.api('GET', '/me', { query: { fields: 'id,name' } }, { retries: 1 });
        value = { connected: true, username: this.me.name };
      }
    } catch (e) {
      value = { connected: false, reason: e.code === 190 ? 'expired' : 'error', error: e.message };
    }
    this.probed = { at: Date.now(), value };
    return value;
  }

  // Receive customer messages, button taps and ad/link referrals for the Page.
  async subscribe() {
    const id = this.cfg.pageId || (this.me && this.me.id) || 'me';
    return this.api('POST', `/${id}/subscribed_apps`, { query: { subscribed_fields: 'messages,messaging_postbacks,messaging_referrals' } });
  }

  async profile(psid) {
    try {
      const p = await this.api('GET', `/${psid}`, { query: { fields: 'first_name,last_name' } }, { retries: 1 });
      return { name: [p.first_name, p.last_name].filter(Boolean).join(' ') || null, username: null };
    } catch { return {}; }
  }

  async sendText(lead, text, { role } = {}) {
    const age = Date.now() - (lead.last_inbound_at || 0);
    let kind = { messaging_type: 'RESPONSE' };
    if (age > WINDOW_MS) {
      if (role === 'admin' && age <= HUMAN_AGENT_MS) kind = { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' };
      else throw new InstagramError("Outside Messenger's 24 hour messaging window. Only a human can reply (up to 7 days after their last message).", { permanent: true });
    }
    let last;
    for (const part of chunk(text)) {
      last = await this.api('POST', '/me/messages', { body: { recipient: { id: this.igsid(lead) }, message: { text: part }, ...kind } });
    }
    return last && last.message_id;
  }
}

module.exports = { Facebook };
