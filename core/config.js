'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (no dependency). Real environment variables win.
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(path.join(ROOT, '.env'));

const env = process.env;
const useCloudflare = !!(env.CF_ACCOUNT_ID && env.CF_API_TOKEN);
const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

module.exports = {
  ROOT,
  port: num(env.PORT, 3000),
  dbPath: path.resolve(ROOT, env.DB_PATH || 'data/funnel.db'),
  // Postgres connection string (Supabase pooler). When set it replaces the local SQLite file.
  // LOCAL_ONLY=1 forces the local SQLite file even when a production DATABASE_URL sits in .env (safe previews).
  databaseUrl: env.LOCAL_ONLY ? '' : (env.DATABASE_URL || ''),
  cronSecret: env.CRON_SECRET || '',
  // A second, narrower login: the studio's own team gets this password and sees only the Lead Inbox (/crm).
  crmPassword: env.CRM_PASSWORD || '',
  // What the storage meter in the Lead Inbox treats as 100%: this client's share of the free plan (MB).
  limits: { photosMb: Number(env.STORAGE_LIMIT_MB) || 1024, dbMb: Number(env.DB_LIMIT_MB) || 500 },
  // Supabase Storage for customers' photos (see core/storage.js). Without it photos are kept in the database.
  storage: { url: env.SUPABASE_URL || '', key: env.SUPABASE_ANON_KEY || '', bucket: env.STORAGE_BUCKET || '', purgeSecret: env.STORAGE_PURGE_SECRET || '' },
  // Google service account (JSON) that books calls on the owner's calendar. See core/calendar.js.
  googleServiceAccount: (() => { try { return env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) : null; } catch { return null; } })(),
  serverless: !!(env.VERCEL || env.SERVERLESS),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${num(env.PORT, 3000)}`).replace(/\/$/, ''),
  adminPassword: env.ADMIN_PASSWORD || 'demo',
  intakeSecret: env.INTAKE_SECRET || 'change-me',
  demoMode: String(env.DEMO_MODE || 'true') !== 'false',
  // 'concierge': on Instagram the assistant reads the whole chat and decides for itself (reply, stay quiet, hand over) instead of following the qualification script.
  agentMode: env.AGENT_MODE === 'concierge' ? 'concierge' : 'script',
  // 1: the concierge writes its reply but does NOT send it; the draft is kept on the lead's history for the team to read.
  agentShadow: env.AGENT_SHADOW === '1',
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  // Instagram messaging (Instagram API with Instagram Login). Needs a Professional account.
  instagram: {
    accessToken: env.INSTAGRAM_ACCESS_TOKEN || '',
    appSecret: env.INSTAGRAM_APP_SECRET || '',
    appId: (env.INSTAGRAM_APP_ID || '').trim(),
    verifyToken: env.INSTAGRAM_VERIFY_TOKEN || '',
    handle: (env.INSTAGRAM_HANDLE || '').replace(/^@/, ''),
    apiVersion: env.INSTAGRAM_API_VERSION || 'v23.0',
    // This deployment's own Instagram account id (the "user_id" from /me). When set, webhook events for any other account are ignored.
    accountId: (env.INSTAGRAM_ACCOUNT_ID || '').trim(),
    // Several client accounts can share one Meta app, and Meta delivers all their events to ONE callback URL.
    // This map hands the events of other accounts on to the deployment that owns them: {"<account id>":"https://other-deployment/webhook/instagram"}.
    forward: (() => { try { const m = env.INSTAGRAM_FORWARD ? JSON.parse(env.INSTAGRAM_FORWARD) : {}; return Object.fromEntries(Object.entries(m).filter(([id, u]) => /^\d+$/.test(id) && /^https:\/\//.test(u))); } catch { return {}; } })(),
  },
  // Facebook Messenger for one Page (Messenger Platform). The Page access token does not expire.
  facebook: {
    accessToken: env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
    appSecret: env.FACEBOOK_APP_SECRET || '',
    verifyToken: env.FACEBOOK_VERIFY_TOKEN || '',
    pageId: (env.FACEBOOK_PAGE_ID || '').trim(),
    handle: (env.FACEBOOK_PAGE_HANDLE || '').replace(/^@/, ''),
    apiVersion: env.FACEBOOK_API_VERSION || 'v23.0',
    forward: {},
  },
  // Cloudflare Workers AI (preferred when CF_* are set) via its OpenAI-compatible
  // endpoint; otherwise any OpenAI-compatible provider (defaults to Groq).
  llm: useCloudflare
    ? {
      apiKey: env.CF_API_TOKEN,
      baseUrl: (env.LLM_BASE_URL || `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1`).replace(/\/$/, ''),
      model: env.LLM_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      fallbackModel: env.LLM_FALLBACK_MODEL || '@cf/openai/gpt-oss-120b',
      maxRpm: num(env.LLM_MAX_RPM, 240),
      tpm: num(env.LLM_TPM, 0),
      timeoutMs: num(env.LLM_TIMEOUT_MS, 30000),
    }
    : {
      apiKey: env.LLM_API_KEY || env.GROQ_API_KEY || '',
      baseUrl: (env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
      model: env.LLM_MODEL || 'openai/gpt-oss-120b',
      fallbackModel: env.LLM_FALLBACK_MODEL || 'openai/gpt-oss-20b',
      maxRpm: num(env.LLM_MAX_RPM, 120),
      // Soft tokens-per-minute budget PER MODEL (Groq free tier allows 8000). 0 = unlimited.
      tpm: num(env.LLM_TPM, 6000),
      timeoutMs: num(env.LLM_TIMEOUT_MS, 25000),
    },
};

// Providers in order of preference. The first is the main one; a backup (Groq, via
// GROQ_API_KEY or LLM_FALLBACK_API_KEY) takes over automatically if it runs out of quota.
{
  const L = module.exports.llm;
  // Models that can look at a picture. Mistral Small 3.1 works on any Cloudflare account without a licence click.
  const vision = useCloudflare ? [env.LLM_VISION_MODEL || '@cf/mistralai/mistral-small-3.1-24b-instruct'] : [];
  L.providers = [{ name: useCloudflare ? 'cloudflare' : 'primary', baseUrl: L.baseUrl, apiKey: L.apiKey, models: [L.model, L.fallbackModel].filter(Boolean), visionModels: vision, tpm: L.tpm }];
  // Extra Cloudflare accounts (CF_ACCOUNT_ID_2 / CF_API_TOKEN_2, then _3 ... _8): when one account's
  // daily free allowance is used up, the next one takes over automatically.
  if (useCloudflare) {
    for (let i = 2; i <= 8; i++) {
      const acct = env[`CF_ACCOUNT_ID_${i}`];
      const tok = env[`CF_API_TOKEN_${i}`];
      if (!acct || !tok) continue;
      L.providers.push({ name: `cloudflare-${i}`, baseUrl: `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/v1`, apiKey: tok, models: [L.model, L.fallbackModel].filter(Boolean), visionModels: vision, tpm: L.tpm });
    }
  }
  const backupKey = env.LLM_FALLBACK_API_KEY || (useCloudflare ? env.GROQ_API_KEY : '');
  if (backupKey) {
    L.providers.push({
      name: 'backup', baseUrl: (env.LLM_FALLBACK_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''), apiKey: backupKey,
      models: [env.LLM_FALLBACK_MODEL_NAME || 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'], tpm: num(env.LLM_FALLBACK_TPM, 6000),
    });
  }
}
