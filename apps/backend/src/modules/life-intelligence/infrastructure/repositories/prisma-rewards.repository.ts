import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import {
  SQL_APPLY_ACCOUNT_DELTAS,
  SQL_BALANCE_FROM_LEDGER,
  SQL_CLAIM_REDEMPTION,
  SQL_DEDUCT_COINS_IF_SUFFICIENT,
  SQL_INSERT_EARN_LEDGER_ENTRY,
  SQL_INSERT_REDEEM_LEDGER_ENTRY,
  SQL_RECONCILE_ACCOUNT_FROM_LEDGER,
} from './rewards.sql';
import {
  IBadgeDefinition,
  IRewardCatalogItem,
  IRewardRedemption,
  IRewardRule,
  IRewardsAccount,
} from '../../domain/rewards.types';

@Injectable()
export class PrismaRewardsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreateAccount(childId: string): Promise<IRewardsAccount> {
    const row = await this.prisma.rewardsAccount.upsert({
      where: { childId },
      create: { childId },
      update: {},
    });
    return { id: row.id, childId: row.childId, xp: row.xp, coins: row.coins, stars: row.stars, level: row.level };
  }

  /** Returns true if a NEW ledger entry was actually created, false
   * if the idempotency key matched an existing entry — a real,
   * previously-processed duplicate, not an error.
   *
   * DA-002 rewrite. The order is the whole point and is deliberate:
   * the LEDGER is written first with `ON CONFLICT DO NOTHING`, and the
   * account balance is only touched when that insert actually created a
   * row. PostgreSQL decides who wins; the application never asks "does
   * this already exist?" (A2 §7.3 proved a read-then-write check lets 8
   * concurrent identical requests through and grants 8 rewards).
   *
   * `idempotencyKey` stays optional in this signature so every existing
   * caller keeps working, but the COLUMN is now NOT NULL: a caller with
   * no natural key gets a synthetic one here. That closes A2 §7.3
   * scenario C, where NULL keys made the unique index vacuous (every
   * NULL is distinct in PostgreSQL) and left keyless paths completely
   * unprotected. */
  async applyEarn(childId: string, rewardType: 'XP' | 'COINS' | 'BADGE', amount: number, newLevel: number | undefined, source: string, idempotencyKey?: string): Promise<boolean> {
    const effectiveKey = idempotencyKey ?? `nokey:${randomUUID()}`;
    // BADGE grants move `stars` by one, matching the original behaviour.
    const delta = rewardType === 'BADGE' ? 1 : amount;

    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$executeRawUnsafe(
        SQL_INSERT_EARN_LEDGER_ENTRY,
        childId,
        rewardType,
        amount,
        delta,
        source,
        effectiveKey,
      );

      if (inserted === 0) {
        // The database rejected a true duplicate. The balance is
        // untouched precisely because we never got here to move it.
        return false;
      }

      await tx.$executeRawUnsafe(
        SQL_APPLY_ACCOUNT_DELTAS,
        childId,
        rewardType === 'XP' ? delta : 0,
        rewardType === 'COINS' ? delta : 0,
        rewardType === 'BADGE' ? delta : 0,
        newLevel ?? null,
      );

      return true;
    });
  }

  /** DP-5 (deterministic recomputation): the balance rebuilt from the
   * ledger alone. Meaningful only because `delta` is signed — A2 §7.4
   * showed `SUM(amount)` returning 600 for an account holding −500. */
  async computeBalanceFromLedger(childId: string): Promise<{ xp: number; coins: number; stars: number }> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ reward_type: string; balance: number }>>(
      SQL_BALANCE_FROM_LEDGER,
      childId,
    );
    const balances = { xp: 0, coins: 0, stars: 0 };
    for (const row of rows) {
      if (row.reward_type === 'XP') balances.xp = Number(row.balance);
      if (row.reward_type === 'COINS') balances.coins = Number(row.balance);
      if (row.reward_type === 'BADGE') balances.stars = Number(row.balance);
    }
    return balances;
  }

  /** Reconciles the cached `RewardsAccount` columns back to the ledger.
   * `RewardsAccount` is a cache of `SUM(delta)`, not an independent
   * source of truth. */
  async reconcileAccountFromLedger(childId: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(SQL_RECONCILE_ACCOUNT_FROM_LEDGER, childId);
  }

  async findBadgeByKey(key: string): Promise<IBadgeDefinition | null> {
    const row = await this.prisma.badgeDefinition.findUnique({ where: { key } });
    if (!row) return null;
    return { id: row.id, key: row.key, title: row.title, description: row.description, criteria: row.criteria as Record<string, unknown>, isGroupAchievement: row.isGroupAchievement };
  }

  async awardBadgeIfNotAlready(childId: string, badgeId: string): Promise<boolean> {
    try {
      await this.prisma.childBadgeAward.create({ data: { childId, badgeId } });
      return true;
    } catch {
      return false;
    }
  }

  async listActiveRewardRules(familyId: string, triggerEngine: string): Promise<IRewardRule[]> {
    const rows = await this.prisma.rewardRule.findMany({
      where: { triggerEngine, isActive: true, OR: [{ familyId }, { familyId: null }] },
    });
    return rows.map((row) => ({
      id: row.id,
      familyId: row.familyId,
      triggerEngine: row.triggerEngine,
      triggerCondition: row.triggerCondition as Record<string, unknown>,
      rewardType: row.rewardType as IRewardRule['rewardType'],
      rewardAmountOrBadgeId: row.rewardAmountOrBadgeId,
      isActive: row.isActive,
    }));
  }

  async listActiveCatalogItems(familyId: string): Promise<IRewardCatalogItem[]> {
    const rows = await this.prisma.rewardCatalogItem.findMany({ where: { familyId, isActive: true } });
    return rows.map((row) => ({ id: row.id, familyId: row.familyId, title: row.title, costCoins: row.costCoins, isActive: row.isActive }));
  }

  async findCatalogItemById(itemId: string): Promise<IRewardCatalogItem | null> {
    const row = await this.prisma.rewardCatalogItem.findUnique({ where: { id: itemId } });
    return row ? { id: row.id, familyId: row.familyId, title: row.title, costCoins: row.costCoins, isActive: row.isActive } : null;
  }

  async createRedemption(childId: string, rewardCatalogItemId: string): Promise<IRewardRedemption> {
    const row = await this.prisma.rewardRedemption.create({ data: { childId, rewardCatalogItemId } });
    return { id: row.id, childId: row.childId, rewardCatalogItemId: row.rewardCatalogItemId, status: row.status };
  }

  async findRedemptionById(redemptionId: string): Promise<IRewardRedemption | null> {
    const row = await this.prisma.rewardRedemption.findUnique({ where: { id: redemptionId } });
    return row ? { id: row.id, childId: row.childId, rewardCatalogItemId: row.rewardCatalogItemId, status: row.status } : null;
  }

  /** DA-002 rewrite. Deducts coins and marks the redemption approved in
   * one transaction, with BOTH steps written as conditional UPDATEs so
   * neither can be raced:
   *
   *   1. `WHERE status = 'REQUESTED'` — exactly one concurrent approval
   *      can claim the redemption; the others see zero rows updated.
   *   2. `WHERE coins >= cost` — the balance can never go negative,
   *      whatever the interleaving.
   *
   * A2 §7.5 executed 6 concurrent approvals of ONE 100-coin redemption
   * against a 100-coin balance and measured a final balance of −500 with
   * 6 REDEEM ledger rows. Both numbers were produced by the missing
   * `WHERE` clauses, not by a missing lock. */
  async approveRedemption(redemptionId: string, childId: string, costCoins: number, decidedByUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$executeRawUnsafe(
        SQL_CLAIM_REDEMPTION,
        redemptionId,
        decidedByUserId,
      );
      if (claimed === 0) {
        throw new BadRequestException('Redemption is no longer awaiting a decision, cannot approve again');
      }

      const deducted = await tx.$executeRawUnsafe(
        SQL_DEDUCT_COINS_IF_SUFFICIENT,
        childId,
        costCoins,
      );
      if (deducted === 0) {
        // Rolls back the claim above too — status and balance can never
        // disagree, which was already this method's stated contract.
        throw new BadRequestException('Child does not have enough coins for this reward anymore');
      }

      await tx.$executeRawUnsafe(SQL_INSERT_REDEEM_LEDGER_ENTRY, childId, costCoins, redemptionId);
    });
  }

  async denyRedemption(redemptionId: string, decidedByUserId: string): Promise<void> {
    await this.prisma.rewardRedemption.update({
      where: { id: redemptionId },
      data: { status: 'DENIED', decidedAt: new Date(), decidedByUserId },
    });
  }
}
