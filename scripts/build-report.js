'use strict';
// Builds the client report (HTML + CSV) from the dump made by report-data.js.  node scripts/build-report.js data.json outdir
const fs = require('node:fs');
const path = require('node:path');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3];
const LABEL = { brand_lead: 'Brands', invited_creator: 'Creators we invited', creator_pitching: 'Creators who reached out', existing_campaign: 'Existing campaigns', press: 'Press', job_seeker: 'Job seekers', vendor_or_promo: 'Vendors and promos', personal_or_other: 'Other', unfiled: 'Other' };
const ORDER = ['creator_pitching', 'invited_creator', 'brand_lead', 'existing_campaign', 'press', 'job_seeker', 'vendor_or_promo', 'personal_or_other'];
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mask = (s) => String(s || '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\+?\d[\d\s-]{8,}\d/g, '[number]').replace(/\s*[—–]\s*/g, ', ');
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const day = (t) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);

const rows = []; // every sent assistant reply
for (const l of data) {
  const cat = l.category === 'personal_or_other' || !l.category ? 'personal_or_other' : l.category;
  let lastIn = null;
  for (const m of l.msgs) {
    if (m.d === 'in') { lastIn = m; continue; }
    if (m.r === 'assistant' && m.s === 'sent') rows.push({ lead: l, cat, at: m.at, reply: m.t, ask: lastIn && lastIn.at < m.at ? lastIn : null });
  }
}
rows.sort((a, b) => a.at - b.at);
const people = new Set(rows.map((r) => r.lead.id));
const failed = data.reduce((n, l) => n + l.msgs.filter((m) => m.d === 'out' && m.r === 'assistant' && m.s === 'failed').length, 0);
const lat = rows.filter((r) => r.ask).map((r) => (r.at - r.ask.at) / 1000).filter((x) => x >= 0 && x < 3600).sort((a, b) => a - b);
const med = lat[Math.floor(lat.length / 2)];
const wc = rows.map((r) => words(r.reply)).sort((a, b) => a - b);
const medW = wc[Math.floor(wc.length / 2)];
const first = day(rows[0].at), last = day(rows[rows.length - 1].at);
const days = Math.round((Date.parse(last) - Date.parse(first)) / 864e5) + 1;
const hindi = rows.filter((r) => /\b(hai|hain|kya|aap|ji|kar|karo|nahi|bhi|toh|mein|hum|apka|aapka|batao|bataiye)\b/i.test(r.reply)).length;

const byCat = {};
for (const r of rows) { const c = (byCat[r.cat] = byCat[r.cat] || { replies: [], people: new Set() }); c.replies.push(r); c.people.add(r.lead.id); }
const byDay = {}; for (const r of rows) byDay[day(r.at)] = (byDay[day(r.at)] || 0) + 1;
const stageOf = {}; for (const id of people) { const l = data.find((x) => x.id === id); stageOf[l.stage] = (stageOf[l.stage] || 0) + 1; }

// high-reach creators: follower numbers they told us themselves
const reach = [];
const re = /(\d+(?:\.\d+)?)\s*(k|m|lakh|lakhs|million)\b\+?\s*(?:organic |engaged |instagram |ig )*(?:followers|subs|subscribers)|followers\s*:?\s*(\d+(?:\.\d+)?)\s*(k|m|lakh|million)/i;
for (const l of data) {
  if (!people.has(l.id)) continue;
  for (const m of l.msgs) {
    if (m.d !== 'in') continue; const x = re.exec(m.t || ''); if (!x) continue;
    const n = Number(x[1] || x[3]); const u = (x[2] || x[4]).toLowerCase();
    const v = u === 'k' ? n * 1e3 : u === 'm' || u === 'million' ? n * 1e6 : n * 1e5;
    reach.push({ name: l.name, cat: l.category, v, said: `${x[1] || x[3]}${u.toUpperCase().startsWith('K') ? 'K' : u.startsWith('m') ? 'M' : ' lakh'}` });
    break;
  }
}
reach.sort((a, b) => b.v - a.v);
const topReach = reach.filter((r) => r.v >= 100e3 && ['creator_pitching', 'invited_creator'].includes(r.cat));

