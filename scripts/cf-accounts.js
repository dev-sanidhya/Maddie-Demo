'use strict';
// Manage the pool of free Cloudflare Workers AI accounts behind the assistant.
//
// The app already fails over by itself: when an account's free daily allowance runs out (Cloudflare answers 429), that
// account is skipped for 30 minutes and the next one answers. So nothing has to be swapped when one is exhausted; you
// only need enough accounts in the pool. This script checks the pool and adds accounts without touching the others.
//
//   node scripts/cf-accounts.js status                 which accounts are configured and which are cooling right now
//   node scripts/cf-accounts.js add [--dry-run] [--no-deploy]
//        reads CF_NEW_ACCOUNT_ID and CF_NEW_API_TOKEN from the environment (or asks for them), checks the token
//        against Cloudflare, stores it in the next free slot (CF_ACCOUNT_ID_2 .. _8) in .env and in Vercel production,
//        then redeploys so the new account is live.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const MAX_SLOT = 12; // keep in step with core/config.js
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (f) => args.includes(f);

function readEnv() {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* no .env yet */ }
  for (const raw of text.split(/\r?\n/)) {
    const i = raw.indexOf('=');
    if (i > 0 && !raw.trim().startsWith('#')) out[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
  }
  return out;
}

function setEnvLine(key, value) {
  let text = '';
  try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { /* new file */ }
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '\n')}${key}=${value}\n`;
  fs.writeFileSync(ENV_FILE, text);
}

// slot 1 is the plain CF_ACCOUNT_ID / CF_API_TOKEN pair
const slotKeys = (n) => (n === 1 ? ['CF_ACCOUNT_ID', 'CF_API_TOKEN'] : [`CF_ACCOUNT_ID_${n}`, `CF_API_TOKEN_${n}`]);
function slots(env) {
  const list = [];
  for (let n = 1; n <= MAX_SLOT; n++) {
    const [a, t] = slotKeys(n);
    if (env[a] && env[t]) list.push({ n, account: env[a], token: env[t] });
  }
  return list;
}
const mask = (id) => `${id.slice(0, 4)}...${id.slice(-4)}`;

async function verifyToken(account, token) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?per_page=1`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.success) return;
  const why = (body.errors && body.errors[0] && body.errors[0].message) || `HTTP ${res.status}`;
  throw new Error(`Cloudflare rejected this account or token (${why}). The token needs the "Workers AI" permission for that account.`);
}

async function status() {
  const env = readEnv();
  const local = slots(env);
  console.log(`Accounts in .env: ${local.length}  (room for ${MAX_SLOT})`);
  for (const s of local) console.log(`  slot ${s.n}: account ${mask(s.account)}`);
  const base = (env.PUBLIC_URL || '').replace(/\/$/, '');
  if (!base || !env.ADMIN_PASSWORD) { console.log('\nSet PUBLIC_URL and ADMIN_PASSWORD in .env to also see the live pool.'); return; }
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.ADMIN_PASSWORD }) });
  if (!login.ok) throw new Error(`Could not sign in to ${base} (${login.status})`);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const st = await (await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).json();
  console.log(`\nLive on ${base}:`);
  for (const p of (st.llm && st.llm.providers) || []) {
    const until = p.cooling && p.until ? ` until ${new Date(p.until).toLocaleTimeString()}` : '';
    console.log(`  ${p.name.padEnd(14)} ${!p.configured ? 'not configured' : p.cooling ? `cooling down (allowance used or error)${until}` : 'ready'}`);
  }
  console.log('Cooling accounts are skipped and retried automatically; Cloudflare resets free allowances daily at 00:00 UTC.');
}

async function add() {
  const env = readEnv();
  let account = (process.env.CF_NEW_ACCOUNT_ID || '').trim();
  let token = (process.env.CF_NEW_API_TOKEN || '').trim();
  if (!account || !token) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    account = account || (await rl.question('Cloudflare account ID: ')).trim();
    token = token || (await rl.question('API token (Workers AI permission): ')).trim();
    rl.close();
  }
  if (!/^[0-9a-f]{32}$/i.test(account)) throw new Error('An account ID is 32 hex characters (Cloudflare dashboard, right side of the account home page).');
  if (!token) throw new Error('No token given.');
  const have = slots(env);
  if (have.some((s) => s.account === account)) throw new Error(`Account ${mask(account)} is already in the pool (slot ${have.find((s) => s.account === account).n}). Free allowances are per account, so a second token for the same account adds nothing.`);
  const free = Array.from({ length: MAX_SLOT - 1 }, (_, i) => i + 2).find((n) => !slotKeys(n).every((k) => env[k]));
  if (!free) throw new Error(`The pool is full (${MAX_SLOT} accounts).`);
  await verifyToken(account, token);
  console.log(`Token works for account ${mask(account)}. It will take slot ${free}.`);
  if (flag('--dry-run')) { console.log('Dry run: nothing was changed.'); return; }

  const [ak, tk] = slotKeys(free);
  setEnvLine(ak, account); setEnvLine(tk, token);
  console.log('Saved to .env');
  let scope = [];
  try { scope = ['--scope', JSON.parse(fs.readFileSync(path.join(ROOT, '.vercel', 'project.json'), 'utf8')).orgId]; } catch { /* use the CLI default */ }
  const vercel = (a) => execFileSync('vercel', [...a, ...scope], { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  for (const [k, v] of [[ak, account], [tk, token]]) vercel(['env', 'add', k, 'production', '--value', v, '--yes', '--force']);
  console.log('Saved to Vercel production');
  if (flag('--no-deploy')) { console.log('Not redeployed: run "vercel deploy --prod" for the new account to go live.'); return; }
  const out = vercel(['deploy', '--prod', '--yes']);
  console.log(/Aliased\s+(\S+)/.exec(out) ? `Live: ${/Aliased\s+(\S+)/.exec(out)[1]}` : 'Deployed.');
  console.log(`The pool now has ${have.length + 1} accounts.`);
}

(async () => {
  if (cmd === 'status') return status();
  if (cmd === 'add') return add();
  console.log('Usage: node scripts/cf-accounts.js status | add [--dry-run] [--no-deploy]');
  process.exitCode = cmd ? 1 : 0;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
