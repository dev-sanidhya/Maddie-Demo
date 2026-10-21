'use strict';
// "Connect Instagram" for the studio's Lead Inbox: when Instagram ends the session behind the access token
// (a password change, a security reset), the studio taps Reconnect, signs in on Instagram's own page and
// approves. No token is ever shown or pasted, and no redeploy is needed: the new token is stored in the
// database, which the Instagram channel reads first.
//
//   GET /api/crm/instagram           (signed in)  { connected, username, expires_at, days_left, reason, can_connect }
//   GET /api/crm/instagram/connect   (signed in)  sends the browser to Instagram's approval page
//   GET /crm/instagram/callback      (public)     Instagram returns here with a one-time code, then back to /crm

const crypto = require('node:crypto');

const STATE_TTL_MS = 15 * 60 * 1000;

function mountInstagramConnect({ route, send, instagram, config }) {
  const secret = `${config.crmPassword || ''}|${config.intakeSecret}`;
  const sign = (ts) => crypto.createHmac('sha256', secret).update(`ig-connect|${ts}`).digest('hex').slice(0, 32);
  const makeState = () => { const ts = Date.now(); return `${ts}.${sign(ts)}`; };
  const stateOk = (state) => {
    const [ts, sig] = String(state || '').split('.');
    if (!/^\d+$/.test(ts || '') || !sig || Date.now() - Number(ts) > STATE_TTL_MS || Number(ts) > Date.now() + 60000) return false;
    const want = sign(ts);
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  };
  // The address Instagram sends the studio back to must match, character for character, the one registered in the Meta app.
  const redirectUri = (req) => {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const proto = config.serverless || /^https/.test(config.publicUrl) ? 'https' : String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${host}/crm/instagram/callback`;
  };
  const go = (res, location) => { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' }); res.end(); };

  route('GET', '/api/crm/instagram', { crm: true }, async (req, res) => {
    const probe = await instagram.probe();
    const info = (await instagram.tokenInfo()) || {};
    const daysLeft = info.expiresAt ? Math.max(0, Math.floor((info.expiresAt - Date.now()) / 86400000)) : null;
    send(res, 200, {
      connected: !!probe.connected, username: probe.username || instagram.handle || null, reason: probe.reason || null,
      expires_at: info.expiresAt || null, days_left: daysLeft, can_connect: instagram.canConnect,
    });
  });

  route('GET', '/api/crm/instagram/connect', { crm: true }, async (req, res) => {
    if (!instagram.canConnect) return send(res, 503, { error: 'Instagram connect is not set up on this deployment.' });
    go(res, instagram.connectUrl({ redirectUri: redirectUri(req), state: makeState() }));
  });

  route('GET', '/crm/instagram/callback', { public: true }, async (req, res, { query }) => {
    if (query.get('error') || query.get('error_reason')) return go(res, '/crm?ig=denied');
    if (!stateOk(query.get('state'))) return go(res, '/crm?ig=expired');
    const code = String(query.get('code') || '').replace(/#_$/, '');
    if (!code) return go(res, '/crm?ig=failed');
    try {
      await instagram.completeConnect({ code, redirectUri: redirectUri(req) });
      go(res, '/crm?ig=connected');
    } catch (e) {
      console.warn('[instagram] reconnect failed:', e.message);
      go(res, `/crm?ig=failed&m=${encodeURIComponent(String(e.message).slice(0, 140))}`);
    }
  });
}

module.exports = { mountInstagramConnect };
