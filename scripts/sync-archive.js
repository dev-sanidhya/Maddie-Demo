'use strict';
// Copies EVERY Instagram conversation on the account into the database (table ig_archive), team messages included,
// so the assistant can read a person's whole history, and the team's own way of talking, before it writes anything.
// Resumable: conversations that have not changed since the last run are skipped.
//   node scripts/sync-archive.js            sync everything
//   node scripts/sync-archive.js --max=300  stop after 300 conversations (a quick trial)
const config = require('../core/config');
const { Store } = require('../core/db');
const { chatKey } = require('../core/chatkey');
const G = `https://graph.instagram.com/${config.instagram.apiVersion}`;
const H = { Authorization: `Bearer ${config.instagram.accessToken}` };
const max = Number((process.argv.find((a) => a.startsWith('--max=')) || '').slice(6)) || Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: H });
      const data = await res.json().catch(() => ({}));
      if (res.ok && !data.error) return data;
      const code = data.error && data.error.code;
      if ([4, 17, 32, 613].includes(code) || res.status === 429 || res.status >= 500) { await sleep(4000 * (i + 1)); continue; }
      throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
    } catch (e) { if (i === tries - 1) throw e; await sleep(1500 * (i + 1)); }
  }
  throw new Error('Instagram kept rate limiting this request');
}

(async () => {
  const store = await Store.open({ url: config.databaseUrl, file: config.dbPath });
  const me = await get(`${G}/me?fields=user_id,username,id`);
  const ours = new Set([me.user_id, me.id].filter(Boolean).map(String));
  for (const r of await store.all('SELECT conv_id, igsid FROM ig_archive WHERE chat_key IS NULL AND igsid IS NOT NULL')) await store.run('UPDATE ig_archive SET chat_key=? WHERE conv_id=?', chatKey(me.user_id, r.igsid), r.conv_id);
  const have = new Map((await store.archiveMeta()).map((r) => [r.conv_id, Number(r.last_at)]));
  console.log(`account @${me.username}; ${have.size} conversations already archived`);

  const convs = [];
  let url = `${G}/me/conversations?platform=instagram&limit=50&fields=id,updated_time,participants`;
  while (url && convs.length < max) {
    // Instagram rate-limits long listings. Wait and retry the SAME page instead of giving up, so the list reaches the very end.
    let page = null;
    for (let tries = 1; tries <= 10 && !page; tries++) {
      try { page = await get(url); } catch (e) {
        if (tries === 10) console.log(`listing stopped at ${convs.length}: ${e.message}`);
        else { console.log(`rate limited at ${convs.length}, waiting 60s (${tries}/10)`); await sleep(60000); }
      }
    }
    if (!page) break;
    for (const c of page.data || []) {
      const cust = ((c.participants && c.participants.data) || []).find((p) => !ours.has(String(p.id)));
      convs.push({ id: c.id, last_at: Date.parse(c.updated_time) || 0, igsid: cust && String(cust.id), username: cust && cust.username });
    }
    url = page.paging && page.paging.next;
    if (convs.length % 500 < 50) console.log(`listed ${convs.length}`);
  }
  const todo = convs.slice(0, max).filter((c) => have.get(c.id) !== c.last_at);
  console.log(`${convs.length} conversations listed, ${todo.length} to fetch`);

  let done = 0, failed = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const c = todo[i++];
      try {
        const d = await get(`${G}/${c.id}?fields=${encodeURIComponent('messages.limit(100){id,created_time,from,message,attachments}')}`);
        const msgs = ((d.messages && d.messages.data) || []).map((m) => {
          const from = m.from || {};
          const hasMedia = m.attachments && ((m.attachments.data && m.attachments.data.length) || (Array.isArray(m.attachments) && m.attachments.length));
          return { mid: m.id, at: Date.parse(m.created_time) || 0, fromUs: ours.has(String(from.id)), text: String(m.message || '').trim() || (hasMedia ? '[sent a photo or link]' : '') };
        }).filter((m) => m.text).sort((a, b) => a.at - b.at);
        await store.archiveUpsert({ conv_id: c.id, chat_key: c.igsid ? chatKey(me.user_id, c.igsid) : null, igsid: c.igsid, username: c.username, last_at: c.last_at, msgs });
        done++;
      } catch (e) { failed++; console.log(`  failed ${c.username}: ${e.message}`); }
      if ((done + failed) % 100 === 0) console.log(`fetched ${done + failed}/${todo.length} (${failed} failed)`);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  console.log(`DONE: ${done} stored, ${failed} failed`);
  await store.close();
})().catch((e) => { console.error(e); process.exit(1); });
