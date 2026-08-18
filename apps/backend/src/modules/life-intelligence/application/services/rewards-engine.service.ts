import { BadRequestException, Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { GrowthEventEmitter } from '../../../analytics/application/growth-event-emitter.service';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { achievementSummaryArOf } from '../../../../shared/rewards/achievement-summary';
import { composeRewardTimelineKey } from '../../../../shared/events/idempotency';
import { TIMELINE_COPY_AR } from '../../domain/life-timeline-copy';
import { forEntity, forRecurringSignal } from '../../../../shared/notifications/notification-source-key';
import { IGrantCap, PrismaRewardsRepository } from '../../infrastructure/repositories/prisma-rewards.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { IRewardRule, IRewardRedemption, IRewardsAccount, IRewardTriggerEvent, RewardType } from '../../domain/rewards.types';
import { computeLevelFromXp, evaluateRewardRules, selectApplicableRules } from './rewards-rules';
import { SmartNotificationEngineService } from '../../../notification-engine/application/services/smart-notification-engine.service';

/**
 * Architecture 1.0 §5/§7: full family economy — wallet, ledger,
 * badges, Family Store, redemption approval, and automatic Reward
 * Rules. Also implements `IRewardTriggerWriter` (Sprint 25) — the
 * seam Habit/Faith/Health engines now call automatically instead of
 * this mechanism sitting unused behind a manual-only HTTP endpoint.
 *
 * Sprint 16.2 Phase 2 (Reward → Notification) — CLOSES A REAL GAP:
 * reward grants previously never triggered any notification —
 * SmartNotificationIntegrationService is now injected and called,
 * but ONLY after a real, non-duplicate grant (granted === true),
 * reusing Sprint 16.2 Phase 1's own notifyEvent() single-candidate
 * pipeline (zero new notification logic built here). This
 * structurally guarantees: a duplicate/idempotency-rejected grant
 * (granted === false) never reaches the notification call at all —
 * "no notification on a rejected duplicate" isn't a separate check,
 * it's the natural consequence of calling notifyEvent() from inside
 * the SAME `if (granted)` branch the Timeline write already uses.
 *
 * Future-Engine Contract (Architecture 1.0 §2):
 * - Memory: not used.
 * - Events: writes to the Unified Timeline for badge awards and
 *   level-ups; now also (Sprint 16.2) notifies via
 *   SmartNotificationIntegrationService — same fatigue-guarded path
 *   every other notification source uses, not a side channel.
 * - AI Provider: not used — no phrasing generated here.
 * - Audit: NOT logged to AuditLog — coin/XP grants are gameplay data;
 *   RewardsLedgerEntry IS this engine's own append-only audit trail.
 * - Safety Validation: no AI/system-generated free-text copy here.
 */
@Injectable()
export class RewardsEngineService implements IRewardTriggerWriter {
  private readonly logger = new Logger(RewardsEngineService.name);

  constructor(
    private readonly repository: PrismaRewardsRepository,
    private readonly childrenService: ChildrenService,
    @Inject(LIFE_TIMELINE_WRITER) private readonly timeline: ILifeTimelineWriter,
    /**
     * PHASE F (`F6-003`, closing `PF-E-001`) — THE DECISION LAYER, NOT THE
     * DELIVERY PIPELINE.
     *
     * This was `SmartNotificationIntegrationService`, called with four English
     * string literals and a `targetAudience` this file asserted for itself.
     * The pipeline is still the only thing that writes a row — the engine calls
     * it — but the SENTENCE now comes from `COPY_CATALOGUE`, the AUDIENCE comes
     * from the catalogue entry rather than from a positional argument here, and
     * every decision leaves a row in `notification_decisions`.
     */
    private readonly notifications: SmartNotificationEngineService,
    // B4 — the ONE source of "which day is it for this family?" (B1+B2).
    // Daily and weekly rule caps are counted on the family's calendar, so a
    // Cairo child completing a habit at 00:30 is counted against TODAY.
    private readonly familyDate: FamilyDateService,
    /** PHASE D (GROWTH). See `approveRedemption` — a redemption is counted
     * when it is APPROVED, never when it is requested. */
    private readonly growthEvents: GrowthEventEmitter,
  ) {}

  /** IRewardTriggerWriter's public entry point — identical behavior to
   * processTriggerEvent below, kept as a separate named method so the
   * interface's intent (a generic trigger seam) stays readable at
   * call sites, matching LIFE_TIMELINE_WRITER.record()'s own naming
   * choice over a more implementation-specific name. */
  trigger(childId: string, familyId: string, event: IRewardTriggerEvent): Promise<number> {
    return this.processTriggerEvent(childId, familyId, event);
  }

  async getAccount(childId: string, familyId: string): Promise<IRewardsAccount> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.getOrCreateAccount(childId);
  }

  /**
   * B5 (`PHASE-A-Backend §13.2`) — «لا endpoint يقرأ `rewards_ledger_entries`
   * إطلاقًا».
   *
   * `rewards_ledger_entries` is the append-only audit trail of every point,
   * coin, XP and badge this product has ever granted. It has been written
   * since Sprint 13, it carries the `(child_id, idempotency_key)` unique index
   * that F1 built the whole replay defence on, and until B5 NO ROUTE READ IT.
   * A parent could see a balance and could not see where it came from, which
   * makes the balance unarguable in exactly the situation where a parent needs
   * to argue with it.
   *
   * EXTENDING the existing rewards read surface rather than adding a rival:
   * same service, same `assertChildBelongsToFamily` ownership check, same
   * repository. `limit` is bounded here because §13 records «Pagination: صفر»
   * across the whole API — a bounded limit is not pagination and is not
   * presented as it; the cursor work is a stated open gap.
   */
  async getLedger(childId: string, familyId: string, limit = 100): Promise<unknown[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.listLedgerEntries(childId, Math.min(Math.max(limit, 1), 200));
  }

  /**
   * PHASE C (`PC-B-001`) — THE QUESTION `processTriggerEvent`'S RETURN VALUE
   * CANNOT ANSWER, AND WHY `PA-B-009` NEEDED IT.
   *
   * `processTriggerEvent` returns HOW MANY GRANTS THIS ATTEMPT CREATED. That is
   * the right answer for "should I announce something new?" and the WRONG
   * answer for "was this business event ever paid?" — after a retry the two
   * diverge, because the ledger insert is `ON CONFLICT DO NOTHING` and the
   * second attempt therefore returns 0 for a grant that is committed and real.
   *
   * `RewardsCompletionConsumer` used that 0 as "nothing happened" and returned
   * without emitting `REWARD_GRANTED`. So a transient failure between the grant
   * and the announcement became PERMANENT the moment the retry ran, and the
   * relay marked the message PUBLISHED — a silent, unrecoverable loss reported
   * as a success. This method is the durable question, asked of the ledger.
   *
   * IT IS A READ. It grants nothing, it writes nothing, and it cannot: a
   * recovery path that could create a grant would be a second reward engine,
   * which CONTEXT §3 principle 1 forbids and which would itself be the next
   * double-grant bug.
   */
  async countGrantsFor(childId: string, familyId: string, idempotencyKey: string): Promise<number> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.countGrantsForTrigger(childId, idempotencyKey);
  }

  /**
   * THE POINTS, FROM THE LEDGER, so that the announcement can state them.
   *
   * The parent's `REWARD_GRANTED` sentence now names the amount («…وحصل على ٢٠
   * نقطة»), and «the server is authoritative» means that number is read back out
   * of `rewards_ledger_entries` — not taken from `CompletionEvent.pointsHint`
   * (documented as A HINT ONLY), not from `RewardSpec.amount` (an intention the
   * Reward Rules may cap or multiply), and not from a response body.
   *
   * IT IS A READ, for the same reason `countGrantsFor` is: a method on this
   * service that could create a grant while answering a question about grants
   * would be the next double-reward defect. It is therefore also stable across
   * redelivery — the recovery path reads the same twenty points the first
   * delivery did, instead of announcing «0 نقطة» for a reward that exists.
   */
  async pointsGrantedFor(childId: string, familyId: string, idempotencyKey: string): Promise<number> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.sumPointsForTrigger(childId, idempotencyKey);
  }

  /**
   * PHASE C (`PC-B-006`) — THE REPAIR, AND WHY IT CANNOT LIVE IN `announceGrant`.
   *
   * `announceGrant` is only reached when `actualGrantCount > 0`. On a
   * redelivery the grant already exists, `processTriggerEvent` returns 0, and
   * `announceGrant` is never called — so the one place that writes the timeline
   * entry is exactly the place a retry cannot reach. A curated moment lost to a
   * transient failure was therefore lost FOREVER, silently, while the outbox
   * reported success: the identical shape as `PA-B-009`, one table over.
   *
   * This is the idempotent repair `RewardsCompletionConsumer` calls once it has
   * established from the LEDGER that the grant is real. It is a plain keyed
   * write: a no-op when the entry exists (the unique index refuses it and the
   * repository reports the existing row), a repair when it does not.
   *
   * IT IS NOT WRAPPED IN A try/catch HERE, deliberately, and that is the whole
   * point. The consumer runs under the relay, which retries; letting the error
   * propagate is what converts «lost» into «retried». `announceGrant`'s own
   * call still swallows, because the direct HTTP path has no second attempt.
   */
  async ensureGrantTimeline(
    childId: string,
    familyId: string,
    event: IRewardTriggerEvent,
    grantCount: number,
  ): Promise<void> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    await this.recordGrantTimeline(childId, event, grantCount);
  }

  /**
   * The ONE composition of the REWARDS timeline entry, shared by the direct
   * path (`announceGrant`) and the outbox repair (`ensureGrantTimeline`) so the
   * two can never drift into writing different rows for the same moment.
   *
   * `sourceKey` is present only when the trigger carried an idempotency key.
   * Without one there is nothing stable to key on, so the row stays outside the
   * partial unique index and behaves exactly as it did before Phase C — the
   * honest fallback, and the same one B9 chose for notifications rather than
   * synthesising a constant that would suppress every future entry.
   *
   * ---------------------------------------------------------------------------
   * THE TITLE, AND WHY IT WAS THE SECOND DEFECT `e2e-13` PINNED.
   *
   * What was here: `title: 'Earned a reward'` — an English literal, written
   * into `life_timeline_events`, which IS «سجل حياة الطفل» (CONTEXT §1) in a
   * product whose first language is Arabic and whose two markets are EG and SA.
   * It is not a raw enum and it carries no placeholder, so every generic leak
   * check in this repository passed it; it was simply the wrong language, and
   * that is a failure mode a leak check cannot see.
   *
   * TWO CHANGES, NOT ONE. The language, and the CONTENT. «حصل على مكافأة» is
   * Arabic and still answers only WHEN — a timeline of twenty identical rows is
   * a counter, not a life record — so the entry now names what was achieved,
   * from `RewardProgram.targetSummaryAr` («الآيات 1–5 من سورة الملك») carried on
   * the completion's own metadata. NOTHING IS ASSEMBLED HERE: that sentence was
   * derived once by `describeTargetSpec` at program creation precisely so three
   * clients and this writer do not each re-derive it from a surah number.
   *
   * The summary is ABSENT for every completion that is not a parent-authored
   * program — a habit tick, a hydration goal, a streak — and the generic Arabic
   * sentence is the honest answer there rather than an invented one.
   */
  private async recordGrantTimeline(
    childId: string,
    event: IRewardTriggerEvent,
    grantCount: number,
  ): Promise<void> {
    const summaryAr = achievementSummaryArOf(event.payload);
    await this.timeline.record({
      childId,
      sourceEngine: 'rewards',
      category: 'REWARDS',
      eventType: 'reward_granted',
      title: TIMELINE_COPY_AR.rewardGranted(summaryAr),
      metadata: { triggerEngine: event.engine, triggerType: event.type, grantCount },
      sourceKey: event.idempotencyKey ? composeRewardTimelineKey(event.idempotencyKey) : undefined,
    });
  }

  /** The single entry point every other engine calls when a
   * reward-worthy event happens — evaluates every active Reward Rule
   * for this family/engine and grants whatever matches.
   *
   * Sprint 16.1 (Double Reward Protection) — event.idempotencyKey, if
   * provided, is combined with the specific grant (badge/XP/coins)
   * to form a real, unique-per-grant key.
   *
   * Sprint 16.2 Phase 1 (Habit → Notification): this is ALSO the real
   * closure of that gap — HabitEngineService's own STREAK_ACHIEVED/
   * HABIT_COMPLETED triggers flow through here already (built
   * Sprint 16/16.1); wiring the notification call HERE, once, covers
   * every engine's rewards (Habit, Health, Faith alike) without
   * needing separate notification wiring inside each engine
   * individually — a single, correct architectural point, per the
   * brief's own "Reuse First" instruction. */
  async processTriggerEvent(childId: string, familyId: string, event: IRewardTriggerEvent): Promise<number> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const rules = await this.repository.listActiveRewardRules(familyId, event.engine);
    const grants = evaluateRewardRules(rules, event);
    if (grants.length === 0) return 0;

    // B4 — the cap lookup, built ONCE per trigger and only when a rule that
    // actually matched declares a cap. A rule with no caps costs zero extra
    // queries and zero extra locks, which keeps the untouched pre-B4 paths
    // exactly as fast as they were.
    const applicable = selectApplicableRules(rules);
    // THE FAMILY'S TODAY, resolved ONCE per trigger, by the single authority
    // B1+B2 established. It is stamped onto every ledger row this trigger
    // writes (`rewards_ledger_entries.business_date`) and it is what the caps
    // below count against, so the stored day and the counted day are the same
    // value rather than two derivations that could disagree.
    const businessDate = await this.familyDate.getBusinessDate(familyId);
    const caps = this.buildCaps(businessDate, applicable, grants);

    let actualGrantCount = 0;

    for (const grant of grants) {
      const grantIdempotencyKey = event.idempotencyKey ? `${event.idempotencyKey}:${grant.rewardType}:${grant.source}` : undefined;
      const cap = caps.get(grant.source);

      if (grant.rewardType === 'BADGE') {
        const badge = await this.repository.findBadgeByKey(grant.amountOrBadgeId);
        if (!badge) continue; // misconfigured rule referencing a deleted badge key — skip, don't crash
        const awarded = await this.repository.awardBadgeIfNotAlready(childId, badge.id);
        if (awarded) {
          const granted = await this.repository.applyEarn(childId, 'BADGE', 1, undefined, grant.source, grantIdempotencyKey, cap, businessDate);
          if (granted) {
            actualGrantCount++;
            await this.timeline.record({
              childId,
              sourceEngine: 'rewards',
              category: 'REWARDS',
              eventType: 'badge_awarded',
              title: TIMELINE_COPY_AR.badgeAwarded(badge.title),
            });
            // Sprint 16.2 Phase 2 — badges are the most milestone-
            // worthy grant type, so BOTH the child (encouragement)
            // and the parent (visibility into a real achievement)
            // are notified — a deliberate product distinction, not
            // arbitrary duplication. Best-effort: never blocks the
            // grant itself, matching every other side-effect here.
            // B9 — THE ENTITY FORM. `child_badge_awards (child_id, badge_id)`
            // is unique, so this child can earn this badge exactly once, ever.
            // A key built on that pair is therefore permanently stable: replay
            // the trigger tomorrow, next week, or from a redelivered message
            // whose consumption marker was lost, and the composed key is
            // byte-identical and the second notification is refused by the
            // database. The child's row and the parent's row differ only by the
            // `:child` facet the delivery layer appends, so notifying BOTH
            // audiences — a deliberate product decision recorded above — stays
            // possible without weakening anything.
            const badgeKey = forEntity('badge', childId, badge.id);
            // PHASE F (`F6-003`) — ONE CAUSE, ONE KEY, TWO AUDIENCES, and the
            // two types are what makes that legible. `BADGE_EARNED` is the
            // child's entry in `COPY_CATALOGUE` (four tone bands, Arabic first);
            // `BADGE_EARNED_PARENT` is the parent's. They share `badgeKey`
            // because they share a cause, and neither deduplicates the other:
            // the ledger separates them on `target_audience` and the delivery
            // layer separates them with the `:child` facet.
            await this.notifyGrant(childId, familyId, 'BADGE_EARNED', badgeKey, {
              badgeTitle: badge.title,
            });
            await this.notifyGrant(childId, familyId, 'BADGE_EARNED_PARENT', badgeKey, {
              badgeTitle: badge.title,
            });
          }
        }
      } else {
        const amount = Number(grant.amountOrBadgeId);
        if (!Number.isFinite(amount) || amount <= 0) continue; // malformed rule config — skip, don't crash
        const granted = await this.grantAmount(childId, familyId, grant.rewardType, amount, grant.source, grantIdempotencyKey, cap, businessDate);
        if (granted) actualGrantCount++;
      }
    }

    if (actualGrantCount > 0) {
      await this.announceGrant(childId, familyId, event, actualGrantCount);
    }

    return actualGrantCount;
  }

  /**
   * B4 — ONE BUSINESS EVENT -> ONE REWARD -> ONE TIMELINE ENTRY -> ONE
   * NOTIFICATION, closed HERE, once, for every domain.
   *
   * WHAT WAS MISSING, on each of the two paths:
   *
   *   THE OUTBOX PATH had the notification (`NotificationRewardConsumer`) and
   *   NO TIMELINE ENTRY. `/events/batch` never runs a domain service, so none
   *   of the `timeline.record` calls in `habit-engine.service.ts` and its
   *   siblings is reached; a habit completed through the pipeline earned XP
   *   that appeared nowhere on the family's timeline.
   *
   *   THE DIRECT PATH had domain timeline entries and NO NOTIFICATION. It never
   *   writes an outbox message, so `REWARD_GRANTED` is never emitted and
   *   `NotificationRewardConsumer` never runs — on exactly the routes the Child
   *   App actually calls today (PA-M-034). This is the 🔴 Phase A recorded
   *   against the Notification stage of six chains.
   *
   * Both are closed by writing the REWARDS-category entry here, and by
   * notifying here only when nothing else will. `announcedViaOutbox` is the
   * switch and exactly one caller sets it.
   *
   * ONE ENTRY, NOT ONE PER GRANT: a completion matching an XP rule and a COINS
   * rule is ONE thing that happened to the child, and the timeline is "curated
   * moments" (Architecture 1.0 §5.11), not a ledger — the ledger is already the
   * per-grant record and it is the audit trail.
   *
   * BEST-EFFORT, like every other side effect in this file: a timeline or
   * notification failure must never unwind a reward the database has committed.
   */
  private async announceGrant(
    childId: string,
    familyId: string,
    event: IRewardTriggerEvent,
    grantCount: number,
  ): Promise<void> {
    try {
      await this.recordGrantTimeline(childId, event, grantCount);
    } catch (err) {
      // STILL SWALLOWED, and PC-B-006 does not change that: a timeline failure
      // must never unwind a grant PostgreSQL has already committed, and on the
      // DIRECT `/self/*` path there is nothing to retry with — the HTTP request
      // is the only attempt there will ever be.
      //
      // What PC-B-006 changed is the OUTBOX path, where a retry does exist:
      // `RewardsCompletionConsumer` now repairs this entry on redelivery and
      // does NOT swallow the failure, so a lost curated moment heals instead of
      // disappearing. The write is keyed, so the repair cannot duplicate it.
      this.logger.warn('Failed to write the reward timeline entry', err instanceof Error ? err.message : err);
    }

    if (event.announcedViaOutbox) return;

    // PHASE F (`F6-003`) — THE SAME ENGINE `NotificationRewardConsumer` NOW
    // CALLS, so the two paths that announce a grant cannot drift into two
    // different sentences. What was here was a copy of the consumer's two
    // literals, kept in sync by a comment saying they were the same; they are
    // now the same because there is one `COPY_CATALOGUE.REWARD_GRANTED` entry
    // and both paths render it. Below the engine nothing changed: the same
    // fatigue guard — cooldown, duplicate window, quiet hours, daily and
    // category caps — as every other notification.
    // B9 — THE DIRECT PATH's key, and the one place where the composition has
    // to fall back. `event.idempotencyKey` is the same value that protects the
    // ledger row this notification is announcing (`rewards_ledger_entries
    // (child_id, idempotency_key)`), so when it is present the notification is
    // exactly as replay-proof as the grant it describes — which is the
    // strongest statement available on a path that writes no domain event.
    //
    // WHEN IT IS ABSENT, and this is stated rather than hidden: PA-B-013's
    // keyless legacy triggers still exist, and a key composed from nothing
    // would be a constant that suppressed every future grant notification for
    // that child forever. The bucketed form is the honest fallback — it
    // guarantees «not twice within five minutes» at the database level and no
    // more. `rewards_ledger_entries` remains the exactly-once authority for
    // the grant itself; this is the notification about it.
    const sourceEventId = event.idempotencyKey
      ? forEntity('reward', childId, event.idempotencyKey)
      : forRecurringSignal('reward', childId, `${event.engine}:${event.type}`, new Date());

    /**
     * ======================================================================
     * SPRINT F1 (DECISION 1) — THE CAUSE, AND THE CHILD WHO WAS NEVER TOLD.
     * ======================================================================
     *
     * WHAT WAS MEASURED. This method made ONE call, to `REWARD_GRANTED`, with
     * no `cause` and no CHILD branch. `NotificationRewardConsumer` — the OTHER
     * announcer, the one on the outbox path — has made TWO calls since
     * `F6-006` and has carried the cause since `F1-002`. So the product's
     * answer to «a child earned a reward» depended on which door the completion
     * came through: through `/events/batch` the child heard about it, through
     * the `/self/*` routes the Child App actually calls (PA-M-034) they heard
     * nothing at all. That asymmetry is the defect. A child who earns a reward
     * is told, on every path.
     *
     * IT CANNOT DOUBLE-NOTIFY, AND THE REASON IS THE LINE ABOVE THIS BLOCK:
     * `if (event.announcedViaOutbox) return`. `RewardsCompletionConsumer` is
     * the ONLY caller that sets that flag and it sets it on EVERY call, so the
     * outbox path never reaches this code and this code is never reached by
     * anything the outbox path announces. One completion still produces one
     * parent notification and one child message; which of the two announcers
     * produced them is the only thing that varies.
     *
     * AND IT IS THE SAME `sourceEventId` FOR BOTH AUDIENCES, exactly as the
     * consumer does: the cause is one, and `forAudience` /
     * `forChildAudience` keep the two rows apart at every table that stores
     * them — `notifications (family_id, source_event_id, user_id)` under the
     * bare key, `child_messages (family_id, source_event_id)` and
     * `notification_deliveries (family_id, source_event_id)` under the
     * `:child` facet, `notification_decisions (family_id, source_event_id,
     * target_audience)` on its own audience column. Neither deduplicates the
     * other, and neither can be written twice.
     *
     * `cause` IS `event.type` — the ENGINE-INTERNAL trigger name
     * (`LEARNING_GOAL_ACHIEVED`, `EDUCATION_TASK_COMPLETED`,
     * `FAITH_PRACTICE_COMPLETED`, `HABIT_COMPLETED`…). It is read by exactly
     * one thing, `COPY_RULES` in `RuleBasedNotificationDecisionProvider`, and
     * recorded on `notification_decisions.copy_key`. `notifications.type` does
     * not move: the scorer, the quiet-hours matrix and the analytics read
     * `type`, and renaming it to fix a sentence would move a reporting axis.
     */
    const cause = event.type.trim().length > 0 ? event.type.trim() : null;

    await this.notifyGrant(childId, familyId, 'REWARD_GRANTED', sourceEventId, {}, cause);

    /**
     * THE CHILD'S OWN FACT, AND THE ONE GATE ON IT.
     *
     * `LearningGoal.title` is what `LEARNING_GOAL_ACHIEVED` needs and it is the
     * only reason that key had no producer: the sentence «أنهيت هدف {goalTitle}
     * بالكامل 🎉» is true of a learning goal that was just marked COMPLETED and
     * of nothing else on this path. `LearningEngineService.completeGoal` puts
     * the title on the trigger payload; every other trigger leaves it absent,
     * the rule does not fire, and the child reads the whole, honest
     * `REWARD_GRANTED_CHILD` sentence instead of a half-filled template.
     *
     * PINNED TO THE CAUSE as well as to the field, for the same reason the
     * consumer pins `goalTitle` to `ACHIEVEMENT_VERIFIED`: a title attached to
     * a habit tick would make the sentence say something the event does not.
     */
    const childGoalTitle = cause === 'LEARNING_GOAL_ACHIEVED' ? readableTitleOf(event.payload.goalTitle) : null;

    await this.notifyGrant(
      childId,
      familyId,
      'REWARD_GRANTED_CHILD',
      sourceEventId,
      childGoalTitle === null ? {} : { goalTitle: childGoalTitle },
      cause,
    );
  }

  /**
   * B4 — `maxPerDay` / `maxPerWeek` windows, ON THE FAMILY'S CALENDAR.
   *
   * The window is a range of CALENDAR DATES, not a range of instants, because
   * that is what `rewards_ledger_entries.business_date` stores. `businessDate`
   * came from `FamilyDateService`, the only reader of `Family.timezone` after
   * B1+B2, and it is the same value stamped on the row — so the cap counts the
   * days the grants actually belong to rather than re-deriving boundaries that
   * could disagree with them.
   *
   * A ROLLING seven-day window, not a fixed Sat..Fri week: the product has no
   * "week start" setting, and inventing one would have been a product decision
   * taken in a repository. Rolling is also the stricter reading of "no more
   * than N per week" and needs no calendar convention to explain.
   */
  private buildCaps(
    businessDate: string,
    rules: IRewardRule[],
    grants: Array<{ source: string }>,
  ): Map<string, IGrantCap> {
    const caps = new Map<string, IGrantCap>();
    const capped = rules.filter(
      (rule) => (rule.maxPerDay != null || rule.maxPerWeek != null) && grants.some((g) => g.source === `reward_rule:${rule.id}`),
    );
    if (capped.length === 0) return caps;

    // `FamilyDateService.addDays` walks the CALENDAR (`YYYY-MM-DD` ->
    // `YYYY-MM-DD`), never `Date` arithmetic. Subtracting 6 * 86,400,000 ms
    // would be off by an hour across a DST transition and therefore off by a
    // DAY at the boundary — the construct B1 removed from the streak
    // calculator for exactly this reason.
    const weekStartDate = FamilyDateService.addDays(businessDate, -6);

    for (const rule of capped) {
      caps.set(`reward_rule:${rule.id}`, {
        maxPerDay: rule.maxPerDay ?? null,
        maxPerWeek: rule.maxPerWeek ?? null,
        businessDate,
        weekStartDate,
      });
    }
    return caps;
  }

  /** Returns whether a NEW grant actually happened (false when
   * idempotencyKey matched an existing entry — a real duplicate,
   * silently and correctly no-op'd, not an error). */
  private async grantAmount(childId: string, familyId: string, rewardType: Exclude<RewardType, 'BADGE'>, amount: number, source: string, idempotencyKey?: string, cap?: IGrantCap, businessDate?: string): Promise<boolean> {
    const account = await this.repository.getOrCreateAccount(childId);
    let newLevel: number | undefined;

    if (rewardType === 'XP') {
      const newXp = account.xp + amount;
      const computedLevel = computeLevelFromXp(newXp);
      if (computedLevel > account.level) {
        newLevel = computedLevel;
      }
    }

    const granted = await this.repository.applyEarn(childId, rewardType, amount, newLevel, source, idempotencyKey, cap, businessDate);

    if (granted && newLevel !== undefined) {
      await this.timeline.record({
        childId,
        sourceEngine: 'rewards',
        category: 'REWARDS',
        eventType: 'level_up',
        title: TIMELINE_COPY_AR.levelUp(newLevel),
      });
      // Sprint 16.2 Phase 2 — a level-up is genuinely notification-
      // worthy on its own, distinct from the routine XP/coin grant
      // that caused it (which does NOT notify — a notification for
      // every single small XP grant would violate the brief's own
      // "not every event" requirement; a level-up is a real
      // milestone, matching this file's own existing Timeline-write
      // threshold for what counts as milestone-worthy).
      // B9 — THE ENTITY FORM again: a child crosses into level 7 once. XP is
      // monotonic and `computeLevelFromXp` is pure, so «reached level N» is a
      // fact with a stable identity even though no event row records it.
      await this.notifyGrant(
        childId,
        familyId,
        'LEVEL_UP',
        forEntity('levelup', childId, String(newLevel)),
        // PHASE F (`F6-003`) — «وصلت للمستوى ٧ 🚀» for a six-year-old and
        // «وصلت إلى المستوى ٧، وهذه نتيجة أسابيع من العمل» for a sixteen-year-old,
        // both rendered from one catalogue key. What was here was `Level 7!`.
        { level: newLevel },
      );
    }

    return granted;
  }

  /** Sprint 16.2 Phases 1-2 — CLOSES A REAL GAP: routes a real,
   * non-duplicate grant event through the fatigue-guarded pipeline.
   * Best-effort — a notification failure must never affect whether
   * the reward itself was granted, matching this file's own
   * established error-handling discipline for every other
   * side-effect (Timeline writes, etc.).
   *
   * PHASE F (`F6-003`) — WHAT THIS METHOD STOPPED TAKING, AND WHY EACH
   * REMOVAL IS THE POINT.
   *
   *   `title` / `body`   Four English literals lived at this file's call sites
   *                      («You earned a badge!», «Level 7!», «You reached Level
   *                      7 — keep it up!») and were written into
   *                      `child_messages` for an Egyptian seven-year-old. They
   *                      are gone: the sentence is rendered from
   *                      `COPY_CATALOGUE` at the child's own tone band, in the
   *                      household's locale, and validated against that child's
   *                      `age-band.ts` safety ceiling before it can be written.
   *   `targetAudience`   Asserted here as a positional argument, which is how
   *                      `BADGE_EARNED` came to mean two different messages to
   *                      two different people under one name. The catalogue
   *                      entry declares the audience now, and the parent's
   *                      badge sentence has its own key
   *                      (`BADGE_EARNED_PARENT`).
   *   `priority`         Was always `'NORMAL'`. It is now derived from the
   *                      scored band, which is the axis it was pretending to be.
   *
   * `sourceEventId` STAYS REQUIRED and stays the caller's. B9's argument is
   * unchanged and the engine explicitly does not compose one: «what makes this
   * notification the same notification» is a decision the call site has to
   * have made.
   */
  private async notifyGrant(
    childId: string,
    familyId: string,
    eventType: string,
    /** B9 — REQUIRED, not optional. Every one of this file's four call sites
     * composes it explicitly above, and making it optional here would have
     * re-opened the exact hole the constraint closes. */
    sourceEventId: string,
    /** The numbers that go INSIDE the sentence — «وسام القارئ», «المستوى ٧».
     * A closed record of primitives, never a free-form payload. */
    variables: Readonly<Record<string, string | number>> = {},
    /**
     * SPRINT F1 (DECISION 1) — THE SPECIFIC DOMAIN CAUSE, when the type is a
     * generic one. Read by `COPY_RULES` and by nothing else; see the block in
     * `announceGrant`. Optional because three of this file's call sites
     * (`BADGE_EARNED`, `BADGE_EARNED_PARENT`, `LEVEL_UP`) name a type that is
     * already as specific as the fact is.
     */
    cause: string | null = null,
  ): Promise<void> {
    try {
      const result = await this.notifications.handleEvent({
        familyId,
        childId,
        eventType,
        cause,
        sourceEventId,
        trigger: 'DOMAIN_EVENT',
        variables,
      });

      /**
       * `PF-E-006`, ASSERTED HERE FOR THE SAME REASON `NotificationRewardConsumer`
       * ASSERTS IT: the audience is NOT something this producer states — it is
       * read from `COPY_CATALOGUE[type].audience` by the decision provider. A
       * child-facing type whose catalogue entry were ever edited to `PARENT`
       * would keep scoring, keep writing decision rows, and write a SECOND
       * PARENT candidate while the child went silent again.
       *
       * IT IS LOGGED RATHER THAN THROWN, and that is the one difference from
       * the consumer. The consumer's whole job is the notification and it has a
       * durable retry (the relay); this method is a best-effort side effect
       * inside an HTTP request that has already committed a reward, and
       * throwing would fail the child's completion to complain about a
       * catalogue row. The mismatch is contained either way — a `PARENT`
       * candidate carrying the bare `sourceEventId` collides with the parent's
       * own row on `notifications (family_id, source_event_id, user_id)` — so
       * the loud line is what is owed, not an exception.
       */
      const expected = CHILD_FACING_GRANT_TYPES.has(eventType) ? 'CHILD' : null;
      const resolved = result?.decision?.targetAudience;
      if (expected !== null && resolved !== undefined && resolved !== expected) {
        this.logger.error(
          `PF-E-006 GUARD: ${eventType} resolved to targetAudience=${resolved}, ` +
            'but this producer exists to reach the CHILD. The audience comes from ' +
            'COPY_CATALOGUE[type].audience — a child-facing type whose catalogue entry says PARENT ' +
            'leaves the child silent again.',
        );
      }
    } catch (err) {
      this.logger.warn(`Failed to notify reward grant (${eventType})`, err instanceof Error ? err.message : err);
    }
  }

  async listFamilyStore(familyId: string): Promise<Awaited<ReturnType<PrismaRewardsRepository['listActiveCatalogItems']>>> {
    return this.repository.listActiveCatalogItems(familyId);
  }

  /** Requesting is allowed even if the child is currently short on
   * coins — a parent may grant bonus coins after seeing the request.
   * The balance check that actually matters happens at approval time. */
  async requestRedemption(childId: string, familyId: string, catalogItemId: string): Promise<IRewardRedemption> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const item = await this.repository.findCatalogItemById(catalogItemId);
    if (!item || item.familyId !== familyId || !item.isActive) {
      throw new NotFoundException('Reward not found in this family’s store');
    }

    return this.repository.createRedemption(childId, catalogItemId);
  }

  /** Atomic: coin deduction and redemption status change happen in
   * one transaction (PrismaRewardsRepository.approveRedemption) so a
   * child's balance and their redemption history can never disagree. */
  async approveRedemption(redemptionId: string, familyId: string, approvingUserId: string): Promise<void> {
    const redemption = await this.repository.findRedemptionById(redemptionId);
    if (!redemption) throw new NotFoundException('Redemption not found');
    if (redemption.status !== 'REQUESTED') {
      throw new BadRequestException(`Redemption is already ${redemption.status}, cannot approve again`);
    }

    await this.childrenService.assertChildBelongsToFamily(redemption.childId, familyId);

    const item = await this.repository.findCatalogItemById(redemption.rewardCatalogItemId);
    if (!item) throw new NotFoundException('The reward this redemption refers to no longer exists');

    const account = await this.repository.getOrCreateAccount(redemption.childId);
    if (account.coins < item.costCoins) {
      throw new BadRequestException('Child does not have enough coins for this reward anymore');
    }

    await this.repository.approveRedemption(redemptionId, redemption.childId, item.costCoins, approvingUserId);

    /**
     * PHASE D (GROWTH). The APPROVAL is the redemption — a REQUESTED row is a
     * child asking, and counting it would report a redemption that may never
     * happen. Emitted after the transaction committed, and carrying a cost and
     * a type but never the child, the item name or the request text.
     */
    await this.growthEvents.emit({
      name: 'REWARD_REDEEMED',
      familyId,
      userId: approvingUserId,
      sessionId: `rewards:${familyId}`,
      payload: { rewardType: 'COINS', amountMinor: item.costCoins },
    });
  }

  async denyRedemption(redemptionId: string, familyId: string, decidingUserId: string): Promise<void> {
    const redemption = await this.repository.findRedemptionById(redemptionId);
    if (!redemption) throw new NotFoundException('Redemption not found');
    await this.childrenService.assertChildBelongsToFamily(redemption.childId, familyId);
    await this.repository.denyRedemption(redemptionId, decidingUserId);
  }
}

/**
 * SPRINT F1 (DECISION 1) — the types this file produces FOR THE CHILD. Named as
 * a set rather than checked inline so that adding a fourth child-facing grant
 * type is a one-line edit that keeps the `PF-E-006` assertion covering it.
 */
const CHILD_FACING_GRANT_TYPES: ReadonlySet<string> = new Set(['REWARD_GRANTED_CHILD', 'BADGE_EARNED', 'LEVEL_UP']);

/** A goal title long enough to be a paragraph is not a title. Mirrors
 * `achievement-summary.ts`'s own bound, for the same reason: this string is
 * rendered into a push notification body. */
const MAX_GOAL_TITLE_CHARS = 120;

/**
 * A parent-written goal title fit to be read back to a child, or `null`.
 *
 * Takes `unknown` because `IRewardTriggerEvent.payload` is
 * `Record<string, unknown>` — on the outbox path it has crossed the wire as
 * JSON, so its shape is a claim rather than a type. An absent or unusable title
 * makes `COPY_RULES` fall through to `REWARD_GRANTED_CHILD`, a whole sentence,
 * rather than to a half-substituted template.
 */
function readableTitleOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  if (title.length === 0 || title.length > MAX_GOAL_TITLE_CHARS) return null;
  return title;
}
