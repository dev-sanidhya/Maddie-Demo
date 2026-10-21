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

## Next steps
2. Create Supabase and Vercel projects, set env vars, deploy.
3. Meta app and Instagram token for gladucamepr, webhook, run `scripts/check-instagram.js`.
4. Test with an approved tester account, then go live.

