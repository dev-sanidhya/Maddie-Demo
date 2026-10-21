'use strict';
// Background work, run once per tick: retry unsent messages, resume conversations a
// dead instance left half done, execute the follow-ups the planner says are due,
// deliver CRM webhooks. A tick is stateless and safe to run twice at once: every
// send is claimed with a compare-and-swap in the database first.
//
// Who calls tick():
//  - production: /api/cron, hit every minute by the database scheduler (pg_cron)
//    and once a day by Vercel Cron as a backstop
//  - local development: an interval timer started by start()
//  - the admin "Run follow-ups now" button, with force=true to skip the waiting
//    periods so a demo can fast-forward (each press moves a silent lead one step)

const { deliverWebhooks } = require('./crm');
const { windowOpen: windowIsOpen } = require('./attention');
const { plan } = require('./followups');

class Scheduler {
  constructor({ engine, store, settings, instagram, log = console, tickMs = 15000 }) {
    Object.assign(this, { engine, store, settings, instagram, log, tickMs });
    this.timer = null;
    this.busy = false;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.log.error('[scheduler]', e)), this.tickMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }

  // budgetMs caps how long one tick may run (a serverless function has a hard time limit).
  async tick({ force = false, includeSim = false, budgetMs = 45000 } = {}) {
    if (this.busy) return { skipped: true };
    this.busy = true;
    const started = Date.now();
    const result = { followups: 0, drips: 0, stalled: 0, outbox: 0, webhooks: 0, reminders: 0, manual: 0, resumed: 0, due: 0 };
    try {
      await this.settings.refresh({ force: true });
      result.outbox = await this.engine.sweepOutbox();
      // Conversations whose instance died mid-turn: anything unprocessed for 25s that nobody is working on.
      result.resumed = await this.engine.recover({ olderThanMs: force ? 0 : 25000, backfill: false, wait: true });

      const s = this.settings.get();
      const now = Date.now();
      const leads = await this.store.all(
        `SELECT * FROM leads WHERE opted_out=0 AND stage IN ('new','qualifying','active','nurture')${includeSim ? '' : " AND channel!='sim'"} ORDER BY COALESCE(last_outbound_at, created_at) ASC LIMIT 2000`,
      );
      const due = [];
      for (const row of leads) {
        const lead = this.store.hydrate(row);
        const p = plan(lead, s, now, { includeDemo: force });
        if (p && (force || p.at <= now)) due.push({ lead, p });
      }
      due.sort((a, b) => a.p.at - b.p.at);
      result.due = due.length;

      for (const { lead, p } of due) {
        if (Date.now() - started > budgetMs) break; // the rest is picked up by the next tick
        try { await this.execute(lead, p, result, { force }); } catch (e) { this.log.error('[scheduler] follow-up failed for lead', lead.id, e); }
      }

      try { result.photos_removed = await this.purgePhotos(); } catch (e) { this.log.warn('[retention] photo clean-up failed:', e.message); }
      const hook = await deliverWebhooks(this.store, this.settings, { log: this.log });
      result.webhooks = hook.sent;
      if (this.instagram && this.instagram.enabled) await this.instagram.refreshToken().catch(() => {});
    } finally {
      this.busy = false;
    }
    return result;
  }

  // Photo retention: delete photos older than the configured number of days. Looks at most every 6 hours.
  async purgePhotos() {
    const days = this.settings.get().retention.photo_days;
    if (!days) return 0;
    const last = await this.store.kvGet('photo_purge_at', 0);
    if (Date.now() - last < 6 * 3600000) return 0;
    const rows = await this.store.expiredMedia(Date.now() - days * 86400000, 100);
    let removed = 0;
    if (rows.length) removed = await this.engine.removeMedia(rows);
    if (rows.length < 100) await this.store.kvSet('photo_purge_at', Date.now()); // more to do? run again next tick
    return removed;
  }

  claimOf(lead) { return { fu_step: lead.fu_step || 0, last_inbound_at: lead.last_inbound_at || 0 }; }

  // Runs one planned action. Always re-reads the lead and re-plans first, because the
  // customer may have written, or the owner acted, since the list was built.
  async execute(stale, p, result, { force = false } = {}) {
    const { engine, store } = this;
    const lead = await store.getLead(stale.id);
    if (!lead) return;
    const now = Date.now();
    const fresh = plan(lead, this.settings.get(), now, { includeDemo: force });
    if (!fresh || fresh.kind !== p.kind || (!force && fresh.at > now)) return;

    if (p.kind === 'reminder') {
      const won = await store.run('UPDATE leads SET reminded_at=? WHERE id=? AND reminded_at IS NULL', now, lead.id);
      if (!won.changes) return;
      if (lead.chat_id && !lead.ai_paused && windowIsOpen(lead, now)) { await engine.nudge(lead.id, 'reminder'); result.reminders++; return; }
      const why = !lead.chat_id ? 'They have not opened the chat, so the assistant cannot message them.' : lead.ai_paused ? 'The assistant is paused on this chat.' : "Their Instagram 24-hour messaging window has closed, so the assistant can no longer message them.";
      await engine.markManual(lead.id, `${why} Call or message them about the booked call.`);
      result.manual++;
      return;
    }
    if (p.kind === 'chat_nudge') {
      await engine.markManual(lead.id, 'They filled in the enquiry form but have not opened the chat yet. Call or WhatsApp them to get the conversation going.');
      result.manual++;
      return;
    }
    if (p.kind === 'followup') {
      if (await engine.nudge(lead.id, 'followup', { claim: this.claimOf(lead) })) result.followups++;
      return;
    }
    if (p.kind === 'drip') {
      if (await engine.nudge(lead.id, 'drip', { claim: this.claimOf(lead) })) result.drips++;
      return;
    }
    if (p.kind === 'stall') {
      const won = await store.run('UPDATE leads SET fu_step=fu_step+1 WHERE id=? AND fu_step=?', lead.id, lead.fu_step || 0);
      if (!won.changes) return;
      const q = this.settings.get().qualification;
      const valuable = (lead.budget_amount == null || lead.budget_amount >= q.min_budget) && lead.score >= 30;
      if (!windowIsOpen(lead, now) && valuable) {
        await engine.markManual(lead.id, 'They went quiet and the Instagram 24-hour window closed before the assistant could follow up. Message or call them yourself.');
        result.manual++;
      }
      await engine.markStalled(lead.id);
      result.stalled++;
    }
  }
}

module.exports = { Scheduler };
