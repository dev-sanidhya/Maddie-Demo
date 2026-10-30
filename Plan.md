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

## Session 2026-10-30
- Switched production to gladucamepr: INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_HANDLE=gladucamepr and CRM_PASSWORD updated on Vercel Production (and local .env, gitignored). Redeployed with the Vercel CLI; /api/health ok and /api/crm-login accepts the new password.
- Client guide for the Lead Inbox: client-guide/Glad_U_Came_Lead_Inbox_Guide.docx (built by client-guide/build_guide.py from screenshots of a local sample-data copy). Not committed: it contains the CRM password.
- Known gap: public/crm-assets/crm.css has no toolbar or board styles, so the search/filter row is stacked full width and the Board view renders unstyled below the list. The guide leaves Board out.
- Next: confirm the Instagram webhook still delivers with the new token, then decide whether to fix the CSS.

## Session 2026-10-30 (admin panel)
- Clarified: the client-facing panel is the admin panel (/admin, "Lead Desk"), not the /crm Lead Inbox. ADMIN_PASSWORD set to the client password on Vercel Production and local .env; redeployed; /api/login accepts it. CRM_PASSWORD was set to the same value earlier, so /crm and /admin now share one password.
- Admin guide: client-guide/Glad_U_Came_Admin_Panel_Guide.docx (build_admin_guide.py + aimg/). The earlier Lead Inbox guide is kept but no longer the main one. Neither is committed because they contain the password.

## Session 2026-10-30 (thread history)
- Problem: the assistant replied to creators the team had already been negotiating with (it only saw messages from the first webhook on) and quoted client PR prices to creators. Paused all 9 leads and unsubscribed the Instagram webhook while fixing.
- Fix (core/instagram.js): fetchThread() reads the earlier chat from /me/conversations; importHistory() loads it in order before a new person's first message is stored; handleEcho() records messages the team sends from the Instagram app. TEAM_THREAD_MODE env: 'pause' (default, assistant stays out of chats the team has spoken in, team alerted) or 'assist' (assistant carries on with the history as context).
- Tests added in test/instagram.test.js (169 pass). Deployed to prod; webhook still unsubscribed until Sanidhya says to re-enable (POST /api/instagram/subscribe).
- Ideas not done: one-off history load for the 9 existing leads, creator-aware routing from the history, a CRM badge for team chats.
- Burst handling (core/engine.js): wait until the person has been quiet for DEBOUNCE_MS (6s, up to DEBOUNCE_MAX_MS 25s), skip the AI when a newer message is already waiting (checked before reading facts and before writing the reply), and drop a half-written reply if one lands meanwhile. Last look before every assistant send (instagram.js humanActive): reads the live thread; if the team wrote since, the reply is held back and the chat paused. 172 tests pass; one live smoke (team-started chat stays silent, burst of 6 gets 1 reply).
- Policy change (2026-10-30): earlier team involvement NEVER pauses a chat. History is loaded as context only. The assistant answers every message unless a person on the team has already replied to that message (instagram.js teamReplied(): live thread check before every send, plus a DB check in engine.turn). Held replies are dropped, the chat stays active, the next unanswered message gets an answer. Team-approached people are routed as creator_in_campaign (facts.js teamApproached) so they are not asked client questions or quoted client prices. The 9 chats were reloaded, unpaused, and the Instagram webhook resubscribed (live). To pause everything fast: DELETE graph.instagram.com/me/subscribed_apps with the token.
- Team-led chats (2026-10-30): a chat our team has been part of (meta.team_thread) only ever gets TEAM_ACK: one or two short warm sentences acknowledging what they said, no questions, no numbers/prices (agent.js guard falls back to a fixed safe line), and the lead gets a "Replied in a chat your team is handling" flag (attention.js team_followup) until the team answers. Chats with no team involvement use the normal client flow. Replayed 5 real chats through the real pipeline with sends faked: all gave relevant, safe replies. 175 tests pass.

