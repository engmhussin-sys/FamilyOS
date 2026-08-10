import { Injectable } from '@nestjs/common';

import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import {
  IActivityLog,
  ICreateActivityLogInput,
  ICreateHydrationLogInput,
  ICreateNutritionLogInput,
  ICreateSleepLogInput,
  IHydrationLog,
  INutritionLog,
  ISleepLog,
} from '../../domain/health.types';

@Injectable()
export class PrismaHealthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createNutritionLog(input: ICreateNutritionLogInput): Promise<INutritionLog> {
    const row = await this.prisma.nutritionLog.create({
      data: {
        childId: input.childId,
        date: new Date(input.date),
        mealType: input.mealType,
        items: input.items as Prisma.InputJsonValue,
        calories: input.calories,
        proteinG: input.proteinG,
        calciumMg: input.calciumMg,
        ironMg: input.ironMg,
        sugarG: input.sugarG,
      },
    });
    return {
      id: row.id,
      childId: row.childId,
      date: row.date,
      mealType: row.mealType,
      items: row.items as Record<string, unknown>,
      calories: row.calories,
      proteinG: row.proteinG,
      calciumMg: row.calciumMg,
      ironMg: row.ironMg,
      sugarG: row.sugarG,
    };
  }

  async countNutritionLogsOnDate(childId: string, date: Date): Promise<number> {
    return this.prisma.nutritionLog.count({ where: { childId, date } });
  }

  async createHydrationLog(input: ICreateHydrationLogInput): Promise<IHydrationLog> {
    const row = await this.prisma.hydrationLog.create({ data: { childId: input.childId, amountMl: input.amountMl } });
    return { id: row.id, childId: row.childId, amountMl: row.amountMl, loggedAt: row.loggedAt };
  }

  async sumHydrationMlOnDate(childId: string, dayStart: Date, dayEnd: Date): Promise<number> {
    const result = await this.prisma.hydrationLog.aggregate({
      where: { childId, loggedAt: { gte: dayStart, lt: dayEnd } },
      _sum: { amountMl: true },
    });
    return result._sum.amountMl ?? 0;
  }

  /** Sprint 15 — CLOSES A REAL GAP: feeds streak calculation, which
   * needs to know EVERY day's total over a window, not just one
   * day's. Grouped in application code (not a raw SQL GROUP BY) —
   * this project's own established pattern for aggregations over a
   * bounded, small window (30 days max), matching
   * findSnapshotsInWindow's own style in the digital-wellbeing
   * repository. */
  async getDailyHydrationTotals(childId: string, since: Date): Promise<Map<string, number>> {
    const rows = await this.prisma.hydrationLog.findMany({
      where: { childId, loggedAt: { gte: since } },
      select: { loggedAt: true, amountMl: true },
    });
    const totals = new Map<string, number>();
    for (const row of rows) {
      const dateStr = row.loggedAt.toISOString().slice(0, 10);
      totals.set(dateStr, (totals.get(dateStr) ?? 0) + row.amountMl);
    }
    return totals;
  }

  async createSleepLog(input: ICreateSleepLogInput): Promise<ISleepLog> {
    const row = await this.prisma.sleepLog.create({
      data: {
        childId: input.childId,
        date: new Date(input.date),
        sleepStart: new Date(input.sleepStart),
        sleepEnd: new Date(input.sleepEnd),
        quality: input.quality,
      },
    });
    return {
      id: row.id,
      childId: row.childId,
      date: row.date,
      sleepStart: row.sleepStart,
      sleepEnd: row.sleepEnd,
      quality: row.quality,
    };
  }

  async findSleepLogForDate(childId: string, date: Date): Promise<ISleepLog | null> {
    const row = await this.prisma.sleepLog.findFirst({ where: { childId, date } });
    if (!row) return null;
    return {
      id: row.id,
      childId: row.childId,
      date: row.date,
      sleepStart: row.sleepStart,
      sleepEnd: row.sleepEnd,
      quality: row.quality,
    };
  }

  async createActivityLog(input: ICreateActivityLogInput): Promise<IActivityLog> {
    const row = await this.prisma.activityLog.create({
      data: {
        childId: input.childId,
        date: new Date(input.date),
        activityType: input.activityType,
        durationMinutes: input.durationMinutes,
        socialContext: input.socialContext ?? 'SOLO',
      },
    });
    return {
      id: row.id,
      childId: row.childId,
      date: row.date,
      activityType: row.activityType,
      durationMinutes: row.durationMinutes,
      socialContext: row.socialContext as IActivityLog['socialContext'],
    };
  }

  async sumActivityMinutesOnDate(childId: string, date: Date, groupOnly = false): Promise<number> {
    const result = await this.prisma.activityLog.aggregate({
      where: { childId, date, ...(groupOnly ? { socialContext: { in: ['GROUP', 'TEAM'] } } : {}) },
      _sum: { durationMinutes: true },
    });
    return result._sum.durationMinutes ?? 0;
  }

  /** Sprint 15 — CLOSES A REAL GAP: same reasoning as
   * getDailyHydrationTotals above, for Activity streak calculation. */
  async getDailyActivityTotals(childId: string, since: Date): Promise<Map<string, number>> {
    const rows = await this.prisma.activityLog.findMany({
      where: { childId, date: { gte: since } },
      select: { date: true, durationMinutes: true },
    });
    const totals = new Map<string, number>();
    for (const row of rows) {
      const dateStr = row.date.toISOString().slice(0, 10);
      totals.set(dateStr, (totals.get(dateStr) ?? 0) + row.durationMinutes);
    }
    return totals;
  }

  async countGroupActivitiesInWindow(childId: string, sinceDate: Date): Promise<number> {
    return this.prisma.activityLog.count({
      where: { childId, date: { gte: sinceDate }, socialContext: { in: ['GROUP', 'TEAM'] } },
    });
  }

  async upsertHealthScore(childId: string, date: Date, score: number, breakdown: Record<string, unknown>): Promise<void> {
    await this.prisma.healthScoreDaily.upsert({
      where: { childId_date: { childId, date } },
      create: { childId, date, score, breakdown: breakdown as Prisma.InputJsonValue },
      update: { score, breakdown: breakdown as Prisma.InputJsonValue },
    });
  }
}
