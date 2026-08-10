import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
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
   * if idempotencyKey (when provided) matched an existing entry — a
   * real, previously-processed duplicate, not an error. The account
   * balance itself is updated ONLY inside the same transaction as
   * the ledger write, so a caught duplicate never double-increments
   * xp/coins/stars either. */
  async applyEarn(childId: string, rewardType: 'XP' | 'COINS' | 'BADGE', amount: number, newLevel: number | undefined, source: string, idempotencyKey?: string): Promise<boolean> {
    try {
      await this.prisma.$transaction([
        this.prisma.rewardsAccount.update({
          where: { childId },
          data: {
            ...(rewardType === 'XP' ? { xp: { increment: amount } } : {}),
            ...(rewardType === 'COINS' ? { coins: { increment: amount } } : {}),
            ...(rewardType === 'BADGE' ? { stars: { increment: 1 } } : {}),
            ...(newLevel !== undefined ? { level: newLevel } : {}),
          },
        }),
        this.prisma.rewardsLedgerEntry.create({
          data: { childId, type: 'EARN', rewardType, amount, source, idempotencyKey },
        }),
      ]);
      return true;
    } catch (err: any) {
      // Sprint 16.1 (Double Reward Protection) — CLOSES A REAL GAP:
      // Prisma's P2002 is the unique-constraint-violation code —
      // this is the database itself catching a real duplicate
      // (retry, duplicate event, or a genuine concurrent race), the
      // SAME discipline awardBadgeIfNotAlready already established
      // for badges. Any OTHER error re-throws — this must never
      // silently swallow a real failure.
      if (idempotencyKey && err?.code === 'P2002') {
        return false;
      }
      throw err;
    }
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

  /** Deducts coins and marks the redemption approved, atomically \u2014
   * the coin balance and the redemption status must never disagree. */
  async approveRedemption(redemptionId: string, childId: string, costCoins: number, decidedByUserId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.rewardsAccount.update({ where: { childId }, data: { coins: { decrement: costCoins } } }),
      this.prisma.rewardsLedgerEntry.create({
        data: { childId, type: 'REDEEM', rewardType: 'COINS', amount: costCoins, source: `redemption:${redemptionId}` },
      }),
      this.prisma.rewardRedemption.update({
        where: { id: redemptionId },
        data: { status: 'APPROVED', decidedAt: new Date(), decidedByUserId },
      }),
    ]);
  }

  async denyRedemption(redemptionId: string, decidedByUserId: string): Promise<void> {
    await this.prisma.rewardRedemption.update({
      where: { id: redemptionId },
      data: { status: 'DENIED', decidedAt: new Date(), decidedByUserId },
    });
  }
}
