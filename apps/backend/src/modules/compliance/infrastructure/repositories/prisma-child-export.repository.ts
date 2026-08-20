import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { IChildExportRepository } from '../../application/ports/child-export.repository.port';
import type {
  IBoundedExportSet,
  IChildDataExportRecords,
  IExportedLocationSummary,
} from '../../domain/compliance.types';

/**
 * THE CAP, AND WHY IT IS ONE NUMBER RATHER THAN A PER-TABLE JUDGEMENT.
 *
 * Every enumerated category below returns at most this many rows, newest
 * first, alongside a real `COUNT` of the whole category. 500 is chosen against
 * the worst case rather than the typical one: eleven enumerated categories at
 * 500 rows is ~5,500 rows in one response — a few megabytes of JSON at the
 * widest row shape here — which a Node process serialises without noticing.
 * A family two years into the product has tens of thousands of habit
 * completions and hydration entries, and an unbounded `findMany` over them is
 * an out-of-memory incident on a synchronous, un-streamed HTTP GET.
 *
 * It is deliberately NOT tuned per table. A per-table cap would be a set of
 * numbers nobody could justify individually and that would drift; one cap is
 * reviewable, and `truncated` tells the reader the truth either way.
 */
const EXPORT_ROW_LIMIT = 500;

function boundedSet<T>(total: number, items: T[]): IBoundedExportSet<T> {
  return {
    total,
    returned: items.length,
    truncated: total > items.length,
    limit: EXPORT_ROW_LIMIT,
    items,
  };
}

/**
 * EVERY READ IN THIS FILE NAMES ITS COLUMNS.
 *
 * There is not one bare `findMany({ where })` below, and that is the rule this
 * class exists to keep enforceable: a subject-access export is the single place
 * where "return the row" turns straight into "publish the row". A raw Prisma
 * model would have carried, on the models touched here alone, `familyId`,
 * `fromUserId`, `deviceId`, `safeZoneId`, `idempotencyKey`, the internal ids of
 * every row, and — on `location_events` — the encrypted coordinate columns.
 * None of that is the child's data in any sense a data-protection officer
 * would recognise; all of it is internal plumbing or somebody else's identifier.
 *
 * THE THIRD-PARTY RULE. `child_messages.from_user_id` names a PARENT. A
 * parent's identity is not part of a child's personal data, so the export
 * carries `authorType` («a parent wrote this» / «the AI drafted this») and
 * never the person. The `data` JSON payload is dropped for a different reason:
 * it is a deep-link destination, i.e. app routing, and routing is not subject
 * data.
 */
@Injectable()
export class PrismaChildExportRepository implements IChildExportRepository {
  constructor(private readonly prisma: PrismaService) {}

