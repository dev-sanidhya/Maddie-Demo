# Plan: Maddie Demo

## Approach
Reuse the lead-funnel codebase (Node 22, node:sqlite locally, Postgres on Vercel) as a standalone deployment for Glad U Came
(Instagram @gladucamepr). Personalise through settings only (see CLIENT_INTAKE.md), not by forking core code.

## State
- Folder created from lead-funnel: api, core, public, scripts, integrations, test, package/vercel config.
- Excluded on purpose: .env files, databases, logs, demo-video, .vercel link (so nothing points at the old project or account).
- Client answers received. scripts/client-glad-u-came.js written and applied to local SQLite; 147 tests pass.
- Config choices: no auto-reject (min budget 0), required fields project type, city, budget, timeline; approved prices only (PR retainer from Rs 1L/mo, PR project from Rs 60K, GST extra); campaign names and award facts allowed, no invented metrics.
- Team: Maddie plus a Business Development placeholder; real names for BD, accounts, influencer and PR contacts still needed.

## Deployed
- Prod: https://glad-u-came-funnel.vercel.app (Vercel project glad-u-came-funnel, Supabase glad-u-came-funnel, ap-south-1). Migrated, client config applied. /crm, /admin, /privacy.html return 200.
- Old Supabase project aperture-lead-funnel was paused to free a free-plan slot (restore from dashboard if needed).

## Next steps
1. Add gladucamepr as Instagram Tester on the Meta app (manual, blocked for the assistant).
2. Get access token, app ID and app secret for gladucamepr; add to .env and Vercel; redeploy.
3. Webhook callback https://glad-u-came-funnel.vercel.app/webhook/instagram, subscribe messages, messaging_postbacks, messaging_referral; run scripts/check-instagram.js.
4. Replace placeholder team names; rotate leaked keys.

