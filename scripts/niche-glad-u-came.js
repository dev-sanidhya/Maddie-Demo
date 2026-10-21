'use strict';
// Configures the whole system for Glad U Came (PR and influencer marketing): business facts, assistant
// voice and rules, qualification, team and form choices.   node scripts/niche-glad-u-came.js
const config = require('../core/config');
const { Store } = require('../core/db');
const { Settings } = require('../core/settings');
(async () => {
const store = await Store.open({ url: config.databaseUrl, file: config.dbPath });
const settings = new Settings(store);
await settings.update({
  business: {
    name: 'Glad U Came',
    tagline: 'India\'s PR and influencer marketing agency',
    timezone: 'Asia/Kolkata',
    description: 'A multi-award-winning PR and influencer marketing boutique agency in Mumbai, founded in 2015, working with 1000+ brands from D2C startups to global names in fashion, beauty, lifestyle, food, tech and travel.',
    services: ['Influencer marketing and creator seeding', 'Celebrity gifting and VIP relations', 'Brand launches and offline events', 'Digital PR and media relations', 'Social media and UGC marketing', 'Reputation management and personal branding'],
    pricing_note: 'Packages depend on scope, creator tier, number of cities and duration. Never quote exact prices; offer a free strategy call with a brand lead for an accurate proposal.',
    areas: 'India-wide, with the strongest reach in Mumbai, Delhi, Bangalore and Pune',
    extra_knowledge: 'A typical influencer campaign runs 4 to 8 weeks. We build a vetted creator list, track every post and report reach, engagement and sales impact. Launch PR packages combine media coverage, celebrity gifting and creator seeding. Every brand gets a dedicated brand lead.',
  },
  agent: {
    name: 'Aria',
    title: 'brand growth consultant',
    tone: 'warm, sharp and confident, like a well-connected PR strategist who loves launches and creators; friendly and brisk, never salesy',
    languages: 'Reply in the language the person writes in (English, Hindi or Hinglish).',
    extra_instructions: 'IMPORTANT CONTEXT: you work for Glad U Came, a PR and influencer marketing agency, NOT an interior design firm. Ignore any wording about homes, rooms, BHK, property, kitchens or designers. The enquiry is a brand campaign: the "project type" is the service they need (influencer marketing, PR and media, celebrity gifting, brand launch, social media). The "city" is where they want the campaign to run. The "budget" is the campaign budget in rupees. The person who calls them is a "brand lead" (never say designer). Useful things to learn naturally: their brand and category, whether they have worked with creators before, target cities and audience, launch date. Say "campaign" instead of "project".',
  },
  qualification: {
    min_budget: 300000,
    active_within_months: 3,
    project_types: ['Influencer marketing', 'PR and media', 'Celebrity gifting', 'Brand launch', 'Social media', 'Other'],
  },
  channels: { ice_breakers: ['Plan an influencer campaign', 'Launch my brand with PR', 'Talk about my budget'] },
});
// team: brand leads instead of designers
const team = [
  { name: 'Ananya Rao', title: 'Senior Brand Lead, Beauty and Lifestyle', specialties: 'Influencer marketing, Brand launch', cities: 'Mumbai, Delhi', bio: 'Leads beauty and D2C launches.' },
  { name: 'Dev Malhotra', title: 'Brand Lead, Fashion and Celebrity', specialties: 'Celebrity gifting, PR and media', cities: '', bio: 'Fashion PR and celebrity relations.' },
  { name: 'Ishaan Kulkarni', title: 'Brand Lead, Digital and Social', specialties: 'Social media, Other', cities: 'Bangalore, Pune', bio: 'Social, UGC and performance creators.' },
];
const ds = await store.listDesigners();
for (const [i, t] of team.entries()) await store.saveDesigner({ ...(ds[i] ? { id: ds[i].id } : {}), ...t, min_budget: 0 });
console.log('niche applied:', settings.get().business.name, '|', (await store.listDesigners()).map((d) => d.name).join(', '));
await store.close();
})().catch((e) => { console.error(e); process.exit(1); });
