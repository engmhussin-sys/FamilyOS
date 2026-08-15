import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import {
  SQL_APPLY_ACCOUNT_DELTAS,
  SQL_BALANCE_FROM_LEDGER,
  SQL_CLAIM_REDEMPTION,
  SQL_COUNT_EARN_IN_WINDOW,
  SQL_DEDUCT_COINS_IF_SUFFICIENT,
  SQL_INSERT_EARN_LEDGER_ENTRY,
  SQL_INSERT_REDEEM_LEDGER_ENTRY,
  SQL_LOCK_GRANT_SCOPE,
  SQL_RECONCILE_ACCOUNT_FROM_LEDGER,
} from './rewards.sql';
import {
  IBadgeDefinition,
  IRewardCatalogItem,
  IRewardRedemption,
  IRewardRule,
  IRewardsAccount,
  RewardType,
} from '../../domain/rewards.types';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';

/**
 * B4 — the window a `maxPerDay` / `maxPerWeek` cap is counted over. Both
 * windows are computed by `RewardsEngineService` from `FamilyDateService`, so
 * the repository never has to know what a timezone is and there is no second
 * answer to "which day is it?" (the class of bug B1+B2 removed).
 */
export interface IGrantCap {
  readonly maxPerDay: number | null;
  readonly maxPerWeek: number | null;
  /** `YYYY-MM-DD` on the family's calendar — the day being counted. */
  readonly businessDate: string;
  /** `YYYY-MM-DD`, six calendar days before `businessDate`. A ROLLING week. */
  readonly weekStartDate: string;
}

/** What a parent (or the platform seed) may set on a managed rule. */
export interface IRewardRuleWriteInput {
  readonly triggerEngine: string;
  readonly eventType: string;
  readonly triggerCondition: Record<string, unknown>;
  readonly rewardType: RewardType;
  readonly rewardAmountOrBadgeId: string;
  readonly maxPerDay: number | null;
  readonly maxPerWeek: number | null;
  readonly minVerifiedBy: string | null;
  readonly category: string | null;
  readonly labelAr: string | null;
  readonly isActive: boolean;
}

