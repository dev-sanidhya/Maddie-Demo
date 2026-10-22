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


## Regression (2026-10-21)
- 147 unit tests pass. `scripts/regress-glad.js` (real AI, in-memory DB) passes: qualified brand to Active, very low budget not rejected, only approved prices, no coverage/virality promises, no invented metrics, human and existing-client handoff, vision reads a photo and stores it, manual stage moves.
- Fixed: "designer" wording in fallback replies, unapproved "within one working day" promise, Interio Arty branding in /crm (title, logo, banner, WhatsApp text, CSV name).
- Prod checks: /crm studio login opens only the inbox (admin API 401), CRM status columns New/Contacted/Closed move, AI stage badge follows admin stage moves. Test leads deleted.
- Known gaps: "flag for review" (very low budget, free work) is not a separate flag, it shows as Active; admin console and /form still have interior-design wording; photo path tested with real vision locally, not via a live Instagram DM.

## Admin redesign (2026-10-21)
- /admin restyled (soft canvas, white cards, rose accent, light and dark), brand name and initials come from settings, wording is Glad U Came specific (Owner, Team, Intro call, Test leads, Brand and details).
- Mobile: sticky top bar with Add, bottom tab bar, swipeable board columns, tables become cards, full-screen lead drawer, 16px inputs, no horizontal overflow at 390 and 820 wide.
- Today: status pills and clickable tiles. `LOCAL_ONLY=1` forces local SQLite for previews; launch config `maddie-preview` (port 3101) in Agency/.claude/launch.json.
- Not done: /form page and simulator personas still interior-design wording; prod admin not viewed signed in (needs the admin password typed by the owner).

## Cloudflare account pool (2026-10-21)
- The app already fails over: an account that hits its free daily quota (429) is skipped for 30 minutes and the next answers. Pool size cap raised from 5 to 8 (core/config.js).
- Measured cost: about 650 neurons per enquiry (llama 70B), so one free account (10,000 neurons/day) covers about 15 enquiries a day. Photos use extra neurons.
- `scripts/cf-accounts.js status | add [--dry-run] [--no-deploy]` checks the live pool and adds an account to .env and Vercel production, then redeploys.

## Live Instagram test on aperture_sa (2026-10-22)
- Webhook works end to end: DM in, reply out, lead in /crm with stage Active, service, city, budget, timeline, phone and booked call. aperture_sa credentials are in use for the demo (swap to gladucamepr later).
- Fixed after the live test: bare "Tomorrow, Fri 23 Oct, 5:00 PM." call confirmation (prompt now asks for a full sentence), "we can definitely make that happen" style soft promises (prompt rule), and replies to message bursts. The engine now waits DEBOUNCE_MS (default 6000) of quiet and drops a reply if a newer message arrived while it was written, so several messages get ONE reply; prompt also says to ask at most one question and not end every reply with one.
- Not done: Instagram "swipe to reply" threading to a specific message.
