import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaRewardsRepository } from '../../infrastructure/repositories/prisma-rewards.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { IRewardRedemption, IRewardsAccount, IRewardTriggerEvent } from '../../domain/rewards.types';
import { computeLevelFromXp, evaluateRewardRules } from './rewards-rules';

/**
 * Architecture 1.0 \u00a75/\u00a77: full family economy \u2014 wallet, ledger,
 * badges, Family Store, redemption approval, and automatic Reward
 * Rules. Also implements `IRewardTriggerWriter` (Sprint 25) \u2014 the
 * seam Habit/Faith/Health engines now call automatically instead of
 * this mechanism sitting unused behind a manual-only HTTP endpoint.
 *
 * Future-Engine Contract (Architecture 1.0 \u00a72):
 * - Memory: not used.
 * - Events: writes to the Unified Timeline for badge awards and level-ups.
 * - AI Provider: not used \u2014 no phrasing generated here.
 * - Audit: NOT logged to AuditLog \u2014 coin/XP grants are gameplay data;
 *   RewardsLedgerEntry IS this engine's own append-only audit trail.
 * - Safety Validation: no AI/system-generated free-text copy here.
 */
@Injectable()
export class RewardsEngineService implements IRewardTriggerWriter {
  constructor(
    private readonly repository: PrismaRewardsRepository,
    private readonly childrenService: ChildrenService,
    @Inject(LIFE_TIMELINE_WRITER) private readonly timeline: ILifeTimelineWriter,
  ) {}

  /** IRewardTriggerWriter's public entry point \u2014 identical behavior to
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
   * reward-worthy event happens \u2014 evaluates every active Reward Rule
   * for this family/engine and grants whatever matches. Cross-engine
   * wiring (Habit/Faith/Health calling this) is a separate, later step
   * \u2014 the mechanism exists here, not yet invoked elsewhere this sprint. */
  async processTriggerEvent(childId: string, familyId: string, event: IRewardTriggerEvent): Promise<number> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const rules = await this.repository.listActiveRewardRules(familyId, event.engine);
    const grants = evaluateRewardRules(rules, event);

    // Theoretical N+1 (found in this session's own performance review):
    // each grant does its own sequential DB round trips inside this
    // loop rather than batching. Not fixed — realistically N is 1-3
    // (how many reward rules would plausibly match one trigger event
    // for one family), so batching's complexity (mixed BADGE/XP/COINS
    // grant types each need different follow-up logic) isn't worth it
    // at this N. Revisit if a family configures dozens of overlapping rules.
    for (const grant of grants) {
      if (grant.rewardType === 'BADGE') {
        const badge = await this.repository.findBadgeByKey(grant.amountOrBadgeId);
        if (!badge) continue; // misconfigured rule referencing a deleted badge key — skip, don't crash
        const awarded = await this.repository.awardBadgeIfNotAlready(childId, badge.id);
        if (awarded) {
          await this.repository.applyEarn(childId, 'BADGE', 1, undefined, grant.source);
          await this.timeline.record({
            childId,
            sourceEngine: 'rewards',
            category: 'REWARDS',
            eventType: 'badge_awarded',
            title: `Earned the "${badge.title}" badge`,
          });
        }
      } else {
        const amount = Number(grant.amountOrBadgeId);
        if (!Number.isFinite(amount) || amount <= 0) continue; // malformed rule config — skip, don't crash
        await this.grantAmount(childId, grant.rewardType, amount, grant.source);
      }
    }

    return grants.length;
  }

  private async grantAmount(childId: string, rewardType: 'XP' | 'COINS', amount: number, source: string): Promise<void> {
    const account = await this.repository.getOrCreateAccount(childId);
    let newLevel: number | undefined;

    if (rewardType === 'XP') {
      const newXp = account.xp + amount;
      const computedLevel = computeLevelFromXp(newXp);
      if (computedLevel > account.level) {
        newLevel = computedLevel;
      }
    }

    await this.repository.applyEarn(childId, rewardType, amount, newLevel, source);

    if (newLevel !== undefined) {
      await this.timeline.record({
        childId,
        sourceEngine: 'rewards',
        category: 'REWARDS',
        eventType: 'level_up',
        title: `Reached Level ${newLevel}`,
      });
    }
  }

  async listFamilyStore(familyId: string): Promise<Awaited<ReturnType<PrismaRewardsRepository['listActiveCatalogItems']>>> {
    return this.repository.listActiveCatalogItems(familyId);
  }

  /** Requesting is allowed even if the child is currently short on
   * coins \u2014 a parent may grant bonus coins after seeing the request.
   * The balance check that actually matters happens at approval time. */
  async requestRedemption(childId: string, familyId: string, catalogItemId: string): Promise<IRewardRedemption> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const item = await this.repository.findCatalogItemById(catalogItemId);
    if (!item || item.familyId !== familyId || !item.isActive) {
      throw new NotFoundException('Reward not found in this family\u2019s store');
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