@Injectable()
export class PrismaRewardsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * B5 — the first reader of `rewards_ledger_entries` in the repository's
   * history. Newest first, because a parent opening a ledger is asking «what
   * just happened», not «what happened in 2024». Tenant scoping comes from the
   * F2 extension: `RewardsLedgerEntry` is STRICT, so no `familyId` argument
   * exists to pass wrongly.
   */
  listLedgerEntries(childId: string, limit: number): Promise<unknown[]> {
    return this.prisma.rewardsLedgerEntry.findMany({
      where: { childId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * PHASE C (`PC-B-001`) — «HAS THIS TRIGGER ALREADY BEEN PAID?», asked of the
   * DATABASE rather than of a return value.
   *
   * `applyEarn` answers "did I create a row JUST NOW"; after a retry the answer
   * is `false` for a grant that is very much committed, and `PA-B-009` is
   * exactly what that ambiguity cost. This method answers the different, stable
   * question the consumer actually needs: does the ledger already hold grants
   * caused by this originating event?
   *
   * THE PREFIX IS NOT A HEURISTIC. `RewardsEngineService.processTriggerEvent`
   * composes every grant key as `${event.idempotencyKey}:${rewardType}:${source}`
   * — one line, one place — so `startsWith('<key>:')` selects exactly the rows
   * that one trigger wrote and cannot select another trigger's, because the
   * originating keys are themselves composed by `composeIdempotencyKey` from
   * server-owned values and are unique per (family, occurrence).
   *
   * Tenant scoping comes from the F2 extension: `RewardsLedgerEntry` is STRICT,
   * so there is no `familyId` argument to pass wrongly.
   */
  countGrantsForTrigger(childId: string, triggerIdempotencyKey: string): Promise<number> {
    return this.prisma.rewardsLedgerEntry.count({
      where: {
        childId,
        type: 'EARN',
        idempotencyKey: { startsWith: `${triggerIdempotencyKey}:` },
      },
    });
  }

  async getOrCreateAccount(childId: string): Promise<IRewardsAccount> {
    const row = await this.prisma.rewardsAccount.upsert({
      where: { childId },
      create: { familyId: tenantIdForWrite(), childId },
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
  async applyEarn(
    childId: string,
    rewardType: RewardType,
    amount: number,
    newLevel: number | undefined,
    source: string,
    idempotencyKey?: string,
    cap?: IGrantCap,
    businessDate?: string,
  ): Promise<boolean> {
    const effectiveKey = idempotencyKey ?? `nokey:${randomUUID()}`;
    // BADGE grants move `stars` by one, matching the original behaviour.
    const delta = rewardType === 'BADGE' ? 1 : amount;

    return this.prisma.$transaction(async (tx) => {
      // B4 — maxPerDay / maxPerWeek, AND WHY THE LOCK IS HERE.
      //
      // A cap is a COUNT, and a count-then-insert is the exact read-then-write
      // shape A2 §7.3 measured letting 8 concurrent identical requests through.
      // The idempotency key does not help: two DIFFERENT completions (two
      // different habits) legitimately carry two different keys and would both
      // pass a naive count.
      //
      // `pg_advisory_xact_lock` serialises grants for this (child, rule) pair
      // and nothing else, and it is released by the transaction, not by us.
      // The window is one INSERT wide; the lock key is derived from values the
      // server owns.
      if (cap) {
        await tx.$executeRawUnsafe(SQL_LOCK_GRANT_SCOPE, `${childId}:${source}`);

        if (cap.maxPerDay != null) {
          const dayCount = await this.countInWindow(tx, childId, source, cap.businessDate, cap.businessDate);
          if (dayCount >= cap.maxPerDay) return false;
        }
        if (cap.maxPerWeek != null) {
          const weekCount = await this.countInWindow(tx, childId, source, cap.weekStartDate, cap.businessDate);
          if (weekCount >= cap.maxPerWeek) return false;
        }
      }

      const inserted = await tx.$executeRawUnsafe(
        SQL_INSERT_EARN_LEDGER_ENTRY,
        childId,
        rewardType,
        amount,
        delta,
        source,
        effectiveKey,
        tenantIdForWrite(),
        businessDate ?? null,
      );

      if (inserted === 0) {
        // The database rejected a true duplicate. The balance is
        // untouched precisely because we never got here to move it.
        return false;
      }

      // F4: the six new reward types are LEDGER-ONLY. Their value is the side
      // effect a consumer materialises (screen-time minutes, a fulfilment the
      // parent delivers), not a balance column — so all three deltas are zero
      // for them and the accounts cache stays a faithful sum of XP/COINS/BADGE,
      // exactly as `SQL_RECONCILE_ACCOUNT_FROM_LEDGER` already assumes. Both
      // statements below are scoped by family_id ($7 / $6) — raw SQL is not
      // intercepted by the tenant extension, so it scopes itself.
      await tx.$executeRawUnsafe(
        SQL_APPLY_ACCOUNT_DELTAS,
        childId,
        rewardType === 'XP' ? delta : 0,
        rewardType === 'COINS' ? delta : 0,
        rewardType === 'BADGE' ? delta : 0,
        newLevel ?? null,
        tenantIdForWrite(),
      );

      return true;
    });
  }

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  private async countInWindow(tx: any, childId: string, source: string, fromDate: string, toDate: string): Promise<number> {
    const rows = (await tx.$queryRawUnsafe(
      SQL_COUNT_EARN_IN_WINDOW,
      childId,
      source,
      fromDate,
      toDate,
      tenantIdForWrite(),
    )) as Array<{ n: number | bigint }>;
    return rows.length > 0 ? Number(rows[0].n) : 0;
  }

  /** DP-5 (deterministic recomputation): the balance rebuilt from the
   * ledger alone. Meaningful only because `delta` is signed — A2 §7.4
   * showed `SUM(amount)` returning 600 for an account holding −500. */
  async computeBalanceFromLedger(childId: string): Promise<{ xp: number; coins: number; stars: number }> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ reward_type: string; balance: number }>>(
      SQL_BALANCE_FROM_LEDGER,
      childId,
      tenantIdForWrite(),
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
    await this.prisma.$executeRawUnsafe(SQL_RECONCILE_ACCOUNT_FROM_LEDGER, childId, tenantIdForWrite());
  }

  async findBadgeByKey(key: string): Promise<IBadgeDefinition | null> {
    const row = await this.prisma.badgeDefinition.findUnique({ where: { key } });
    if (!row) return null;
    return { id: row.id, key: row.key, title: row.title, description: row.description, criteria: row.criteria as Record<string, unknown>, isGroupAchievement: row.isGroupAchievement };
  }

  async awardBadgeIfNotAlready(childId: string, badgeId: string): Promise<boolean> {
    try {
      await this.prisma.childBadgeAward.create({ data: { familyId: tenantIdForWrite(), childId, badgeId } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * BOTH TIERS IN ONE QUERY, and that `OR: [{familyId}, {familyId: null}]` is
   * not new — it has been here since Sprint 25. B4 changed nothing about it,
   * which is the point: the platform defaults migration 0007 seeded with
   * `family_id IS NULL` reach every family, including families created long
   * before the migration ran, through a read path that already worked and is
   * already covered by `tenant-extension.integration.spec.ts` (`RewardRule` is
   * registered SHARED_NULL in `tenant-model-registry.ts:117`).
   *
   * Precedence between the two tiers is applied by `selectApplicableRules` in
   * `rewards-rules.ts` — a pure function, testable without a database.
   *
   * B4 DROPPED `isActive: true` FROM THE QUERY, deliberately. `isActive` is
   * still honoured — `evaluateRewardRules` skips an inactive rule on its first
   * line — but precedence has to be able to SEE a family's deactivated rule,
   * because a deactivated family rule is how a family says \"pay nothing for
   * this engine\". If the query hid it, deactivating the only rule you own
   * would silently hand the engine back to the platform defaults and keep
   * paying, which is the opposite of what the parent just asked for.
   */
  async listActiveRewardRules(familyId: string, triggerEngine: string): Promise<IRewardRule[]> {
    const rows = await this.prisma.rewardRule.findMany({
      where: { triggerEngine, OR: [{ familyId }, { familyId: null }] },
    });
    return rows.map((row) => this.toRule(row));
  }

  // --- B4: RewardRule management (PA-B-015) ---------------------------------

  /** Every rule this family can see — its own plus the platform defaults —
   * so the parent UI can show what is actually in force, not just what the
   * family typed. */
  async listRewardRulesForFamily(familyId: string): Promise<IRewardRule[]> {
    const rows = await this.prisma.rewardRule.findMany({
      where: { OR: [{ familyId }, { familyId: null }], programId: null },
      orderBy: [{ familyId: 'asc' }, { triggerEngine: 'asc' }, { eventType: 'asc' }],
    });
    return rows.map((row) => this.toRule(row));
  }

  /** A family-owned rule by id. Returns null for a platform rule and for
   * another family's rule alike — the tenant extension scopes the read, and a
   * `familyId: null` row is deliberately excluded so no parent can mutate the
   * platform tier through this path. */
  async findFamilyRewardRule(familyId: string, ruleId: string): Promise<IRewardRule | null> {
    const row = await this.prisma.rewardRule.findFirst({ where: { id: ruleId, familyId, programId: null } });
    return row ? this.toRule(row) : null;
  }

  async countFamilyRewardRules(familyId: string): Promise<number> {
    return this.prisma.rewardRule.count({ where: { familyId, programId: null } });
  }

  async createRewardRule(familyId: string, createdByUserId: string, input: IRewardRuleWriteInput): Promise<IRewardRule> {
    const row = await this.prisma.rewardRule.create({
      data: {
        familyId,
        createdByUserId,
        triggerEngine: input.triggerEngine,
        eventType: input.eventType,
        triggerCondition: input.triggerCondition as object,
        rewardType: input.rewardType,
        rewardAmountOrBadgeId: input.rewardAmountOrBadgeId,
        maxPerDay: input.maxPerDay,
        maxPerWeek: input.maxPerWeek,
        minVerifiedBy: input.minVerifiedBy,
        category: input.category,
        labelAr: input.labelAr,
        isActive: input.isActive,
      },
    });
    return this.toRule(row);
  }

  async updateRewardRule(ruleId: string, patch: Partial<IRewardRuleWriteInput>): Promise<IRewardRule> {
    const row = await this.prisma.rewardRule.update({
      where: { id: ruleId },
      data: {
        ...(patch.rewardAmountOrBadgeId !== undefined ? { rewardAmountOrBadgeId: patch.rewardAmountOrBadgeId } : {}),
        ...(patch.maxPerDay !== undefined ? { maxPerDay: patch.maxPerDay } : {}),
        ...(patch.maxPerWeek !== undefined ? { maxPerWeek: patch.maxPerWeek } : {}),
        ...(patch.minVerifiedBy !== undefined ? { minVerifiedBy: patch.minVerifiedBy } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.labelAr !== undefined ? { labelAr: patch.labelAr } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
    });
    return this.toRule(row);
  }

  /** DEACTIVATE, never DELETE. A ledger row's `source` is
   * `reward_rule:<id>`; deleting the rule would orphan the audit trail of
   * every reward it ever paid. Same reasoning as `deactivateProgramRules`. */
  async deactivateRewardRule(ruleId: string): Promise<void> {
    await this.prisma.rewardRule.update({ where: { id: ruleId }, data: { isActive: false } });
  }

  /** THE ONLY ROUTE BACK TO THE PLATFORM DEFAULTS. `selectApplicableRules`
   * decides engine ownership by EXISTENCE, so deactivating a rule means "pay
   * nothing for this engine" and REMOVING it means "go back to how it was". Two
   * different intentions, two different verbs — a parent should not have to
   * discover that one of them secretly means the other. */
  async deleteRewardRule(ruleId: string): Promise<void> {
    await this.prisma.rewardRule.delete({ where: { id: ruleId } });
  }

  /** The catalogue a parent picks a category from — read straight out of
   * `reward_program_categories`, which is a TABLE. Nothing in the grant path
   * branches on the value, so a nineteenth category is an INSERT. */
  async listRewardCategories(): Promise<Array<{ code: string; labelAr: string; streakKind: string; sortOrder: number }>> {
    const rows = await this.prisma.rewardProgramCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return rows.map((r) => ({ code: r.code, labelAr: r.labelAr, streakKind: r.streakKind, sortOrder: r.sortOrder }));
  }

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  private toRule(row: any): IRewardRule {
    return {
      id: row.id,
      familyId: row.familyId,
      triggerEngine: row.triggerEngine,
      triggerCondition: row.triggerCondition as Record<string, unknown>,
      rewardType: row.rewardType as IRewardRule['rewardType'],
      rewardAmountOrBadgeId: row.rewardAmountOrBadgeId,
      isActive: row.isActive,
      eventType: row.eventType ?? null,
      maxPerDay: row.maxPerDay ?? null,
      maxPerWeek: row.maxPerWeek ?? null,
      minVerifiedBy: row.minVerifiedBy ?? null,
      category: row.category ?? null,
      labelAr: row.labelAr ?? null,
    };
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
    const row = await this.prisma.rewardRedemption.create({ data: { familyId: tenantIdForWrite(), childId, rewardCatalogItemId } });
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
        tenantIdForWrite(),
      );
      if (claimed === 0) {
        throw new BadRequestException('Redemption is no longer awaiting a decision, cannot approve again');
      }

      const deducted = await tx.$executeRawUnsafe(
        SQL_DEDUCT_COINS_IF_SUFFICIENT,
        childId,
        costCoins,
        tenantIdForWrite(),
      );
      if (deducted === 0) {
        // Rolls back the claim above too — status and balance can never
        // disagree, which was already this method's stated contract.
        throw new BadRequestException('Child does not have enough coins for this reward anymore');
      }

      await tx.$executeRawUnsafe(SQL_INSERT_REDEEM_LEDGER_ENTRY, childId, costCoins, redemptionId, tenantIdForWrite());
    });
  }

  async denyRedemption(redemptionId: string, decidedByUserId: string): Promise<void> {
    await this.prisma.rewardRedemption.update({
      where: { id: redemptionId },
      data: { status: 'DENIED', decidedAt: new Date(), decidedByUserId },
    });
  }
}
