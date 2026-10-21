'use strict';
// Opens the studio's Lead Inbox on this machine, safely.
//   node scripts/dev-crm.js        then browse http://localhost:3055/crm   (password: dev-crm)
//
// It always uses a scratch database (data/dev-crm.db) filled with Interio Arty's settings and a few sample
// leads, one of them with a photo. It never reads the production database or tokens, and has no Instagram,
// Telegram or storage connection, so nothing here can message a real customer.
const path = require('node:path');
const zlib = require('node:zlib');

process.env.DATABASE_URL = '';
process.env.DB_PATH = path.resolve(__dirname, '..', 'data', 'dev-crm.db');
process.env.PORT = process.env.PORT || '3055';
process.env.ADMIN_PASSWORD = 'dev-crm';
process.env.PUBLIC_URL = `http://localhost:${process.env.PORT}`;
for (const k of ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_ACCOUNT_ID', 'INSTAGRAM_FORWARD', 'TELEGRAM_BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'STORAGE_BUCKET']) process.env[k] = '';

// A small generated picture (a room: wall, window, sofa, wooden floor) so no third-party image is needed.
function samplePhoto(w = 360, h = 230) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      let c = [226 - Math.round(y * 0.1), 214 - Math.round(y * 0.1), 196 - Math.round(y * 0.1)]; // warm wall
      if (y > h * 0.7) c = [150 - ((x >> 4) % 2) * 10, 104 - ((x >> 4) % 2) * 8, 66]; // oak floor boards
      if (x > 215 && x < 330 && y > 28 && y < 130) c = (x > 270 && x < 276) || (y > 76 && y < 82) ? [235, 235, 232] : [176, 208, 232]; // window
      if (x > 40 && x < 190 && y > 118 && y < 178) c = [118, 122, 128]; // sofa
      if (x > 50 && x < 180 && y > 100 && y < 126) c = [136, 140, 146]; // sofa back
      row[1 + x * 3] = c[0]; row[2 + x * 3] = c[1]; row[3 + x * 3] = c[2];
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

async function seed() {
  const { Store } = require('../core/db');
  const { Settings } = require('../core/settings');
  const { SETTINGS } = require('./client-interioarty');
  const store = await Store.open({ file: process.env.DB_PATH });
  const settings = new Settings(store);
  await settings.refresh();
  await settings.update(SETTINGS);
  if ((await store.get('SELECT COUNT(*) c FROM leads')).c > 0) { await store.close(); return; }

  const t = Date.now();
  const min = 60000;
  const say = (lead, rows) => rows.reduce(async (p, [dir, text, ago, extra = {}]) => {
    await p;
    const id = await store.addMessage({ lead_id: lead.id, direction: dir, role: dir === 'in' ? 'user' : 'assistant', text, status: dir === 'in' ? 'received' : 'sent', processed: true });
    await store.run('UPDATE messages SET created_at=? WHERE id=?', t - ago * min, id);
    return extra.photo ? store.addMedia({ lead_id: lead.id, message_id: id, mime: 'image/png', bytes: samplePhoto() }) : undefined;
  }, Promise.resolve());

  const a = await store.createLead({
    channel: 'instagram', chat_id: 'ig:demo-atharva', name: 'Atharva Singh', tg_username: 'atharva.singh', phone: '9990052074', source: 'instagram',
    project_type: 'Full home', scope: 'full home redesign', property: '3BHK', city: 'Chinchwad, Pune', budget_amount: 2500000, budget_text: '25L', stage: 'active',
    stage_reason: 'Qualified: all required details received', score: 80, meta: { turns: 5 }, created_at: t - 50 * min,
  });
  await say(a, [
    ['in', 'Hi', 48], ['out', 'Welcome to Interio Arty, Atharva ✨ I am Arty. What kind of project are you thinking of?', 47],
    ['in', 'I want a full home redesign', 45], ['out', 'A full home redesign is a lovely brief. Which city or area is the home in?', 44],
    ['in', 'Pune in Chinchwad', 40], ['out', 'Chinchwad works well for us. What budget range are you thinking of 🏡', 39],
    ['in', '25L. Full overhaul', 36], ['out', 'Noted, 25 lakh for a full overhaul. What is the best number to reach you on?', 35],
    ['in', '9990052074', 33], ['out', 'Thank you, I have 9990052074. Here is what I would love to see: do you have photos of the rooms as they are today?', 32],
    ['in', '[Photo] A modern living room with a grey sofa, oak flooring and a large window with natural light.', 20, { photo: true }],
    ['out', 'That window is a gift: the light will carry warm wood tones beautifully. Do you want to keep the sofa layout, or reimagine the room? 🛋️', 19],
  ]);
  await store.run('UPDATE leads SET summary=?, last_inbound_at=?, last_outbound_at=?, updated_at=? WHERE id=?', 'Wants a full overhaul of a 3BHK in Chinchwad. Sent a photo of the living room: grey sofa, oak floor, big window. Likes a warm, minimal look.', t - 20 * min, t - 19 * min, t - 19 * min, a.id);

  const w = await store.createLead({
    channel: 'web', chat_id: 'web:demo-neha', name: 'Neha Kulkarni', phone: '9876500011', source: 'Website Chatbot', project_type: 'Modular kitchen', property: '2BHK',
    city: 'Kharadi, Pune', budget_text: '₹8 lakh', budget_amount: 800000, stage: 'active', score: 70, meta: { turns: 3, web_summary: 'Wants a modular kitchen and wardrobes for a 2BHK in Kharadi.' }, created_at: t - 3 * 60 * min,
  });
  await say(w, [['in', 'Hi, I need a modular kitchen for my 2BHK', 180], ['out', 'Lovely. Which area is the flat in?', 179], ['in', 'Kharadi, Pune. Budget about 8 lakh', 176], ['out', 'Thank you, our design team will reach out shortly.', 175]]);
  await store.updateLead(w.id, { summary: 'Wants a modular kitchen and wardrobes for a 2BHK in Kharadi, budget about 8 lakh.', meta: { ...w.meta, crm_status: 'contacted' } });

  const f = await store.createLead({
    channel: 'telegram', name: 'Rohan Deshmukh', phone: '9812345678', source: 'form', project_type: 'Office', city: 'Baner, Pune', budget_text: '₹30 lakh', budget_amount: 3000000,
    stage: 'new', score: 40, meta: { form: {}, turns: 0 }, created_at: t - 26 * 60 * min,
  });
  await store.updateLead(f.id, { summary: 'Enquiry form: a 1,800 sq ft office fit-out in Baner. Has not opened the chat yet.' });
  await store.close();
  console.log('[dev-crm] sample leads created in data/dev-crm.db');
}

seed().then(() => require('../core/index.js')).catch((e) => { console.error(e); process.exit(1); });
