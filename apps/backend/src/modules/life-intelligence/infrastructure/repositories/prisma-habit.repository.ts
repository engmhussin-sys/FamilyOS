import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { IHabit, IHabitCompletion, ICreateHabitInput } from '../../domain/habit.types';

@Injectable()
export class PrismaHabitRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: ICreateHabitInput): Promise<IHabit> {
    const row = await this.prisma.habit.create({
      data: {
        childId: input.childId,
        title: input.title,
        category: input.category,
        isShared: input.isShared ?? false,
        isCustom: true,
        createdByUserId: input.createdByUserId,
      },
    });
    // A just-created habit cannot have a completion yet — false is
    // certain here, not a guess.
    return this.toDomain(row, false);
  }

  async findById(habitId: string): Promise<IHabit | null> {
    const row = await this.prisma.habit.findUnique({ where: { id: habitId } });
    // Only used internally for ownership checks today (completeHabit's
    // own childId comparison) — none of its callers read
    // completedToday, so this default avoids an unnecessary extra
    // query rather than computing a value nothing uses yet.
    return row ? this.toDomain(row, false) : null;
  }

  async listActiveForChild(childId: string): Promise<IHabit[]> {
    const [rows, todaysCompletions] = await Promise.all([
      this.prisma.habit.findMany({
        where: { childId, isActive: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      // One query for ALL of today's completions for this child, not
      // one query per habit — avoids the N+1 this could otherwise be.
      this.prisma.habitCompletion.findMany({
        where: { childId, date: this.todayDateOnly() },
        select: { habitId: true },
      }),
    ]);
    const completedHabitIds = new Set(todaysCompletions.map((c: { habitId: string }) => c.habitId));
    return rows.map((row: { id: string }) => this.toDomain(row as any, completedHabitIds.has(row.id)));
  }

  /** Matches completeHabit's own date-normalization exactly (UTC
   * midnight) — the same convention HabitEngineService.today() uses,
   * so "today" here and "today" at write time always agree. */
  private todayDateOnly(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  /** Upsert-by-day semantics: completing an already-completed habit for
   * the same date is idempotent (the unique constraint on
   * [habitId, date] enforces this at the database level, not just in
   * application logic that could be bypassed by a concurrent request). */
  async recordCompletion(habitId: string, childId: string, date: Date): Promise<IHabitCompletion> {
    const row = await this.prisma.habitCompletion.upsert({
      where: { habitId_date: { habitId, date } },
      create: { habitId, childId, date },
      update: {},
    });
    return {
      id: row.id,
      habitId: row.habitId,
      childId: row.childId,
      date: row.date,
      completedAt: row.completedAt,
    };
  }

  async countCompletionsInWindow(childId: string, sinceDate: Date, sharedOnly = false): Promise<number> {
    return this.prisma.habitCompletion.count({
      where: {
        childId,
        date: { gte: sinceDate },
        ...(sharedOnly ? { habit: { isShared: true } } : {}),
      },
    });
  }

  async countActiveHabits(childId: string, sharedOnly = false): Promise<number> {
    return this.prisma.habit.count({
      where: { childId, isActive: true, deletedAt: null, ...(sharedOnly ? { isShared: true } : {}) },
    });
  }

  private toDomain(row: {
    id: string;
    childId: string;
    title: string;
    category: string;
    isCustom: boolean;
    isShared: boolean;
    isActive: boolean;
    createdAt: Date;
  }, completedToday: boolean): IHabit {
    return {
      id: row.id,
      childId: row.childId,
      title: row.title,
      category: row.category,
      isCustom: row.isCustom,
      isShared: row.isShared,
      isActive: row.isActive,
      createdAt: row.createdAt,
      completedToday,
    };
  }
}
