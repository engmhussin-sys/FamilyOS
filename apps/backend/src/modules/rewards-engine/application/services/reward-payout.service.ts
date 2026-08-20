/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  DEFAULT_SCREEN_TIME_GRANT_TTL_HOURS,
  FULFILLABLE_REWARD_TYPES,
  MAX_ACTIVE_BONUS_MINUTES,
  MAX_SCREEN_TIME_GRANT_MINUTES,
  canTransitionFulfilment,
  type FulfilmentStatus,
  type ProgramRewardType,
  type RewardSpec,
} from '../../../../shared/rewards/reward-spec';
import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';

/**
 * WHAT A GRANT ACTUALLY DOES, PER REWARD TYPE.
 *
 * The ledger row is written by the untouched `RewardsEngineService`; this
 * service turns that row into the SIDE EFFECT the reward type promises. Both
 * side effects are keyed on `ledger_entry_id UNIQUE`, so a redelivered
 * `REWARD_GRANTED` cannot mint a second block of screen time or a second
 * physical toy — the constraint is the defence, exactly as it is for the ledger
 * itself (CONTEXT §3 principle 6).
 *
 *   POINTS                  -> nothing further. The ledger row IS the reward
 *                              (`XP`, which `RewardsAccount.xp` already caches).
 *   SCREEN_TIME             -> a bounded, expiring, revocable grant row that
 *                              `ScreenTimeService.getEffectivePolicy` adds to
 *                              the child's daily allowance at read time.
 *   PHYSICAL / DIGITAL /
 *   PRIVILEGE / PARENT_
 *   APPROVAL / CUSTOM       -> a `RewardFulfilment` in the parent's queue.
 */
@Injectable()
export class RewardPayoutService {
  private readonly logger = new Logger(RewardPayoutService.name);

  constructor(
    private readonly repo: PrismaRewardProgramRepository,
    private readonly children: ChildrenService,
  ) {}

  /**
   * Materialises the side effect for ONE ledger entry.
   * Returns what it did, so the caller can log it and a test can assert it.
   */
  async payOut(
    achievement: any,
    program: any,
    ledgerEntry: { id: string; rewardType: string; amount: number },
    now = new Date(),
  ): Promise<{ kind: 'NONE' | 'SCREEN_TIME' | 'FULFILMENT'; id?: string; minutes?: number }> {
    const spec = (program.rewardSpec ?? {}) as RewardSpec;
    const productType = spec.type as ProgramRewardType;

    if (ledgerEntry.rewardType === 'SCREEN_TIME') {
      return this.grantScreenTime(achievement, spec, ledgerEntry, now);
    }

    if (FULFILLABLE_REWARD_TYPES.has(productType) && ledgerEntry.rewardType === productType) {
      return this.openFulfilment(achievement, spec, ledgerEntry);
    }

    // XP / COINS / BADGE — the ledger row is the whole reward.
    return { kind: 'NONE' };
  }

  /**
   * THE CEILING IS ENFORCED HERE, NOT ONLY AT AUTHORING TIME.
   *
   * `validateRewardSpec` caps a single grant at authoring time, but a child can
   * hold several grants at once from several programs. The sum of ACTIVE
   * minutes is therefore checked again at grant time and the new grant is
   * CLAMPED to what remains. Clamped, not rejected: refusing the reward a child
   * earned because of an accounting ceiling is exactly the punitive UX
   * principle 7 forbids, and a clamped grant is still a real one.
   */
  private async grantScreenTime(
    achievement: any,
    spec: RewardSpec,
    ledgerEntry: { id: string; amount: number },
    now: Date,
  ): Promise<{ kind: 'SCREEN_TIME' | 'NONE'; id?: string; minutes?: number }> {
    const active = await this.repo.activeBonusMinutes(achievement.childId, now);
    const headroom = Math.max(0, MAX_ACTIVE_BONUS_MINUTES - active);
    const requested = Math.min(ledgerEntry.amount, MAX_SCREEN_TIME_GRANT_MINUTES);
    const minutes = Math.min(requested, headroom);

    if (minutes <= 0) {
      this.logger.log(
        `screen_time.no_headroom child=${achievement.childId.slice(0, 8)} active=${active}min — ledger row stands, no new minutes.`,
      );
      return { kind: 'NONE' };
    }

    const ttlHours = spec.expiresInHours ?? DEFAULT_SCREEN_TIME_GRANT_TTL_HOURS;
    const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);