## Session 2026-10-30 (concierge rebuild, agent PAUSED in prod)
- Problem: the scripted agent kept fumbling real chats (client questions to creators, canned lines, wrong call day). Prod paused: webhook unsubscribed, all leads paused.
- Archive: every Instagram conversation copied into table ig_archive (2,645 chats, 28,815 messages, 19,551 team messages), each addressed by a hash key (core/chatkey.js, sha256 of account+person, 24 hex, PK lookup ~50ms). The agent reads ONE chat only (its own messages rows by lead id); chats are written through to the archive whenever read (instagram.js fetchThread). scripts/sync-archive.js re-syncs (resumable).
- Concierge (core/concierge.js, AGENT_MODE=concierge, Instagram only): one model call reads the whole chat, team messages labelled, today's date, facts + a playbook learned from the team's own messages (scripts/build-playbook.js, scrubbed of money/names/contacts) + style examples, and decides reply / silent / handoff. Runs in parallel with CRM fact extraction. Replies are checked (no invented figures, emails or links; 3 tries; else the chat goes to a person). No scripted nudges/reminders on Instagram in this mode. AGENT_SHADOW=1 keeps drafts on the lead's history (event 'concierge' with draft) and sends nothing.
- Model: GPT-OSS 120B primary, Llama 3.3 70B fallback (LLM_MODEL / LLM_FALLBACK_MODEL set on Vercel Production, applies on next deploy). Test on real chats: GPT-OSS answers new clients better and varies questions; slower (6-23s); it invented an email once (now blocked) and once returned unreadable JSON (now retried).
- Cloudflare pool is 7 accounts (slots 6 and 7 added, in Vercel, live on next deploy).
- NOT deployed: new code, AGENT_MODE, AGENT_SHADOW, INSTAGRAM_ACCOUNT_ID. Plan: deploy with AGENT_MODE=concierge + AGENT_SHADOW=1, resubscribe webhook, read drafts for a day, then flip shadow off.
- Regression (scripts/regress-concierge.js): 12 real chats restarted from the middle, 10 simulated customer messages each (hints force the risky cases: fee counter, call time, burst, bot question, email request, brief again), real pipeline with Instagram faked, auto-audit per reply + AI judge. Run 1: 132 turns, 0 invented contacts/fees, 0 agreed fees, 0 claimed human; found a confirmed call time, long/bulleted replies, and a chat that went dead after "are u a bot?" (asksIfBot only matched "are you"). All fixed (checkReply, facts.js asksIfBot, prompt), 185 tests pass. Re-run of the 4 affected chats: 0 audit flags (one judge fail was a false alarm: the retainer price quoted matches the approved pricing note).
- Prod still paused; nothing of the concierge is deployed. Next: deploy with AGENT_MODE=concierge + AGENT_SHADOW=1 + INSTAGRAM_ACCOUNT_ID, resubscribe webhook, read drafts, then flip shadow off.
- 2026-10-30 evening: the agent now reads each chat through its hash key (concierge.loadChat: archive lookup + live rows, deduped; remember() writes new messages back). Attachment messages go to the concierge in concierge mode (no canned "cannot open attachments"). New guards: no claimed actions ("resent", "emailed", "booked"), no promised outcomes, no verbatim repeat of its last message. scripts/regress-real.js replays real chats (incidents: today's production chats; history: older chats cut at message 11, real customer messages only). Reports in regression-reports/ (gitignored: real customer text).
- BLOCKER: Cloudflare free AI allowance (10,000 neurons per account per day, 7 accounts) was used up by testing; the incident and history replays are mostly void after that (only 6 of 32 incident chats and ~9 of 48 history bursts ran validly). Resets 00:00 UTC. For production consider a paid Workers AI plan or a Groq key as backup (LLM_FALLBACK_API_KEY), and cheaper extraction.
