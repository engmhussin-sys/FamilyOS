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
    return this.toDomain(row);
  }

  async findById(habitId: string): Promise<IHabit | null> {
    const row = await this.prisma.habit.findUnique({ where: { id: habitId } });
    return row ? this.toDomain(row) : null;
  }

  async listActiveForChild(childId: string): Promise<IHabit[]> {
    const rows = await this.prisma.habit.findMany({
      where: { childId, isActive: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toDomain(row));
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
  }): IHabit {
    return {
      id: row.id,
      childId: row.childId,
      title: row.title,
      category: row.category,
      isCustom: row.isCustom,
      isShared: row.isShared,
      isActive: row.isActive,
      createdAt: row.createdAt,
    };
  }
}
