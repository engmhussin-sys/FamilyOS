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
