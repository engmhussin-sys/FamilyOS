import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { IDailyUsageSummary, IDailyUsageSummaryInput } from '../../domain/digital-wellbeing.types';

/** Sprint 14 (Behavioral Intelligence Engine) — category-summed
 * minutes computed from the app breakdown itself, never re-derived
 * from a package name server-side (the device already classifies
 * locally, per the Sprint's own "raw package name stays local where
 * possible" principle). */
function sumByCategory(appBreakdown: IDailyUsageSummaryInput['appBreakdown'], category: string): number {
  return appBreakdown.filter((a) => a.category === category).reduce((sum, a) => sum + a.minutes, 0);
}

@Injectable()
export class PrismaDigitalWellbeingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Upserts the day-level snapshot AND the per-app breakdown in one
   * transaction — the device uploads one payload once a day, this is
   * either its first upload for that day or a same-day correction
   * (e.g. a delayed sync catching up), never a duplicate append. */
  async upsertDailySummary(
    childId: string,
    deviceId: string,
    input: IDailyUsageSummaryInput,
  ): Promise<IDailyUsageSummary> {
    const usageDate = new Date(input.usageDate);

    const educationMinutes = sumByCategory(input.appBreakdown, 'EDUCATION');
    const gamingMinutes = sumByCategory(input.appBreakdown, 'GAMING');
    const socialMinutes = sumByCategory(input.appBreakdown, 'SOCIAL');
    const entertainmentMinutes = sumByCategory(input.appBreakdown, 'ENTERTAINMENT');

    const [snapshot] = await this.prisma.$transaction([
      this.prisma.dailyBehavioralSnapshot.upsert({
        where: { childId_usageDate: { childId, usageDate } },
        create: {
          childId,
          deviceId,
          usageDate,
          totalScreenMinutes: input.totalScreenMinutes,
          pickupCount: input.pickupCount,
          nightUsageMinutes: input.nightUsageMinutes,
          blockedAttemptCount: input.blockedAttemptCount,
          sessionCount: input.sessionCount,
          averageSessionMinutes: input.averageSessionMinutes,
          longestSessionMinutes: input.longestSessionMinutes,
          educationMinutes,
          gamingMinutes,
          socialMinutes,
          entertainmentMinutes,
        },
        update: {
          totalScreenMinutes: input.totalScreenMinutes,
          pickupCount: input.pickupCount,
          nightUsageMinutes: input.nightUsageMinutes,
          blockedAttemptCount: input.blockedAttemptCount,
          sessionCount: input.sessionCount,
          averageSessionMinutes: input.averageSessionMinutes,
          longestSessionMinutes: input.longestSessionMinutes,
          educationMinutes,
          gamingMinutes,
          socialMinutes,
          entertainmentMinutes,
        },
      }),
      // Per-app rows: delete-then-recreate for this exact day is
      // simpler and just as correct as a diff-and-patch, given this
      // runs at most once or twice a day per child (an initial upload
      // plus perhaps one late-sync correction) — not a hot path that
      // needs incremental-update optimization.
      this.prisma.appUsageLog.deleteMany({ where: { childId, deviceId, usageDate } }),
      ...input.appBreakdown.map((app) =>
        this.prisma.appUsageLog.create({
          data: {
            childId,
            deviceId,
            packageName: app.packageName,
            category: app.category,
            usageDate,
            usageMinutes: app.minutes,
          },
        }),
      ),
    ]);

    return {
      id: snapshot.id,
      childId: snapshot.childId,
      deviceId: snapshot.deviceId,
      usageDate: input.usageDate,
      totalScreenMinutes: snapshot.totalScreenMinutes,
      appBreakdown: input.appBreakdown,
      pickupCount: snapshot.pickupCount,
      nightUsageMinutes: snapshot.nightUsageMinutes,
      blockedAttemptCount: snapshot.blockedAttemptCount,
      sessionCount: snapshot.sessionCount ?? undefined,
      averageSessionMinutes: snapshot.averageSessionMinutes ?? undefined,
      longestSessionMinutes: snapshot.longestSessionMinutes ?? undefined,
      createdAt: snapshot.createdAt,
    };
  }

  /** Sprint 14 — writes the Pattern/Anomaly Detection output onto an
   * ALREADY-EXISTING snapshot row (never creates a new one — the
   * daily summary upload above is the only writer of new rows). */
  async updateDetectionResults(
    childId: string,
    usageDate: string,
    patterns: string[],
    positivePatterns: string[],
    baselineDeviationPercent: number | null,
  ): Promise<void> {
    await this.prisma.dailyBehavioralSnapshot.update({
      where: { childId_usageDate: { childId, usageDate: new Date(usageDate) } },
      data: { patterns, positivePatterns, baselineDeviationPercent },
    });
  }

  async findSnapshotsInWindow(childId: string, sinceDate: Date): Promise<
    Array<{
      usageDate: Date;
      totalScreenMinutes: number;
      pickupCount: number;
      nightUsageMinutes: number;
      blockedAttemptCount: number;
      sessionCount: number | null;
      averageSessionMinutes: number | null;
      longestSessionMinutes: number | null;
      educationMinutes: number | null;
      gamingMinutes: number | null;
      socialMinutes: number | null;
      entertainmentMinutes: number | null;
    }>
  > {
    return this.prisma.dailyBehavioralSnapshot.findMany({
      where: { childId, usageDate: { gte: sinceDate } },
      orderBy: { usageDate: 'asc' },
      select: {
        usageDate: true,
        totalScreenMinutes: true,
        pickupCount: true,
        nightUsageMinutes: true,
        blockedAttemptCount: true,
        sessionCount: true,
        averageSessionMinutes: true,
        longestSessionMinutes: true,
        educationMinutes: true,
        gamingMinutes: true,
        socialMinutes: true,
        entertainmentMinutes: true,
      },
    });
  }

  async findSnapshotByDate(childId: string, usageDate: string): Promise<{
    totalScreenMinutes: number;
    pickupCount: number;
    nightUsageMinutes: number;
    sessionCount: number | null;
    averageSessionMinutes: number | null;
    longestSessionMinutes: number | null;
    educationMinutes: number | null;
    gamingMinutes: number | null;
    socialMinutes: number | null;
    entertainmentMinutes: number | null;
  } | null> {
    return this.prisma.dailyBehavioralSnapshot.findUnique({
      where: { childId_usageDate: { childId, usageDate: new Date(usageDate) } },
      select: {
        totalScreenMinutes: true,
        pickupCount: true,
        nightUsageMinutes: true,
        sessionCount: true,
        averageSessionMinutes: true,
        longestSessionMinutes: true,
        educationMinutes: true,
        gamingMinutes: true,
        socialMinutes: true,
        entertainmentMinutes: true,
      },
    });
  }

  async getTopAppsToday(childId: string, deviceId: string, date: Date, limit = 5): Promise<Array<{ packageName: string; minutes: number }>> {
    const rows = await this.prisma.appUsageLog.findMany({
      where: { childId, deviceId, usageDate: date },
      orderBy: { usageMinutes: 'desc' },
      take: limit,
      select: { packageName: true, usageMinutes: true },
    });
    return rows.map((r) => ({ packageName: r.packageName, minutes: r.usageMinutes }));
  }

  /** Sprint 14 — feeds AnomalyDetectionService's recurrence check.
   * Ordered MOST RECENT FIRST, matching that service's own documented
   * input contract exactly. */
  async findRecentPatterns(childId: string, asOfDate: Date, lookbackDays: number): Promise<string[][]> {
    const windowStart = new Date(asOfDate);
    windowStart.setDate(windowStart.getDate() - lookbackDays);

    const rows = await this.prisma.dailyBehavioralSnapshot.findMany({
      where: { childId, usageDate: { gte: windowStart, lte: asOfDate } },
      orderBy: { usageDate: 'desc' },
      select: { patterns: true },
    });

    return rows.map((r) => (Array.isArray(r.patterns) ? (r.patterns as string[]) : []));
  }
}
