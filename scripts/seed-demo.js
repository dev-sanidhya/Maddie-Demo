'use strict';
// Wipes every lead, message and activity row, then fills the CRM with sample leads that
// show every stage, every "needs you now" state and every field, for demos.
//   node scripts/seed-demo.js --wipe          (needs the flag, because it deletes data)
// Settings, designers and channel tokens are kept. Sample leads carry meta.demo, so they never
// message a real account and the background timers leave them alone until you press
// "Run follow-ups now".
const config = require('../core/config');
const { Store } = require('../core/db');
const { Settings } = require('../core/settings');
const { evaluate, pickDesigner } = require('../core/qualify');

if (!process.argv.includes('--wipe')) {
  console.log('This deletes ALL leads, messages and activity. Re-run with --wipe to confirm.');
  process.exit(1);
}

(async () => {
const store = await Store.open({ url: config.databaseUrl, file: config.dbPath });
const sset = new Settings(store);
await sset.refresh();
const settings = sset.get();
const designers = await store.listDesigners();
const NOW = Date.now();
const MIN = 60000;
const HOUR = 3600000;
const ago = (min) => NOW - min * MIN;
const IST = 5.5 * HOUR;
// A wall-clock time in India, `days` from today
const at = (days, hh, mm = 0) => {
  const d = new Date(NOW + IST);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, hh, mm) - IST;
};
const lakh = (n) => Math.round(n * 100000);
const half = 30 * MIN;
const roundUp30 = (ts) => Math.ceil((ts + IST) / half) * half - IST;
const roundDown30 = (ts) => Math.floor((ts + IST) / half) * half - IST;
const clock = (ts) => { const d = new Date(ts + IST); let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}${m ? ':' + String(m).padStart(2, '0') : ''} ${ap}`; };
const clock2 = (ts) => { const d = new Date(ts + IST); let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };
const dayName = (days) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(NOW + IST + days * 86400000).getUTCDay()];
const rahulAt = roundUp30(ago(-70));
const snehaAt = roundDown30(ago(55));
const harshAt = roundDown30(ago(190));
const designerId = (name) => (designers.find((d) => d.name.startsWith(name)) || {}).id || null;

await store.tx(async (t) => {
  for (const tbl of ['messages', 'events', 'webhook_outbox', 'leads']) await t.run(`DELETE FROM ${tbl}`);
  if (store.kind === 'sqlite') await t.run("DELETE FROM sqlite_sequence WHERE name IN ('messages','events','webhook_outbox','leads')");
});

let n = 0;
// chat: [who, text, minutes ago]; who is c (customer), a (assistant), h (a person from the team)
async function lead(spec) {
  n += 1;
  const { chat = [], events = [], stage, reason, meta = {}, created = 300, ...f } = spec;
  const msgs = chat.map(([who, text, m]) => ({ who, text, t: ago(m) })).sort((a, b) => a.t - b.t);
  const lastIn = [...msgs].reverse().find((m) => m.who === 'c');
  const lastOut = [...msgs].reverse().find((m) => m.who !== 'c');
  const isTg = f.channel === 'telegram';
  const row = {
    channel: 'instagram', source: 'Instagram', campaign: null, ...f,
    chat_id: f.chat_id === null ? null : (f.chat_id || (isTg ? String(7000000000 + n) : `ig:demo${1000 + n}`)),
    tg_username: isTg ? f.tg_username : null,
    meta: { demo: true, turns: msgs.filter((m) => m.who === 'c').length, ...meta },
    last_inbound_at: lastIn ? lastIn.t : null,
    last_outbound_at: lastOut ? lastOut.t : null,
    start_token: f.chat_id === null ? `demo-token-${n}` : null,
  };
  let l = await store.createLead(row);
  // classify with the real rules, unless the spec pins a stage
  const ev = evaluate(l, settings, { hasInbound: msgs.some((m) => m.who === 'c') });
  const finalStage = stage || ev.stage;
  const patch = {
    stage: finalStage, stage_reason: reason || ev.reason, score: spec.score ?? ev.score,
    qualified_at: finalStage === 'active' ? (spec.qualified_at || ago(created > 120 ? 150 : 60)) : null,
    summary: spec.summary || '',
  };
  if (f.designer) patch.designer_id = designerId(f.designer);
  else if (finalStage === 'active') { const d = pickDesigner(designers, l); patch.designer_id = d ? d.id : null; }
  l = await store.updateLead(l.id, patch);
  for (const m of msgs) {
    const out = m.who !== 'c';
    const failed = m.failed === true;
    await store.run(
      'INSERT INTO messages(lead_id,direction,role,text,status,processed,attempts,error,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      l.id, out ? 'out' : 'in', m.who === 'c' ? 'user' : m.who === 'h' ? 'admin' : 'assistant', m.text,
      out ? 'sent' : 'received', 1, 0, null, m.t,
    );
  }
  const created_at = NOW - created * MIN;
  const updated_at = msgs.length ? msgs[msgs.length - 1].t : created_at;
  await store.run('UPDATE leads SET created_at=?, updated_at=? WHERE id=?', created_at, updated_at, l.id);
  const base = [['lead_created', { source: row.source, campaign: row.campaign }, created]];
  if (row.chat_id) base.push(['chat_linked', { via: 'referral', channel: row.channel }, created - 1]);
  if (msgs.some((m) => m.who === 'c')) base.push(['facts_updated', { fields: ['project_type', 'city', 'budget_amount', 'timeline_months'].filter((k) => l[k] != null) }, Math.max(created - 4, 5)]);
  if (finalStage !== 'new') base.push(['stage_changed', { from: 'qualifying', to: finalStage, reason: patch.stage_reason, score: patch.score }, Math.max(created - 6, 4)]);
  if (patch.designer_id) base.push(['designer_assigned', { designer: designers.find((d) => d.id === patch.designer_id).name }, Math.max(created - 6, 4)]);
  for (const [type, data, m] of [...base, ...events.map((e) => [e[0], e[1] || {}, e[2]])]) {
    await store.run('INSERT INTO events(lead_id,type,data,created_at) VALUES(?,?,?,?)', l.id, type, JSON.stringify(data), ago(m));
  }
  return l;
}

/* ============================ ACTIVE ============================ */
await lead({ name: 'Riya Mehta', phone: '+91 98200 11001', email: 'riya@miraskin.example.com', campaign: 'Launch PR enquiry',
  project_type: 'Influencer marketing', scope: 'Launch PR plus influencer seeding for a new vitamin C serum', property: 'Mira Skin, D2C skincare, 1 to 3 years', city: 'Mumbai, Delhi, Bangalore',
  budget_amount: lakh(6.5), budget_text: '5 to 8 lakh', timeline_months: 1, timeline_text: 'within a month', style: 'Clean, science-led, creator-first', contact_pref: 'Evening',
  callback_at: rahulAt, callback_text: `today around ${clock(rahulAt)}`, callback_status: 'scheduled', callback_kind: 'call', designer: 'Ananya', created: 190,
  summary: 'Riya runs Mira Skin, a D2C skincare brand launching a new serum. She wants launch PR and influencer seeding across Mumbai, Delhi and Bangalore, budget 5 to 8 lakh, starting within a month. She has tried about 20 micro-influencers on her own without tracking results.',
  chat: [['c', "Hi! I'm Riya from Mira Skin. We're launching a new serum and need launch PR plus influencer seeding. Budget around 5 to 8 lakh, want to start within a month", 190],
    ['a', 'Hi Riya, so glad you came! A serum launch with PR and creator seeding is right in our sweet spot. Which cities are you launching in?', 189],
    ['c', 'Mumbai, Delhi and Bangalore mainly. Three products so far', 185],
    ['a', 'Perfect, metro beauty is where we do our best work. Have you worked with creators before?', 184],
    ['c', 'Tried about 20 micro-influencers on our own, never tracked results', 181],
    ['a', 'Very common. We build a tracked seeding list so every creator ties back to sales. When can our brand lead call you?', 180],
    ['c', `today around ${clock(rahulAt)} works, 98200 11001`, 176],
    ['a', `Booked: Ananya Rao will call you today at ${clock2(rahulAt)}. I'll remind you an hour before.`, 175]] });
await lead({ name: 'Kabir Shah', phone: '+91 98221 33455', email: 'kabir@urbanweave.example.com', campaign: 'Celebrity gifting',
  project_type: 'Celebrity gifting', scope: 'Celebrity gifting and a winter-drop launch event', property: 'Urban Weave, menswear label, 1 to 3 years', city: 'Mumbai',
  budget_amount: lakh(12), budget_text: '8 to 12 lakh', timeline_months: 1, timeline_text: 'next month', style: 'Premium streetwear', contact_pref: 'Afternoon',
  callback_at: snehaAt, callback_text: `today ${clock(snehaAt)}`, callback_status: 'scheduled', callback_kind: 'call', designer: 'Dev', created: 420,
  events: [['reminder_sent', { n: 1 }, 108]], meta: { fu: { reminded_at: ago(108) } },
  summary: 'Kabir runs the menswear label Urban Weave and wants celebrity gifting plus a launch event for the winter drop in Mumbai, budget about 12 lakh. A call was booked for today.',
  chat: [['c', 'We are a menswear label in Mumbai, want celeb gifting and a launch event for our winter drop', 420],
    ['a', 'Hi Kabir, I am Aria from Glad U Came. Celebrity gifting is a speciality. Budget range and timeline?', 419],
    ['c', 'Around 12 lakh, next month', 415], ['a', 'That works well. When can Dev, our brand lead, call you?', 414],
    ['c', `Today ${clock(snehaAt)}`, 410], ['a', `Booked for today at ${clock2(snehaAt)}.`, 409],
    ['a', `Reminder: Dev will call you at ${clock2(snehaAt)} today.`, 108]] });
await lead({ name: 'Sneha Iyer', phone: '+91 98900 22877', email: 'sneha@orojewels.example.com', source: 'Instagram comment', campaign: 'Festive campaign',
  project_type: 'Influencer marketing', scope: 'Festive jewellery campaign with around 30 creators', property: 'Oro Jewels, fashion jewellery, 3 to 10 years', city: 'Mumbai, Pune',
  budget_amount: lakh(10), budget_text: '10 lakh', timeline_months: 1, timeline_text: 'in 3 weeks', style: 'Festive, traditional with a modern twist', contact_pref: 'Morning',
  callback_at: at(1, 11, 0), callback_text: 'tomorrow 11 am', callback_status: 'scheduled', callback_kind: 'call', designer: 'Ananya', created: 640,
  summary: 'Sneha wants a festive jewellery campaign with about 30 creators in Mumbai and Pune, budget 10 lakh, in three weeks. Call booked tomorrow 11 am.',
  chat: [['c', 'Hi, festive jewellery campaign, want about 30 creators in Mumbai and Pune', 640], ['a', 'Hi Sneha, I am Aria from Glad U Came. Lovely brief. Budget and timing?', 639],
    ['c', '10 lakh, live in 3 weeks', 632], ['a', 'That fits our festive packages. When can Ananya call you?', 631], ['c', 'Tomorrow 11 am works', 620], ['a', 'Booked for tomorrow at 11:00 AM.', 619]] });
await lead({ name: 'Karan Mehta (Brightline Studio)', phone: '+91 98190 55012', email: 'karan@brightline.example.com', campaign: 'Brand launch',
  project_type: 'Brand launch', scope: 'Brand launch event with media coverage and creator attendance', property: 'Brightline Studio, design and tech, under 1 year', city: 'Mumbai',
  budget_amount: lakh(35), budget_text: '35 lakh', timeline_months: 2, timeline_text: 'in 2 months', style: 'Bold and modern', contact_pref: 'Morning',
  callback_at: at(2, 15, 0), callback_text: `${dayName(2)} 3 pm`, callback_status: 'scheduled', callback_kind: 'video', designer: 'Ananya', created: 1500,
  summary: 'Karan is launching Brightline Studio with a media-backed launch event in Mumbai, budget 35 lakh, in two months. Video call booked.',
  chat: [['c', 'We are launching a design studio in Mumbai in 2 months, need a launch event and press', 1500], ['a', 'Hi Karan, I am Aria from Glad U Came. Budget range?', 1499],
    ['c', 'About 35 lakh', 1490], ['a', `Great. Video call with Ananya on ${dayName(2)} at 3 PM?`, 1489], ['c', 'Works', 1480]] });
await lead({ name: 'Neha Patil', email: 'neha@kindearth.example.com', campaign: 'PR enquiry',
  project_type: 'PR and media', scope: 'Digital PR and media coverage for a sustainable home-care range', property: 'Kind Earth, home care, 1 to 3 years', city: 'Pune',
  budget_amount: lakh(4), budget_text: '4 lakh', timeline_months: 1, timeline_text: 'next month', style: 'Eco, honest, minimal',
  callback_text: 'sometime next week, evenings', callback_status: 'requested', callback_kind: 'call', contact_pref: 'Evening', designer: 'Dev', created: 330, qualified_at: ago(300),
  summary: 'Neha wants digital PR for Kind Earth next month, budget about 4 lakh. She would like a call next week evenings but no time or phone shared yet.',
  chat: [['c', 'Need PR coverage for our eco home-care brand', 330], ['a', 'Hi Neha, I am Aria from Glad U Came. Budget and timing?', 329], ['c', '4 lakh, next month. Call me next week evenings maybe', 321], ['a', 'Sure! Which evening, and what number should Dev call?', 320]] });
await lead({ name: 'Aditya Rao', channel: 'telegram', tg_username: 'aditya_rao', source: 'Telegram', campaign: 'Creator seeding',
  project_type: 'Influencer marketing', scope: 'Creator seeding for a protein snack launch', property: 'FitFuel, food and nutrition, under 1 year', city: 'Bangalore',
  budget_amount: lakh(5), budget_text: '5 lakh', timeline_months: 2, timeline_text: 'in about 2 months', created: 260, qualified_at: ago(190),
  summary: 'Aditya (on Telegram) wants creator seeding for FitFuel in Bangalore, 5 lakh, in two months. No phone or call time yet.',
  chat: [['c', 'hi, creator seeding for our protein snack, bangalore', 260], ['a', 'Hi Aditya, I am Aria from Glad U Came. Budget and timing?', 259], ['c', '5 lakh, in a couple of months', 255], ['a', 'Can I get a phone number so a brand lead can plan it with you?', 254]] });
await lead({ name: 'Siddharth Nair', phone: '+91 98230 77123', email: 'sid@brewco.example.com', campaign: 'Launch PR',
  project_type: 'Brand launch', scope: 'Cafe chain launch: PR and an influencer tasting event', property: 'Brew and Co, cafe chain, 1 to 3 years', city: 'Pune',
  budget_amount: lakh(9), budget_text: '9 lakh', timeline_months: 1, timeline_text: 'next month', contact_pref: 'Morning',
  callback_at: at(1, 10, 0), callback_text: 'tomorrow 10 am', callback_status: 'scheduled', callback_kind: 'call', designer: 'Ishaan', created: 2100,
  meta: { fu: { manual_needed_at: ago(110), manual_reason: 'Their Instagram 24-hour messaging window has closed, so the assistant can no longer message them. Call or message them about the booked call.' } },
  events: [['manual_followup_needed', { reason: 'Instagram 24-hour window closed before the reminder' }, 110]],
  summary: 'Siddharth is launching new Brew and Co outlets in Pune with an influencer tasting event, 9 lakh. Call booked tomorrow 10 am, but his Instagram window closed so a person must confirm.',
  chat: [['c', 'Opening 2 new cafes in Pune, want an influencer tasting event and PR', 2100], ['a', 'Hi Siddharth, Aria from Glad U Came here. Budget and timing?', 2099], ['c', '9 lakh, next month', 2095], ['a', 'When can Ishaan call you?', 2094], ['c', 'Tomorrow 10 am', 1880], ['a', 'Booked for tomorrow at 10:00 AM. Which number?', 1879]] });
await lead({ name: 'Farhan Ali', phone: '+91 98340 44881', source: 'Referral', campaign: 'Past client referral',
  project_type: 'Influencer marketing', scope: 'Always-on influencer program', property: 'Loom Home, home decor', city: 'Mumbai',
  stage: 'active', reason: 'Moved manually: referred by a past client, skip qualification', stage_locked: 1, score: 70,
  callback_at: at(1, 12, 0), callback_text: `${dayName(1)} noon`, callback_status: 'scheduled', callback_kind: 'video', designer: 'Ananya', created: 900,
  summary: 'Referred by a past client. Budget not discussed, so the owner moved him to Active by hand. Intro call booked.',
  chat: [['c', 'Hi, Mrs Kapoor referred me, she loved your work on her launch', 900], ['a', 'Hi Farhan, lovely to hear that! Tell me about your brand.', 899], ['h', 'Hi Farhan, Ananya here. Happy to talk. Does tomorrow noon work?', 880], ['c', 'Perfect', 872]] });
await lead({ name: 'Harsh Vora', phone: '+91 98500 66210', email: 'harsh@vistafit.example.com', campaign: 'Creator seeding',
  project_type: 'Influencer marketing', scope: 'Performance creators for a fitness app', property: 'VistaFit, fitness app, 1 to 3 years', city: 'Bangalore',
  budget_amount: lakh(16), budget_text: '16 lakh', timeline_months: 2, timeline_text: 'in 2 months', style: 'Energetic',
  callback_at: harshAt, callback_text: `today ${clock(harshAt)}`, callback_status: 'done', callback_kind: 'call', designer: 'Ishaan', created: 1700,
  notes: 'Proposal to be sent tomorrow: 40 micro-creators, 8 week campaign, tracked promo codes.',
  meta: { fu: { done_at: ago(150), human_done_at: ago(150), manual_done_at: ago(150) } },
  summary: 'Harsh wants performance creators for the VistaFit app in Bangalore, 16 lakh. The call is done and a proposal will follow.',
  chat: [['c', 'Need performance creators for our fitness app', 1700], ['a', 'Hi Harsh, Aria from Glad U Came. Budget and timeline?', 1699], ['c', '16 lakh, in 2 months', 1695], ['a', 'When can Ishaan call you?', 1694], ['c', 'Today works, 98500 66210', 1690]] });

/* ====================== NEEDS A PERSON ====================== */
await lead({ name: 'Priyanka Sethi', email: 'priyanka@example.com', campaign: 'Launch PR enquiry', project_type: 'PR and media', city: 'Mumbai', budget_amount: lakh(12), budget_text: '12 lakh',
  meta: { flags: { wants_human: true } }, ai_paused: 1, created: 75,
  summary: 'Priyanka wants PR for her label (about 12 lakh) but has specific questions about contracts and exclusivity and asked for a person.',
  chat: [['c', 'Hi, PR for our fashion label in Mumbai, around 12 lakh', 75], ['a', 'Hi Priyanka, Aria from Glad U Came. When are you hoping to start?', 74], ['c', 'Before that, can I speak to someone? I have questions about contracts and exclusivity', 22]] });
await lead({ name: 'Rohan Iyer', phone: '+91 98220 90909', email: 'rohan@example.com', campaign: 'Celebrity gifting', project_type: 'Celebrity gifting', scope: 'Celebrity gifting for a watch launch', property: 'Tempo Watches, accessories', city: 'Delhi',
  budget_amount: lakh(18), budget_text: '18 lakh', timeline_months: 2, timeline_text: 'in 2 months', ai_paused: 1, designer: 'Dev', created: 700,
  summary: 'Rohan is planning celebrity gifting for a watch launch (18 lakh). The team took over; he has just asked whether reporting is included.',
  events: [['ai_paused', { by: 'admin' }, 180], ['message_while_paused', {}, 12]],
  chat: [['c', 'Celebrity gifting for our watch launch in Delhi, 18 lakh, in 2 months', 700], ['a', 'Great brief. Let me bring in a brand lead.', 699], ['h', 'Hi Rohan, Dev here. Could you share your hero product and audience?', 190], ['c', 'Sending tomorrow', 185], ['c', 'Also is post-campaign reporting included?', 12]] });

/* ============== IN CONVERSATION / NEW / TROUBLE ============== */
await lead({ name: 'Meghna Kapoor', campaign: 'PR enquiry', project_type: 'PR and media', city: 'Delhi', created: 50, meta: { fu: { ai_failed_at: ago(18) } },
  events: [['llm_error', { step: 'reply', error: 'Assistant service timed out' }, 18]],
  summary: 'Meghna wants PR in Delhi. Her last message could not be answered because the AI service had a problem.',
  chat: [['c', 'Hello, want PR coverage for my beauty brand in Delhi', 50], ['a', 'Hi Meghna, Aria from Glad U Came. Which products are you promoting?', 49], ['c', 'Skincare range. What would it cost approximately?', 18]] });
await lead({ name: 'Kunal Shah', campaign: 'Creator seeding', project_type: 'Influencer marketing', city: 'Pune', created: 12, summary: 'Kunal wants creators for a snack brand in Pune. Budget and timeline still to find out.',
  chat: [['c', 'Hi, how does influencer seeding work for a snack brand?', 12], ['a', 'Hi Kunal, Aria from Glad U Came. We build a vetted creator list and track every post. Budget in mind?', 11], ['c', 'Maybe 3-4 lakh?', 6], ['a', 'That works for a first campaign. When would you like to go live?', 3]] });
await lead({ name: 'Ishita Verma', phone: '+91 98600 12345', email: 'ishita@example.com', source: 'Google Form', campaign: 'Launch PR enquiry',
  project_type: 'Influencer marketing', city: 'Mumbai', budget_amount: lakh(10), budget_text: '5 to 10 lakh', timeline_months: 1, timeline_text: 'within a month', property: 'Beauty or wellness',
  chat_id: null, created: 8, contact_pref: 'Afternoon', stage: 'new', reason: 'Waiting for them to open the chat',
  meta: { form: { name: 'Ishita Verma', scope: ['Influencer marketing'], city: 'Mumbai', budget: '5 to 10 lakh', timeline: 'Within a month' } }, summary: '', chat: [] });

/* =========================== NURTURE =========================== */
await lead({ name: 'Tanvi Gokhale', phone: '+91 98760 31313', email: 'tanvi@example.com', campaign: 'Brand launch', project_type: 'Brand launch', scope: 'Launch campaign for a new skincare line', property: 'Glow Lab, skincare, pre-launch', city: 'Mumbai',
  budget_amount: lakh(8), budget_text: '8 lakh', timeline_months: 8, timeline_text: 'around June, after product development', created: 2800, meta: { drips_sent: 1 }, events: [['drip_sent', { n: 1 }, 600]],
  summary: 'Tanvi has a good budget (8 lakh) but her product will only be ready around June, so she is being nurtured.',
  chat: [['c', 'Planning launch PR for our skincare line, ready by June', 2800], ['a', 'Hi Tanvi, Aria from Glad U Came. Budget range?', 2799], ['c', 'About 8 lakh', 2795], ['a', "Lovely. Since launch is in June, I'll check in closer to the time.", 2794], ['a', 'Hi Tanvi, a quick tip: creator seeding works best 6 to 8 weeks before launch. Want a free strategy call when you are ready?', 600]] });
await lead({ name: 'Manish Agarwal', campaign: 'Creator seeding', project_type: 'Influencer marketing', city: 'Pune', created: 3000, meta: { flags: { stalled: true }, followups_sent: 2 }, events: [['followup_sent', { n: 1 }, 2900], ['followup_sent', { n: 2 }, 1500]],
  summary: 'Manish asked about influencer marketing in Pune but went quiet before sharing a budget. Two follow-ups sent, now parked.',
  chat: [['c', 'influencer marketing price?', 3000], ['a', 'Hi Manish, Aria from Glad U Came. Pricing depends on creator tier and cities. Which city, and what budget range?', 2999], ['c', 'Pune', 2990], ['a', 'Great, and roughly what budget?', 2989], ['a', 'Hi Manish, still want a quote?', 2900], ['a', 'No pressure. Reply anytime for a free strategy call.', 1500]] });

/* ======================== NOT A FIT ======================== */
await lead({ name: 'Pooja Menon', campaign: 'Creator seeding', project_type: 'Influencer marketing', property: 'Local boutique', city: 'Pune', budget_amount: 80000, budget_text: '80 thousand', timeline_months: 1, timeline_text: 'this month', created: 1200,
  summary: 'Pooja wants influencer marketing for a local boutique but her budget of 80k is below the 3 lakh minimum, so she was politely declined.',
  chat: [['c', 'Need influencers for my boutique, budget 80k', 1200], ['a', 'Hi Pooja, Aria from Glad U Came. Thank you for sharing. Our campaigns start above our minimum, so I do not want to waste your time. A smaller one-off collab could be a better start.', 1199], ['c', 'Okay, will think about it', 1190]] });
await lead({ name: 'Imran Sheikh', campaign: 'PR enquiry', city: 'Pune', project_type: 'Other', opted_out: 1, meta: { flags: { not_interested: true, opted_out: true } }, created: 1900, events: [['opted_out', {}, 1890]],
  summary: 'Imran asked to stop receiving messages, so the assistant will never message him again.',
  chat: [['c', 'what do you do?', 1900], ['a', 'Hi Imran, Aria from Glad U Came. We do PR and influencer marketing. What are you looking for?', 1899], ['c', 'not interested, stop messaging me', 1892], ['a', "Understood, I won't message you again. Thanks for your time!", 1891]] });

console.log(`Seeded ${n} sample leads.`);
const byStage = await store.all('SELECT stage, COUNT(*) c FROM leads GROUP BY stage ORDER BY c DESC');
console.log(byStage.map((r) => `${r.stage}: ${r.c}`).join(', '));
await store.close();
})().catch((e) => { console.error(e); process.exit(1); });
