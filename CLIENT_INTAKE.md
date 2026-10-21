# Maddie Demo: Glad U Came (Instagram @gladucamepr)

Instagram DM qualification funnel for Glad U Came, a PR and influencer marketing agency in Mumbai.
Copied from `lead-funnel`; no data, secrets or demo video carried over.

## Where each questionnaire answer goes

| Question to client | Goes into | Setting / file |
| --- | --- | --- |
| Pricing: minimum budget, ranges, what not to quote | Hard budget bar plus agent rules | `qualification.min_budget`, `business.pricing_note`, `agent.extra_instructions` |
| Services and projects not taken | Services list and exclusions | `business.services`, `qualification.project_types`, `agent.extra_instructions` |
| Past campaigns, results, names, awards | Facts the agent may cite (and nothing else) | `business.extra_knowledge` |
| Ideal clients and enquiries to avoid | Qualification and disqualification wording | `qualification.*`, `agent.extra_instructions` |
| Tone: 3-4 DM examples, phrases to use or avoid | Voice | `agent.tone`, `agent.extra_instructions`, `agent.emojis`, `agent.polish` |
| FAQs: process, timelines, reporting, contract terms, after first call | Answerable facts | `business.extra_knowledge` |
| Calls: who takes intro calls, availability | Team and booking window | team (`designers` table), `calendar.*`, `business.timezone` |

## Already set up from the existing niche script
`scripts/niche-glad-u-came.js` holds placeholder values (agent name Aria, min budget 300000, 3 brand leads). Every one of
those is a guess and gets replaced once the client's answers arrive. Do not go live on them.

## Go-live checklist (production)
1. New Supabase Postgres project, set `DATABASE_URL`, run `npm run migrate`.
2. New Vercel project for this folder; set env vars from `.env.example` (never commit `.env`).
3. LLM keys: `CF_ACCOUNT_ID` and `CF_API_TOKEN` (or `LLM_API_KEY` and `LLM_BASE_URL`).
4. Instagram: gladucamepr must be a Professional account. Needs a Meta app, token, app secret and verify token. While the app is in
   development mode only accounts with a role on the app can DM it, so go live needs Advanced Access (App Review plus Business
   Verification) or the client adds test users. Start this early; it takes days to weeks.
5. Webhook callback `<PUBLIC_URL>/webhook/instagram`, subscribe to `messages`, `messaging_postbacks`, `messaging_referral`.
6. Strong `ADMIN_PASSWORD`, `INTAKE_SECRET`, `CRON_SECRET`; `DEMO_MODE=false`.
7. Apply client config, run `node scripts/check-instagram.js`, then a test DM from an approved tester.

## Open questions
- Does Maddie (or Glad U Came) own and control the gladucamepr login and a Meta Business account we can attach the app to?
- Is the goal replies to inbound DMs only (supported), or also outbound DMs and posting (not supported by this system)?