    try {
      const row = await this.repo.createScreenTimeGrant({
        childId: achievement.childId,
        achievementId: achievement.id,
        ledgerEntryId: ledgerEntry.id,
        minutes,
        grantedAt: now,
        expiresAt,
      });
      return { kind: 'SCREEN_TIME', id: row.id, minutes };
    } catch (err) {
      // `ledger_entry_id UNIQUE` — a redelivery. Not an error: the minutes
      // already exist and must not be granted twice.
      if ((err as { code?: string }).code === 'P2002') return { kind: 'NONE' };
      throw err;
    }
  }

  private async openFulfilment(
    achievement: any,
    spec: RewardSpec,
    ledgerEntry: { id: string; rewardType: string; amount: number },
  ): Promise<{ kind: 'FULFILMENT' | 'NONE'; id?: string }> {
    try {
      const row = await this.repo.createFulfilment({
        childId: achievement.childId,
        achievementId: achievement.id,
        ledgerEntryId: ledgerEntry.id,
        rewardType: ledgerEntry.rewardType,
        description: spec.description ?? 'مكافأة يسلّمها ولي الأمر',
        quantity: Math.max(1, ledgerEntry.amount),
        status: 'PENDING',
      });
      return { kind: 'FULFILMENT', id: row.id };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { kind: 'NONE' };
      throw err;
    }
  }

  // --- parent-facing fulfilment operations ---------------------------------

  listFulfilments(status?: string): Promise<any[]> {
    return this.repo.listFulfilments(status ? { status } : {});
  }

  /**
   * The state machine, moved by a CONDITIONAL update: the expected current
   * status is part of the WHERE clause, so two concurrent approvals cannot both
   * win. `count === 0` is "someone else moved it first", reported as a 400
   * rather than a silent success.
   */
  async transition(
    fulfilmentId: string,
    to: FulfilmentStatus,
    userId: string,
    note?: string,
    now = new Date(),
  ): Promise<any> {
    const current = await this.repo.findFulfilment(fulfilmentId);
    if (!current) {
      throw new NotFoundException({ code: 'FULFILMENT_NOT_FOUND', messageAr: 'المكافأة غير موجودة.' });
    }

    const from = current.status as FulfilmentStatus;
    if (!canTransitionFulfilment(from, to)) {
      throw new BadRequestException({
        code: 'FULFILMENT_TRANSITION_INVALID',
        messageAr: `لا يمكن نقل المكافأة من ${from} إلى ${to}.`,
      });
    }

    const data: Record<string, unknown> = { decidedByUserId: userId, note: note ?? current.note };
    if (to === 'APPROVED' || to === 'DECLINED') data.decidedAt = now;
    if (to === 'FULFILLED') data.fulfilledAt = now;

    const moved = await this.repo.transitionFulfilment(fulfilmentId, from, to, data);
    if (moved === 0) {
      throw new BadRequestException({
        code: 'FULFILMENT_ALREADY_MOVED',
        messageAr: 'تم تحديث حالة هذه المكافأة بالفعل.',
      });
    }
    return this.repo.findFulfilment(fulfilmentId);
  }

  /**
   * The ownership assertion is NOT redundant with the tenant extension. The
   * extension scopes the GRANT rows, so another family's grants are invisible —
   * but an unscoped read of a foreign `childId` would answer `200 []`, and a
   * 200 on another family's resource is a cross-tenant answer even when the
   * body is empty. `assertChildBelongsToFamily` turns it into the 404 the F2
   * probe requires (404, never 403: a 403 confirms the child exists elsewhere).
   */
  async listScreenTimeGrants(childId: string, familyId: string): Promise<any[]> {
    await this.children.assertChildBelongsToFamily(childId, familyId);
    return this.repo.listScreenTimeGrants({ childId });
  }

  /** A parent can take back bonus minutes. Revoking is a first-class operation
   * rather than a delete, so the grant stays visible as history. */
  async revokeScreenTimeGrant(grantId: string, userId: string, reason?: string): Promise<any> {
    const grant = await this.repo.findScreenTimeGrant(grantId);
    if (!grant) {
      throw new NotFoundException({ code: 'GRANT_NOT_FOUND', messageAr: 'المنحة غير موجودة.' });
    }
    if (grant.revokedAt) return grant;
    return this.repo.updateScreenTimeGrant(grantId, {
      revokedAt: new Date(),
      revokedByUserId: userId,
      revokeReason: reason ?? null,
    });
  }
}