  async loadRecords(childId: string): Promise<IChildDataExportRecords> {
    const [
      messageTotal,
      messageRows,
      rewardsAccount,
      ledgerTotal,
      ledgerRows,
      ledgerBalances,
      habitDefinitions,
      completionTotal,
      completionRows,
      nutritionTotal,
      nutritionRows,
      hydrationTotal,
      hydrationRows,
      sleepTotal,
      sleepRows,
      activityTotal,
      activityRows,
      measurementTotal,
      measurementRows,
      healthScoreTotal,
      healthScoreRows,
      learningGoals,
      sessionTotal,
      sessionRows,
      assessmentTotal,
      assessmentRows,
      location,
    ] = await Promise.all([
      this.prisma.childMessage.count({ where: { childId } }),
      this.prisma.childMessage.findMany({
        where: { childId },
        orderBy: { createdAt: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: {
          createdAt: true,
          authorType: true,
          approvalStatus: true,
          category: true,
          title: true,
          body: true,
          deliveredAt: true,
          acknowledgedAt: true,
        },
      }),

      this.prisma.rewardsAccount.findUnique({
        where: { childId },
        select: { xp: true, coins: true, stars: true, level: true, updatedAt: true },
      }),
      this.prisma.rewardsLedgerEntry.count({ where: { childId } }),
      this.prisma.rewardsLedgerEntry.findMany({
        where: { childId },
        orderBy: { createdAt: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: {
          createdAt: true,
          type: true,
          rewardType: true,
          amount: true,
          delta: true,
          source: true,
          businessDate: true,
        },
      }),
      /**
       * SUMMED IN SQL OVER THE WHOLE LEDGER, on purpose. `ledger.items` is
       * capped, so a balance derived from it would be wrong the moment the cap
       * bites — and a wrong balance in a compliance export is worse than a
       * missing one. `SUM(delta)`, not `SUM(amount)`: `amount` is an unsigned
       * magnitude and direction lives in `delta` (see the schema's own note on
       * the ledger that once summed to 600 while the account said −500).
       */
      this.prisma.rewardsLedgerEntry.groupBy({
        by: ['rewardType'],
        where: { childId },
        _sum: { delta: true },
      }),

      this.prisma.habit.findMany({
        where: { childId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: { title: true, category: true, recurrence: true, isActive: true, createdAt: true },
      }),
      this.prisma.habitCompletion.count({ where: { childId } }),
      this.prisma.habitCompletion.findMany({
        where: { childId },
        orderBy: { date: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: {
          date: true,
          completedAt: true,
          status: true,
          // The habit's TITLE, not its id: an export is read by a person, and
          // a uuid tells them nothing about what they were asked to do.
          habit: { select: { title: true } },
        },
      }),

      this.prisma.nutritionLog.count({ where: { childId } }),
      this.prisma.nutritionLog.findMany({
        where: { childId },
        orderBy: { date: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: { date: true, mealType: true, calories: true },
      }),
      this.prisma.hydrationLog.count({ where: { childId } }),
      this.prisma.hydrationLog.findMany({
        where: { childId },
        orderBy: { loggedAt: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: { loggedAt: true, amountMl: true },
      }),
      this.prisma.sleepLog.count({ where: { childId } }),
      this.prisma.sleepLog.findMany({
        where: { childId },
        orderBy: { date: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: { date: true, sleepStart: true, sleepEnd: true, quality: true },
      }),
      this.prisma.activityLog.count({ where: { childId } }),
      this.prisma.activityLog.findMany({
        where: { childId },
        orderBy: { date: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: { date: true, activityType: true, durationMinutes: true, socialContext: true },
      }),
      this.prisma.physicalMeasurementLog.count({ where: { childId } }),
      this.prisma.physicalMeasurementLog.findMany({
        where: { childId },
        orderBy: { date: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: { date: true, heightCm: true, weightKg: true },
      }),
      this.prisma.healthScoreDaily.count({ where: { childId } }),
      this.prisma.healthScoreDaily.findMany({
        where: { childId },
        orderBy: { date: 'desc' },
        take: EXPORT_ROW_LIMIT,
        // `breakdown` (a JSON blob of engine internals) is deliberately absent:
        // it is the model's working, not a fact held about the child.
        select: { date: true, score: true },
      }),

      this.prisma.learningGoal.findMany({
        where: { childId },
        orderBy: { createdAt: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: { subject: true, title: true, status: true, targetDate: true, createdAt: true },
      }),
      this.prisma.learningSession.count({ where: { childId } }),
      this.prisma.learningSession.findMany({
        where: { childId },
        orderBy: { date: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: { date: true, subject: true, durationMinutes: true, progressNote: true },
      }),
      this.prisma.learningAssessment.count({ where: { childId } }),
      this.prisma.learningAssessment.findMany({
        where: { childId },
        orderBy: { takenAt: 'desc' },
        take: EXPORT_ROW_LIMIT,
        select: { takenAt: true, subject: true, scorePercent: true, source: true },
      }),

      this.locationSummary(childId),
    ]);

    const balancesFromLedger: Record<string, number> = {};
    for (const row of ledgerBalances) {
      balancesFromLedger[row.rewardType] = row._sum.delta ?? 0;
    }

    return {
      messages: boundedSet(messageTotal, messageRows),
      rewards: {
        account: rewardsAccount,
        balancesFromLedger,
        ledger: boundedSet(ledgerTotal, ledgerRows),
      },
      habits: {
        definitions: habitDefinitions,
        completions: boundedSet(
          completionTotal,
          completionRows.map((row) => ({
            date: row.date,
            completedAt: row.completedAt,
            status: row.status,
            habitTitle: row.habit.title,
          })),
        ),
      },
      health: {
        nutrition: boundedSet(nutritionTotal, nutritionRows),
        hydration: boundedSet(hydrationTotal, hydrationRows),
        sleep: boundedSet(sleepTotal, sleepRows),
        activity: boundedSet(activityTotal, activityRows),
        measurements: boundedSet(measurementTotal, measurementRows),
        dailyScores: boundedSet(healthScoreTotal, healthScoreRows),
      },
      learning: {
        goals: learningGoals,
        sessions: boundedSet(sessionTotal, sessionRows),
        assessments: boundedSet(assessmentTotal, assessmentRows),
      },
      location,
    };
  }

  /**
   * AGGREGATES ONLY — not one coordinate leaves the database.
   *
   * `latitude_enc` / `longitude_enc` are never selected, so this method
   * cannot decrypt anything even by accident. Everything it returns is
   * computed by PostgreSQL: a grouped count per event type, the first and last
   * timestamps, the distinct safe zones by NAME, and the earliest retention
   * expiry. The row count of `location_events` never affects the memory this
   * uses, which is the property that makes years of pings safe here.
   *
   * `null` for a child with no location history, rather than a summary of
   * zeroes — «nothing is held» and «nothing happened» are different statements
   * and this codebase does not print one for the other.
   */
  private async locationSummary(childId: string): Promise<IExportedLocationSummary | null> {
    const [byType, bounds] = await Promise.all([
      this.prisma.locationEvent.groupBy({
        by: ['eventType'],
        where: { childId },
        _count: { _all: true },
      }),
      this.prisma.locationEvent.aggregate({
        where: { childId },
        _count: { _all: true },
        _min: { recordedAt: true, expiresAt: true },
        _max: { recordedAt: true },
      }),
    ]);

    const totalEvents = bounds._count._all;
    if (totalEvents === 0 || !bounds._min.recordedAt || !bounds._max.recordedAt) return null;

    const zones = await this.prisma.locationEvent.findMany({
      where: { childId, safeZoneId: { not: null } },
      distinct: ['safeZoneId'],
      take: EXPORT_ROW_LIMIT,
      // The zone's NAME only. A safe zone's coordinates are the household's
      // data, not the child's, and naming «المدرسة» is what makes the summary
      // legible without describing where the school is.
      select: { safeZone: { select: { name: true } } },
    });

    const eventCounts: Record<string, number> = {};
    for (const row of byType) {
      eventCounts[row.eventType] = row._count._all;
    }

    return {
      totalEvents,
      eventCounts,
      firstRecordedAt: bounds._min.recordedAt,
      lastRecordedAt: bounds._max.recordedAt,
      safeZoneNames: zones
        .map((row) => row.safeZone?.name)
        .filter((name): name is string => typeof name === 'string'),
      earliestExpiresAt: bounds._min.expiresAt ?? null,
    };
  }
}
