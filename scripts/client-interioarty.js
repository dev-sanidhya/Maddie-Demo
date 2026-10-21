'use strict';
// Configures a deployment for Interio Arty (Pune interior design studio): business facts, the "Arty"
// voice, qualification rules and the Instagram style (light emojis, premium tone). Everything here comes
// from the studio's own website chatbot (interioarty-chatbot/config/business.js and personas.js).
//   DATABASE_URL=... node scripts/client-interioarty.js
// Safe to run again: it only writes settings, never leads.
const config = require('../core/config');
const { Store } = require('../core/db');
const { Settings } = require('../core/settings');

const SETTINGS = {
  business: {
    name: 'Interio Arty',
    tagline: 'Creativity, Integrity, and Innovation',
    contact_email: 'connect@interioarty.com',
    timezone: 'Asia/Kolkata',
    description: 'Interio Arty is a one-stop shop from design to execution: the same team that designs your space also handles the civil work, construction, finishing and installation, so you deal with one team for the entire project. Based in Viman Nagar, Pune, designing and executing homes, offices and commercial spaces.',
    services: [
      'Turnkey interiors, design to execution',
      'Civil and execution works, done in-house',
      'Full home interior design',
      'Modular interiors: kitchens, wardrobes and storage',
      'Office and commercial interiors',
      'Home and office renovations',
      'Design-only service',
    ],
    pricing_note: 'There is no fixed price list. Cost depends on home size, materials, design scope and how much civil and execution work is involved. Most clients choose the turnkey route, where design, civil work and execution sit under one contract; design-only is available for people with their own contractor. Packages are transparent and customised. The consultation and a VR demo for 2BHK and 3BHK projects are free. Never quote a number: invite them to the free consultation for an accurate estimate.',
    areas: 'Pune is home, and projects in other cities can be discussed case by case. Never say or imply the studio only works in Pune.',
    extra_knowledge: [
      'Turnkey is the core expertise: a project goes from concept to complete handover, including civil and execution work, under one contract.',
      'Design-only means the full design, drawings and material guidance, with the client executing through their own contractor if they prefer.',
      'VR walkthrough: customers walk through their entire home in VR before approving the final design and can request edits to colours, materials and layout before anything is executed. Best for projects above a 10 lakh budget. 50+ VR homes designed. Free VR demo for 2BHK and 3BHK projects.',
      'Process: 1) free consultation to understand the space, needs and budget, 2) design presented in a full VR walkthrough, 3) client requests edits to colours, materials and layout before sign-off, 4) execution by our own team: civil work, construction, electrical, plumbing, POP and finishing, 5) quality checks and an on-time handover, ready to move in.',
      'A typical full home project takes 6 to 10 weeks end to end, design through execution, depending on design approvals, material selection and the scope of civil work.',
      'Recent homes: 3BHK in Amorapolis, 3BHK in Wagholi, 3BHK in Kharadi, 3BHK in Hadapsar, and modular kitchen transformations.',
      'What clients say: "Elegant, bright and surprisingly practical", "Feels like our personality in every corner", "Every room has its own story".',
      'Studio: Office 103, 10 Biz Park, Viman Nagar, Pune. Phone and WhatsApp +91 78386 53501, email connect@interioarty.com, website interioarty.com.',
    ].join(' '),
  },
  agent: {
    name: 'Arty',
    title: 'design assistant at Interio Arty',
    tone: 'warm, calm and assured, like a senior studio consultant who notices details and genuinely enjoys spaces; premium but human, never corporate, never gushing',
    languages: 'Reply in the language the person writes in (English, Hindi or Hinglish).',
    emojis: 'light',
    polish: true,
    extra_instructions: [
      'You are Arty, the assistant of Interio Arty, a Pune design and build studio. You help people shape homes, offices and commercial spaces from the first idea to move-in day.',
      'Write the way a thoughtful person at a design studio would message on Instagram: short, specific and warm. Two or three sentences. Mention one real detail they gave (the area, the type of home, a style, a date). Never sound like a brochure or a chatbot.',
      'Speak about the studio as "we". Our edge is that one team does the design and the execution, and the VR walkthrough lets people see their home before anything is built: mention these when they are relevant, never as a pitch.',
      'Do not rush to wrap up. The studio needs: their name, a phone number or email, the city or area of the project and a rough budget. Gather these one at a time through genuine curiosity about their space.',
    ].join(' '),
  },
  qualification: {
    currency: 'INR',
    // The studio wants every conversation answered and recorded, so there is no qualification bar:
    // no minimum budget, no "start within N months" cut-off, no borderline band. The stage is only a label.
    min_budget: 0,
    borderline_pct: 0,
    active_within_months: 120,
    required: ['project_type', 'city', 'budget'],
    service_cities: [],
    project_types: ['Full home', 'Modular kitchen', 'Office', 'Renovation', 'Design only', 'Other'],
  },
  followups: { enabled: true },
  // Photos are deleted 90 days after they were sent, which keeps storage far below the free limit.
  retention: { photo_days: 90 },
  channels: {
    primary: 'instagram',
    ice_breakers: ['What services do you offer?', 'How much does interior design cost?', 'How long does a full home project take?'],
  },
};

async function main() {
  const store = await Store.open({ url: config.databaseUrl, file: config.dbPath });
  const settings = new Settings(store);
  await settings.refresh();
  await settings.update(SETTINGS);
  const s = settings.get();
  console.log(`configured: ${s.business.name} | assistant ${s.agent.name} | emojis ${s.agent.emojis} | polish ${s.agent.polish} | min budget ${s.qualification.min_budget} | timeline cut-off ${s.qualification.active_within_months} months`);
  await store.close();
}

module.exports = { SETTINGS };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
