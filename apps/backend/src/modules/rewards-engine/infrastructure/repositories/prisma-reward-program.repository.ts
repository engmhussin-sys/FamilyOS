/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';
import {
  BASE_MULTIPLIER_BPS,
  STREAK_MULTIPLIER_LADDER,
  applyMultiplier,
} from '../../../../shared/rewards/streak-multiplier';
import {
  MAX_SCREEN_TIME_GRANT_MINUTES,
  REWARD_TYPE_TO_LEDGER,
  type RewardSpec,
} from '../../../../shared/rewards/reward-spec';

/**
 * Data access for the F4 tables.
 *
 * The tenant is NEVER a parameter: every write takes it from
 * `tenantIdForWrite()` (the ambient context established by
 * `TenantContextInterceptor` from the verified principal), and every read is
 * scoped by the F2 Prisma extension before it reaches PostgreSQL. That is why
 * no method below has a `familyId` argument — there is no call site that could
 * pass the wrong one.
 */
@Injectable()
export class PrismaRewardProgramRepository {
  constructor(private readonly prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  // --- programs -------------------------------------------------------------

  createProgram(data: Record<string, unknown>): Promise<any> {
    return this.db.rewardProgram.create({ data: { ...data, familyId: tenantIdForWrite() } });
  }

  findProgram(id: string): Promise<any | null> {
    return this.db.rewardProgram.findFirst({ where: { id } });
  }

  listPrograms(where: Record<string, unknown> = {}): Promise<any[]> {
    return this.db.rewardProgram.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  updateProgram(id: string, data: Record<string, unknown>): Promise<any> {
    return this.db.rewardProgram.update({ where: { id }, data });
  }

  /**
   * MATERIALISES THE COMPANION `RewardRule` ROWS — the reuse seam.
   *
   * One rule per multiplier tier the ladder defines, each carrying the ALREADY
   * MULTIPLIED amount, `triggerEngine: 'reward-program'` and
   * `triggerCondition: { programId, multiplierBps }`. The untouched
   * `evaluateRewardRules` then matches exactly one of them per grant, by its
   * existing subset-match, and the untouched `RewardsEngineService` pays it.
   *
   * `createMany({ skipDuplicates })` over the partial unique index
   * `(program_id, multiplier_bps)` makes this idempotent BY CONSTRAINT rather
   * than by a check-then-insert — the same principle DA-002 established for the
   * ledger itself.
   */
  async materialiseProgramRules(
    programId: string,
    spec: RewardSpec,
    ceilingBps: number,
  ): Promise<number> {
    const familyId = tenantIdForWrite();
    const ledgerType = REWARD_TYPE_TO_LEDGER[spec.type];

    const rows = STREAK_MULTIPLIER_LADDER.filter((tier) => tier.multiplierBps <= ceilingBps).map(
      (tier) => {
        let amount = applyMultiplier(spec.amount, tier.multiplierBps);
        // The screen-time ceiling is a HARD bound, not a suggestion: a 3x
        // multiplier on a 30-minute reward must not mint 90 minutes when the
        // per-grant maximum is 60.
        if (spec.type === 'SCREEN_TIME') amount = Math.min(amount, MAX_SCREEN_TIME_GRANT_MINUTES);
        return {
          familyId,
          programId,
          multiplierBps: tier.multiplierBps,
          triggerEngine: 'reward-program',
          triggerCondition: { programId, multiplierBps: tier.multiplierBps },
          rewardType: ledgerType,
          rewardAmountOrBadgeId: String(amount),
          isActive: true,
        };
      },
    );

    // The base tier must always exist, even if a parent set a ceiling below it.
    if (!rows.some((r) => r.multiplierBps === BASE_MULTIPLIER_BPS)) {
      const amount =
        spec.type === 'SCREEN_TIME' ? Math.min(spec.amount, MAX_SCREEN_TIME_GRANT_MINUTES) : spec.amount;
      rows.push({
        familyId,
        programId,
        multiplierBps: BASE_MULTIPLIER_BPS,
        triggerEngine: 'reward-program',
        triggerCondition: { programId, multiplierBps: BASE_MULTIPLIER_BPS },
        rewardType: ledgerType,
        rewardAmountOrBadgeId: String(amount),
        isActive: true,
      });
    }

    const res = await this.db.rewardRule.createMany({ data: rows, skipDuplicates: true });
    return res.count ?? 0;
  }

  deactivateProgramRules(programId: string): Promise<any> {
    return this.db.rewardRule.updateMany({ where: { programId }, data: { isActive: false } });
  }

  listProgramRules(programId: string): Promise<any[]> {
    return this.db.rewardRule.findMany({ where: { programId } });
  }

  // --- achievements ---------------------------------------------------------

  createAchievement(data: Record<string, unknown>): Promise<any> {
    return this.db.achievementRequest.create({ data: { ...data, familyId: tenantIdForWrite() } });
  }

  findAchievement(id: string): Promise<any | null> {
    return this.db.achievementRequest.findFirst({ where: { id } });
  }

  updateAchievement(id: string, data: Record<string, unknown>): Promise<any> {
    return this.db.achievementRequest.update({ where: { id }, data });
  }

  listAchievements(where: Record<string, unknown>): Promise<any[]> {
    return this.db.achievementRequest.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  countAchievements(where: Record<string, unknown>): Promise<number> {
    return this.db.achievementRequest.count({ where });
  }

  /** Distinct VERIFIED days for a child across a set of programs — the input to
   * the streak calculation, which is RECOMPUTED and never stored. */
  async verifiedDates(childId: string, programIds: string[]): Promise<string[]> {
    if (programIds.length === 0) return [];
    const rows = await this.db.achievementRequest.findMany({
      where: { childId, status: 'VERIFIED', programId: { in: programIds } },
      select: { localDate: true },
    });
    // B2, DELIBERATELY TIMEZONE-FREE: `AchievementRequest.local_date` is a
    // `@db.Date` that already holds a business date — `AchievementService.start`
    // computed it on the family calendar before writing. Reading a stored day
    // back is `toISOString().slice(0, 10)`; re-projecting it through a timezone
    // would shift every historical row by one for any family east of UTC.
    return rows.map((r: any) => new Date(r.localDate).toISOString().slice(0, 10));
  }

  // --- verification attempts (append-only) ----------------------------------

  createAttempt(data: Record<string, unknown>): Promise<any> {
    return this.db.verificationAttempt.create({ data: { ...data, familyId: tenantIdForWrite() } });
  }

  listAttempts(achievementId: string): Promise<any[]> {
    return this.db.verificationAttempt.findMany({
      where: { achievementId },
      orderBy: { attemptNumber: 'asc' },
    });
  }

  countAttempts(achievementId: string): Promise<number> {
    return this.db.verificationAttempt.count({ where: { achievementId } });
  }

  // --- ledger lookup (read-only; the ledger is written by RewardsEngine) -----

  /** The ledger rows a given achievement's grant produced. Found by the
   * deterministic key prefix, which is why the key composition is a shared,
   * tested function rather than string concatenation at each call site. */
  listLedgerEntriesByKeyPrefix(childId: string, prefix: string): Promise<any[]> {
    return this.db.rewardsLedgerEntry.findMany({
      where: { childId, type: 'EARN', idempotencyKey: { startsWith: prefix } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // --- screen-time grants ---------------------------------------------------

  createScreenTimeGrant(data: Record<string, unknown>): Promise<any> {
    return this.db.screenTimeRewardGrant.create({ data: { ...data, familyId: tenantIdForWrite() } });
  }

  findScreenTimeGrant(id: string): Promise<any | null> {
    return this.db.screenTimeRewardGrant.findFirst({ where: { id } });
  }

  listScreenTimeGrants(where: Record<string, unknown>): Promise<any[]> {
    return this.db.screenTimeRewardGrant.findMany({ where, orderBy: { grantedAt: 'desc' } });
  }

  updateScreenTimeGrant(id: string, data: Record<string, unknown>): Promise<any> {
    return this.db.screenTimeRewardGrant.update({ where: { id }, data });
  }

  // --- fulfilments ----------------------------------------------------------

  createFulfilment(data: Record<string, unknown>): Promise<any> {
    return this.db.rewardFulfilment.create({ data: { ...data, familyId: tenantIdForWrite() } });
  }

  findFulfilment(id: string): Promise<any | null> {
    return this.db.rewardFulfilment.findFirst({ where: { id } });
  }

  listFulfilments(where: Record<string, unknown>): Promise<any[]> {
    return this.db.rewardFulfilment.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  /**
   * A CONDITIONAL update, in the same spirit as `SQL_CLAIM_REDEMPTION`: the
   * expected current status is part of the WHERE clause, so two concurrent
   * approvals cannot both win. `count === 0` means "someone else moved it
   * first", which the service turns into a 400 rather than a silent success.
   */
  async transitionFulfilment(
    id: string,
    from: string,
    to: string,
    data: Record<string, unknown>,
  ): Promise<number> {
    const res = await this.db.rewardFulfilment.updateMany({
      where: { id, status: from },
      data: { ...data, status: to },
    });
    return res.count ?? 0;
  }

  // --- reference data -------------------------------------------------------

  listCategories(): Promise<any[]> {
    return this.db.rewardProgramCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  listSurahs(): Promise<any[]> {
    return this.db.quranSurah.findMany({ orderBy: { number: 'asc' } });
  }

  /** REUSE: the existing `LearningAssessment` table is the ASSESSMENT
   * strategy's score source. No parallel score table was created. */
  async latestAssessmentScore(childId: string, subject: string): Promise<number | null> {
    const row = await this.db.learningAssessment.findFirst({
      where: { childId, subject },
      orderBy: { takenAt: 'desc' },
      select: { scorePercent: true },
    });
    return row ? Number(row.scorePercent) : null;
  }

  /** REUSE: a verified achievement also lands as a `LearningSession` row, so
   * the existing Education/Faith reporting sees it without a second model. */
  createLearningSession(data: Record<string, unknown>): Promise<any> {
    return this.db.learningSession.create({ data: { ...data, familyId: tenantIdForWrite() } });
  }

  // --- rule counters --------------------------------------------------------

  /**
   * The counter `maxPerDay` / `maxPerWeek` are decided against. It counts
   * VERIFIED rows only: a failed or still-open attempt must not consume a
   * child's daily allowance, or a network hiccup would cost them the day.
   */
  countVerifiedBetween(
    programId: string,
    childId: string,
    fromDate: string,
    toDate: string,
  ): Promise<number> {
    return this.db.achievementRequest.count({
      where: {
        programId,
        childId,
        status: 'VERIFIED',
        localDate: { gte: new Date(`${fromDate}T00:00:00.000Z`), lte: new Date(`${toDate}T00:00:00.000Z`) },
      },
    });
  }

  /** Attempts that are still in flight today — the reason a retried "start" is
   * a 409 rather than a second row. */
  countOpenOn(programId: string, childId: string, localDate: string): Promise<number> {
    return this.db.achievementRequest.count({
      where: {
        programId,
        childId,
        localDate: new Date(`${localDate}T00:00:00.000Z`),
        status: { in: ['REQUESTED', 'IN_PROGRESS', 'SUBMITTED', 'PENDING_PARENT'] },
      },
    });
  }

  /** The highest `attempt_no` used for this (program, child, day), so the next
   * attempt after a rejection is `n + 1` and the unique index still holds. */
  async maxAttemptNo(programId: string, childId: string, localDate: string): Promise<number> {
    const row = await this.db.achievementRequest.findFirst({
      where: { programId, childId, localDate: new Date(`${localDate}T00:00:00.000Z`) },
      orderBy: { attemptNo: 'desc' },
      select: { attemptNo: true },
    });
    return row?.attemptNo ?? 0;
  }

  findChild(childId: string): Promise<any | null> {
    return this.db.child.findFirst({
      where: { id: childId },
      select: { id: true, familyId: true, dateOfBirth: true, firstName: true },
    });
  }

  /** Programs a child may see today: theirs plus the family-wide ones. */
  listProgramsForChild(childId: string): Promise<any[]> {
    return this.db.rewardProgram.findMany({
      where: { status: 'ACTIVE', OR: [{ childId }, { childId: null }] },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The ACTIVE bonus minutes a child holds right now — unexpired and unrevoked.
   * This is the number `ScreenTimeService.getEffectivePolicy` adds to the base
   * policy, and the number the per-child ceiling is checked against before a new
   * grant is written.
   */
  async activeBonusMinutes(childId: string, now: Date): Promise<number> {
    const rows = await this.db.screenTimeRewardGrant.findMany({
      where: { childId, revokedAt: null, expiresAt: { gt: now } },
      select: { minutes: true },
    });
    return rows.reduce((sum: number, r: { minutes: number }) => sum + r.minutes, 0);
  }
}
