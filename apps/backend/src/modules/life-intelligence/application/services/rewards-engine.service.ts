import { BadRequestException, Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { IGrantCap, PrismaRewardsRepository } from '../../infrastructure/repositories/prisma-rewards.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { IRewardRule, IRewardRedemption, IRewardsAccount, IRewardTriggerEvent, RewardType } from '../../domain/rewards.types';
import { computeLevelFromXp, evaluateRewardRules, selectApplicableRules } from './rewards-rules';
import { SmartNotificationIntegrationService } from './smart-notification-integration.service';

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
    private readonly notificationIntegration: SmartNotificationIntegrationService,
    // B4 — the ONE source of "which day is it for this family?" (B1+B2).
    // Daily and weekly rule caps are counted on the family's calendar, so a
    // Cairo child completing a habit at 00:30 is counted against TODAY.
    private readonly familyDate: FamilyDateService,
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
              title: `Earned the "${badge.title}" badge`,
            });
            // Sprint 16.2 Phase 2 — badges are the most milestone-
            // worthy grant type, so BOTH the child (encouragement)
            // and the parent (visibility into a real achievement)
            // are notified — a deliberate product distinction, not
            // arbitrary duplication. Best-effort: never blocks the
            // grant itself, matching every other side-effect here.
            await this.notifyGrant(childId, familyId, 'CHILD', 'BADGE_EARNED', `You earned a badge!`, `You earned the "${badge.title}" badge — awesome work!`);
            await this.notifyGrant(childId, familyId, 'PARENT', 'BADGE_EARNED', 'New badge earned', `Your child earned the "${badge.title}" badge.`);
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
      await this.timeline.record({
        childId,
        sourceEngine: 'rewards',
        category: 'REWARDS',
        eventType: 'reward_granted',
        title: 'Earned a reward',
        metadata: { triggerEngine: event.engine, triggerType: event.type, grantCount },
      });
    } catch (err) {
      this.logger.warn('Failed to write the reward timeline entry', err instanceof Error ? err.message : err);
    }

    if (event.announcedViaOutbox) return;

    // The SAME Arabic, non-punitive, PII-free copy `NotificationRewardConsumer`
    // sends (CONTEXT §3 principles 7 and 8: the message is a pointer, the app
    // fetches the detail over an authenticated GET). `notifyGrant` is the
    // existing wrapper around `SmartNotificationIntegrationService.notifyEvent`,
    // so this runs the SAME fatigue guard — cooldown, duplicate window, quiet
    // hours, daily and category caps — as every other notification. No new
    // notification logic is built here.
    await this.notifyGrant(
      childId,
      familyId,
      'PARENT',
      'REWARD_GRANTED',
      'مكافأة جديدة',
      'حصل طفلك على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.',
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
        title: `Reached Level ${newLevel}`,
      });
      // Sprint 16.2 Phase 2 — a level-up is genuinely notification-
      // worthy on its own, distinct from the routine XP/coin grant
      // that caused it (which does NOT notify — a notification for
      // every single small XP grant would violate the brief's own
      // "not every event" requirement; a level-up is a real
      // milestone, matching this file's own existing Timeline-write
      // threshold for what counts as milestone-worthy).
      await this.notifyGrant(childId, familyId, 'CHILD', 'LEVEL_UP', `Level ${newLevel}!`, `You reached Level ${newLevel} — keep it up!`);
    }

    return granted;
  }

  /** Sprint 16.2 Phases 1-2 — CLOSES A REAL GAP: routes a real,
   * non-duplicate grant event through
   * SmartNotificationIntegrationService's own fatigue-guarded
   * pipeline (built Sprint 16.1 Phase 3, extended Sprint 16.2 Phase 1
   * with the single-candidate notifyEvent() entry point this calls).
   * Best-effort — a notification failure must never affect whether
   * the reward itself was granted, matching this file's own
   * established error-handling discipline for every other
   * side-effect (Timeline writes, etc.). */
  private async notifyGrant(
    childId: string,
    familyId: string,
    targetAudience: 'PARENT' | 'CHILD',
    type: string,
    title: string,
    body: string,
  ): Promise<void> {
    try {
      await this.notificationIntegration.notifyEvent(childId, familyId, {
        type,
        priority: 'NORMAL',
        title,
        body,
        targetAudience,
      });
    } catch (err) {
      this.logger.warn(`Failed to notify reward grant (${type})`, err instanceof Error ? err.message : err);
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
  }

  async denyRedemption(redemptionId: string, familyId: string, decidingUserId: string): Promise<void> {
    const redemption = await this.repository.findRedemptionById(redemptionId);
    if (!redemption) throw new NotFoundException('Redemption not found');
    await this.childrenService.assertChildBelongsToFamily(redemption.childId, familyId);
    await this.repository.denyRedemption(redemptionId, decidingUserId);
  }
}
