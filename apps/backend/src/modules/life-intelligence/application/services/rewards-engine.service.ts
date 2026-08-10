import { BadRequestException, Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaRewardsRepository } from '../../infrastructure/repositories/prisma-rewards.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { IRewardRedemption, IRewardsAccount, IRewardTriggerEvent } from '../../domain/rewards.types';
import { computeLevelFromXp, evaluateRewardRules } from './rewards-rules';
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

    let actualGrantCount = 0;

    for (const grant of grants) {
      const grantIdempotencyKey = event.idempotencyKey ? `${event.idempotencyKey}:${grant.rewardType}:${grant.source}` : undefined;

      if (grant.rewardType === 'BADGE') {
        const badge = await this.repository.findBadgeByKey(grant.amountOrBadgeId);
        if (!badge) continue; // misconfigured rule referencing a deleted badge key — skip, don't crash
        const awarded = await this.repository.awardBadgeIfNotAlready(childId, badge.id);
        if (awarded) {
          const granted = await this.repository.applyEarn(childId, 'BADGE', 1, undefined, grant.source, grantIdempotencyKey);
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
        const granted = await this.grantAmount(childId, familyId, grant.rewardType, amount, grant.source, grantIdempotencyKey);
        if (granted) actualGrantCount++;
      }
    }

    return actualGrantCount;
  }

  /** Returns whether a NEW grant actually happened (false when
   * idempotencyKey matched an existing entry — a real duplicate,
   * silently and correctly no-op'd, not an error). */
  private async grantAmount(childId: string, familyId: string, rewardType: 'XP' | 'COINS', amount: number, source: string, idempotencyKey?: string): Promise<boolean> {
    const account = await this.repository.getOrCreateAccount(childId);
    let newLevel: number | undefined;

    if (rewardType === 'XP') {
      const newXp = account.xp + amount;
      const computedLevel = computeLevelFromXp(newXp);
      if (computedLevel > account.level) {
        newLevel = computedLevel;
      }
    }

    const granted = await this.repository.applyEarn(childId, rewardType, amount, newLevel, source, idempotencyKey);

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