// sample exchanges
const sample = (cat, n) => {
  const pool = (byCat[cat] ? byCat[cat].replies : []).filter((r) => r.ask && words(r.ask.t) >= 5 && words(r.ask.t) <= 45 && words(r.reply) >= 6 && words(r.reply) <= 32 && !/^\s*\[/.test(r.ask.t));
  const seen = new Set(); const pick = [];
  const step = Math.max(1, Math.floor(pool.length / (n * 2 + 1)));
  for (let i = step; i < pool.length && pick.length < n; i += step) { if (seen.has(pool[i].lead.id)) continue; seen.add(pool[i].lead.id); pick.push(pool[i]); }
  return pick;
};

const maxDay = Math.max(...Object.values(byDay));
const dayKeys = []; for (let t = Date.parse(first); t <= Date.parse(last); t += 864e5) dayKeys.push(new Date(t).toISOString().slice(0, 10));
const dayBars = dayKeys.map((k) => `<div class="b" title="${k}: ${byDay[k] || 0}"><i style="height:${Math.round(((byDay[k] || 0) / maxDay) * 100)}%"></i><span>${(byDay[k] || 0) || ''}</span></div>`).join('');
const total = rows.length;
const catBars = ORDER.filter((c) => byCat[c]).map((c) => { const r = byCat[c].replies.length; return `<div class="row"><div class="lab">${LABEL[c]}</div><div class="bar"><i style="width:${Math.max(1, Math.round((r / byCat[c].replies.length) * 0 + (r / Math.max(...ORDER.filter((x) => byCat[x]).map((x) => byCat[x].replies.length))) * 100))}%"></i></div><div class="num"><b>${r}</b> ${r === 1 ? 'reply' : 'replies'} <small>${byCat[c].people.size} people</small></div></div>`; }).join('');

const ex = (r) => `<div class="ex"><div class="who">${esc(r.lead.name || 'Customer')}</div><div class="in">${esc(mask(r.ask.t))}</div><div class="re"><small>Assistant</small>${esc(mask(r.reply))}</div></div>`;
const sections = ORDER.filter((c) => byCat[c] && ['creator_pitching', 'invited_creator', 'brand_lead', 'existing_campaign'].includes(c)).map((c) => `<section class="pg"><h2>${LABEL[c]}</h2><p class="sub">${byCat[c].people.size} people, ${byCat[c].replies.length} replies sent</p><div class="exs">${sample(c, 4).map(ex).join('')}</div></section>`).join('');

const reachHtml = topReach.length ? `<section class="pg"><h2>High-reach creators</h2><p class="sub">Creators who told us they have 100K+ followers (as stated by them in chat) and were handled by the assistant.</p><table class="t"><tr><th>Name</th><th>Followers (as told to us)</th><th>Type</th></tr>${topReach.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.said}</td><td>${LABEL[r.cat]}</td></tr>`).join('')}</table></section>` : '';

const appendix = ORDER.filter((c) => byCat[c]).map((c) => {
  const by = {}; for (const r of byCat[c].replies) (by[r.lead.id] = by[r.lead.id] || []).push(r);
  return `<h3 class="ah">${LABEL[c]} <small>${byCat[c].people.size} people, ${byCat[c].replies.length} replies</small></h3>` + Object.values(by).map((rs) => `<div class="p"><div class="pn">${esc(rs[0].lead.name || 'Customer')}</div>${rs.map((r) => `<div class="l"><time>${new Date(r.at + 5.5 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')}</time>${esc(mask(r.reply))}</div>`).join('')}</div>`).join('');
}).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Glad U Came Instagram Assistant Report</title><style>
@page{size:A4;margin:14mm}*{box-sizing:border-box}body{margin:0;background:#f4eddc;color:#111;font:15px/1.5 -apple-system,Helvetica,Arial,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:28px}.pg{break-inside:avoid;page-break-inside:avoid;margin:0 0 34px}
.cover{border:3px solid #111;padding:34px;background:#f4eddc;margin-bottom:30px}.tag{display:inline-block;background:#ff5a1f;color:#111;font-weight:800;padding:3px 10px;letter-spacing:.08em;font-size:12px;text-transform:uppercase}
h1{font-size:44px;line-height:1.05;margin:16px 0 8px;letter-spacing:-.02em}h2{font-size:26px;margin:0 0 4px;letter-spacing:-.01em;border-bottom:3px solid #111;padding-bottom:6px}.sub{margin:6px 0 14px;color:#444}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 34px}.k{border:3px solid #111;padding:14px;background:#fff8e8}.k b{display:block;font-size:34px;line-height:1.05}.k span{font-size:13px;color:#444}.k.o{background:#ff5a1f}.k.o span{color:#111}
.row{display:grid;grid-template-columns:200px 1fr 190px;gap:10px;align-items:center;margin:8px 0}.lab{font-weight:700}.bar{background:#e6dcc3;height:22px;border:2px solid #111}.bar i{display:block;height:100%;background:#ff5a1f}.num small{color:#555;margin-left:6px}
.days{display:flex;align-items:flex-end;gap:5px;height:150px;border-bottom:3px solid #111;padding-top:18px}.b{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;position:relative}.b i{display:block;width:100%;background:#111}.b span{font-size:10px;position:absolute;top:-2px;transform:translateY(-100%)}
.dl{display:flex;justify-content:space-between;font-size:12px;color:#444;margin-top:4px}
.exs{display:grid;grid-template-columns:1fr 1fr;gap:12px}.ex{border:2px solid #111;background:#fff8e8;padding:12px;break-inside:avoid}.who{font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}.in{background:#e6dcc3;padding:8px 10px;margin-bottom:6px;font-size:14px}.re{background:#111;color:#f4eddc;padding:8px 10px;font-size:14px}.re small{display:block;color:#ff5a1f;font-weight:800;font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px}
.t{width:100%;border-collapse:collapse}.t th,.t td{border:2px solid #111;padding:8px 10px;text-align:left}.t th{background:#111;color:#f4eddc}
.ah{font-size:20px;margin:26px 0 8px;border-bottom:3px solid #ff5a1f;padding-bottom:4px;break-after:avoid}.ah small{font-weight:400;color:#555;font-size:13px}.p{border-left:3px solid #111;padding:2px 0 2px 10px;margin:8px 0;break-inside:avoid;font-size:13px}.pn{font-weight:800}.l{margin:2px 0}.l time{display:inline-block;width:92px;color:#777;font-variant-numeric:tabular-nums}
.foot{font-size:12px;color:#555;margin-top:10px}.brk{break-before:page}
@media(max-width:700px){.kpis{grid-template-columns:1fr 1fr}.exs{grid-template-columns:1fr}.row{grid-template-columns:1fr}h1{font-size:32px}}
</style></head><body><div class="wrap">
<div class="cover"><span class="tag">Instagram assistant report</span><h1>Glad U Came: what the assistant has handled</h1><div>${first} to ${last} (${days} days). Built by Aperture.</div></div>
<div class="kpis"><div class="k o"><b>${total.toLocaleString('en-IN')}</b><span>replies sent on @gladucamepr</span></div><div class="k"><b>${people.size}</b><span>different people replied to</span></div><div class="k"><b>${Math.round(total / days)}</b><span>replies a day, on average</span></div><div class="k"><b>${med < 90 ? Math.round(med) + ' sec' : Math.round(med / 60) + ' min'}</b><span>typical time to reply</span></div><div class="k"><b>${medW} words</b><span>typical reply length, short like your team</span></div><div class="k"><b>${(total / (total + failed) * 100).toFixed(1)}%</b><span>of replies delivered on the first go</span></div></div>
<section class="pg"><h2>Who it talked to</h2><p class="sub">Every person is filed by the assistant into one group, so the team knows who is who.</p>${catBars}</section>
<section class="pg"><h2>Replies per day</h2><div class="days">${dayBars}</div><div class="dl"><span>${first}</span><span>${last}</span></div></section>
<section class="pg"><h2>Where those people are now</h2><p class="sub">Out of the ${people.size} people the assistant replied to:</p><div class="kpis" style="margin:0">${[['active', 'Active leads'], ['qualifying', 'In conversation'], ['human', 'Needs the team'], ['nurture', 'Warm, later'], ['new', 'New'], ['disqualified', 'Not a fit']].map(([k, n]) => `<div class="k"><b>${stageOf[k] || 0}</b><span>${n}</span></div>`).join('')}</div></section>
<div class="brk"></div>${sections}${reachHtml}
<div class="foot">Names are first names as they appear on Instagram. Phone numbers and emails are hidden in this report. Follower numbers are what creators told us themselves; we have not verified them.</div>
<div class="brk"></div><h2>Every reply, in full</h2><p class="sub">${total.toLocaleString('en-IN')} replies, grouped by who it was sent to. Times are IST.</p>${appendix}
</div></body></html>`;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'GladUCame_Agent_Report.html'), html);
const csv = ['Time (IST),Name,Group,Customer message,Assistant reply'].concat(rows.map((r) => [new Date(r.at + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), r.lead.name, LABEL[r.cat], r.ask ? mask(r.ask.t) : '', mask(r.reply)].map((v) => `"${String(v || '').replace(/"/g, '""').replace(/\s+/g, ' ')}"`).join(','))).join('\n');
fs.writeFileSync(path.join(out, 'GladUCame_All_Replies.csv'), csv);
console.log({ total, people: people.size, failed, days, med, medW, hindi, top: topReach.length, stageOf });
