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

## Creator, press and existing-client routing (2026-10-26)
- Extraction now classifies who is writing (brand, creator, press, existing_client). Creator, press and existing-client messages are routed to stage "Needs human" with a reason (influencer team, PR team, account manager) instead of being qualified as brand leads; the person's own words must back the classification so a brand mentioning influencers is not rerouted. Routed people still get short replies (the assistant stays on); someone who asks for a person pauses it as before.
- Replies: creators are told the influencer team handles creator collaborations and are asked once for handle and niche, with no pitching or promises; press get the PR team line and no statements.
- Tests: test/routing.test.js. Team member names for the influencer and PR teams are not set up yet.

## Fixes from the production chats (2026-10-26)
- A plain "Hey there" re-read an old "tomorrow 5 pm" and silently moved a booked call: call times are now only taken from the customer's latest words.
- "Tomorrow anytime" booked 12:00 AM: a day without a time is now a preference and the assistant asks which time suits (no guessing hours).
- Replies that opened by restating what the customer said ("You're looking to...") are trimmed by the validator and forbidden in the prompt; no stacked questions, no call talk unless the task says so.
- "In next 10-15 days" was missed by the model, causing three repeat timeline questions and a "no rush" nurture close: the rule reader now backs up the timeline answer.
- Several reel shares in a row get one acknowledgement.
- Tests: test/chatfixes.test.js.
- Call hours (2026-10-26): intro calls only 10 AM to 6 PM IST. Settings calendar work hours 10 to 18 (applied to prod), the assistant is told to offer and accept times only inside the window, and facts.js refuses to book an exact time outside it (kept as a preference, assistant asks for a time inside the window). Booked calls are persistent: only the customer's latest words can change them (tests in test/chatfixes.test.js).

## Creator flow from the answered questionnaire (2026-10-26)
- New settings field business.creator_notes (admin: Settings, Your business, Creator and influencer rules) holds the approved creator facts and rules; used only in creator chats. Applied to prod by scripts/client-glad-u-came.js.
- Creators are no longer just handed off: a CREATOR directive has a real conversation, answers from the approved notes, and collects handle, followers, niche, city and languages, and interest one question at a time (then wraps up). Details are kept in lead.meta.creator and shown in the CRM as Brand and details (handle, followers, niche, city) and What they want (interest).
- Kinds: creator (influencer team), creator_in_campaign (priority, campaign coordinator: never confirms status, deadlines, approvals or payment), agency_manager (BD team). Press and existing clients unchanged.
- Hard rules from the client: never quote or agree fees, no selection or payment-date promises, no shipping address or sensitive documents in DMs, no follower thresholds, no auto-decline of free collabs, never share other creators or brand details. Light emojis allowed for creators.
- TO CONFIRM with Glad U Came (do not invent): follower tiers, roster open or paused, what each 50% means for creators, gifting schedule and rules, onboarding form or sheet link, campaign tracker access, team names and SLA, retention, real example replies.
- Tests: test/routing.test.js (creator collection, notes in prompt, managers).

## Final review pass as the client (2026-10-26)
- Ran ~25 brand and creator scenarios with the real AI and fixed what a client would notice: soft promises and timeline judgements dropped ("we can definitely", "tight timeline", "good challenge"), discount and invented "discussed earlier" lines dropped, double questions trimmed to one, first messages now answer a question in them, creators' questions on fees, selection and brands are answered before collecting details, "are you a bot?" is answered honestly and no longer hands the chat to a person, bot never says it will call, phone read back instead of "I already have it", Hinglish customers get a Hinglish instruction, campaign timeline wording carries the working-milestone caveat, founder is not auto-assigned (BD team is), context discovery no longer repeats five times.
- Found while fixing: two regexes had been corrupted by a bad edit (word boundaries lost) and are repaired; test/chatfixes.test.js covers them.
- WARNING: the live evaluation used all three Cloudflare free allowances (shared with production), so until 00:00 UTC (5:30 AM IST) the assistant falls back to simple template replies. Creator scenarios and Hinglish replies were NOT re-checked live after the last fixes. Add more Cloudflare accounts with scripts/cf-accounts.js add, and do not run live-AI scripts against the production keys again without checking quota first.
- Cloudflare pool is now 5 accounts (slots 4 and 5 added 2026-10-26, fresh allowance). Creator and Hinglish retest (scripts/retest-creator.js) passed live: creators' fee and selection questions answered first, address declined, free collab explained as brief-dependent, Hinglish replies in Hinglish. Hinglish double questions are now trimmed to one.
