import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { IHabit, IHabitCompletion, ICreateHabitInput, HabitCompletionStatus } from '../../domain/habit.types';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';

@Injectable()
export class PrismaHabitRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: ICreateHabitInput): Promise<IHabit> {
    const row = await this.prisma.habit.create({
      data: {
        familyId: tenantIdForWrite(),
        childId: input.childId,
        title: input.title,
        category: input.category,
        description: input.description,
        scheduledStartTime: input.scheduledStartTime,
        scheduledEndTime: input.scheduledEndTime,
        recurrence: input.recurrence ?? 'DAILY',
        recurrenceDaysOfWeek: input.recurrenceDaysOfWeek ?? [],
        priority: input.priority ?? 'NORMAL',
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

  /** B2: `todayDate` is the FAMILY's business day, anchored to the UTC midnight
   * the `@db.Date` column stores it at. It is a parameter rather than something
   * this repository computes, because a repository has no family context and
   * the previous private `todayDateOnly()` therefore answered in UTC. */
  async listActiveForChild(childId: string, todayDate: Date): Promise<IHabit[]> {
    const [rows, todaysCompletions] = await Promise.all([
      this.prisma.habit.findMany({
        where: { childId, isActive: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      // One query for ALL of today's completions for this child, not
      // one query per habit — avoids the N+1 this could otherwise be.
      this.prisma.habitCompletion.findMany({
        where: { childId, date: todayDate },
        select: { habitId: true },
      }),
    ]);
    const completedHabitIds = new Set(todaysCompletions.map((c: { habitId: string }) => c.habitId));
    return rows.map((row: any) => this.toDomain(row, completedHabitIds.has(row.id)));
  }

  /** Upsert-by-day semantics: completing an already-completed habit for
   * the same date is idempotent (the unique constraint on
   * [habitId, date] enforces this at the database level, not just in
   * application logic that could be bypassed by a concurrent request).
   * Sprint 16 — status now flows through explicitly (COMPLETED by
   * default, or COMPLETED_LATE when the caller determines the
   * scheduled window already passed). */
  async recordCompletion(habitId: string, childId: string, date: Date, status: HabitCompletionStatus = 'COMPLETED'): Promise<IHabitCompletion> {
    const row = await this.prisma.habitCompletion.upsert({
      where: { habitId_date: { habitId, date } },
      create: { familyId: tenantIdForWrite(), habitId, childId, date, status },
      update: { status },
    });
    return {
      id: row.id,
      habitId: row.habitId,
      childId: row.childId,
      date: row.date,
      completedAt: row.completedAt,
      status: row.status as HabitCompletionStatus,
    };
  }

  /** Sprint 16 — CLOSES A REAL GAP (Missed Habit tracking, explicitly
   * flagged as unbuilt in Sprint 15's own final report). Marks every
   * ACTIVE habit that has NO completion row at all for `date` as
   * MISSED for that date — a real, queryable record, not just an
   * absence a caller has to infer. Idempotent: running this twice
   * for the same date is safe (skipHabitIds already-processed habits
   * are simply skipped again, no duplicate rows possible thanks to
   * the same [habitId, date] unique constraint recordCompletion
   * relies on). */
  async markMissedHabitsForDate(childId: string, date: Date): Promise<number> {
    const [activeHabits, existingCompletions] = await Promise.all([
      this.prisma.habit.findMany({ where: { childId, isActive: true, deletedAt: null }, select: { id: true } }),
      this.prisma.habitCompletion.findMany({ where: { childId, date }, select: { habitId: true } }),
    ]);
    const alreadyRecorded = new Set(existingCompletions.map((c: { habitId: string }) => c.habitId));
    const missedHabitIds = activeHabits.map((h: { id: string }) => h.id).filter((id: string) => !alreadyRecorded.has(id));

    if (missedHabitIds.length === 0) return 0;

    await this.prisma.habitCompletion.createMany({
      data: missedHabitIds.map((habitId: string) => ({ familyId: tenantIdForWrite(), habitId, childId, date, status: 'MISSED' as const })),
      skipDuplicates: true, // defense-in-depth against a race with a real completion landing between the two reads above
    });
    return missedHabitIds.length;
  }

  /** Sprint 16 — the Coaching-facing read side: recent missed habits
   * as a SIGNAL, never exposed as a punishment/scoring mechanism (the
   * brief's own explicit instruction — this method just returns
   * facts; what a caller does with them is that caller's decision). */
  async findMissedHabitsInWindow(childId: string, sinceDate: Date): Promise<Array<{ habitId: string; habitTitle: string; date: Date }>> {
    const rows = await this.prisma.habitCompletion.findMany({
      where: { childId, date: { gte: sinceDate }, status: 'MISSED' },
      include: { habit: { select: { title: true } } },
      orderBy: { date: 'desc' },
    });
    return rows.map((r: any) => ({ habitId: r.habitId, habitTitle: r.habit.title, date: r.date }));
  }

  async countCompletionsInWindow(childId: string, sinceDate: Date, sharedOnly = false): Promise<number> {
    return this.prisma.habitCompletion.count({
      where: {
        childId,
        date: { gte: sinceDate },
        status: { in: ['COMPLETED', 'COMPLETED_LATE'] },
        ...(sharedOnly ? { habit: { isShared: true } } : {}),
      },
    });
  }

  async countActiveHabits(childId: string, sharedOnly = false): Promise<number> {
    return this.prisma.habit.count({
      where: { childId, isActive: true, deletedAt: null, ...(sharedOnly ? { isShared: true } : {}) },
    });
  }

  /** Sprint 16 — distinct dates (any habit) with a real completion in
   * the window, feeding streak calculation (which needs to know WHICH
   * days qualified, not just a count). */
  async findDistinctCompletionDates(childId: string, since: Date): Promise<string[]> {
    const rows = await this.prisma.habitCompletion.findMany({
      where: { childId, date: { gte: since }, status: { in: ['COMPLETED', 'COMPLETED_LATE'] } },
      select: { date: true },
      distinct: ['date'],
    });
    // B2, DELIBERATELY LEFT AS-IS: `HabitCompletion.date` is a `@db.Date`
    // column that ALREADY holds a business date (the engine decided which day
    // it was, on the family calendar, before writing it). Re-projecting it
    // through a timezone here would shift every stored day by one for any
    // family east of UTC. `toISOString().slice(0, 10)` is the correct way to
    // read a `@db.Date` back, not a UTC "today" calculation.
    return rows.map((r: { date: Date }) => r.date.toISOString().slice(0, 10));
  }

  private toDomain(row: {
    id: string;
    childId: string;
    title: string;
    category: string;
    description: string | null;
    scheduledStartTime: string | null;
    scheduledEndTime: string | null;
    recurrence: string;
    recurrenceDaysOfWeek: number[];
    priority: string;
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
      description: row.description,
      scheduledStartTime: row.scheduledStartTime,
      scheduledEndTime: row.scheduledEndTime,
      recurrence: row.recurrence as IHabit['recurrence'],
      recurrenceDaysOfWeek: row.recurrenceDaysOfWeek,
      priority: row.priority as IHabit['priority'],
      isCustom: row.isCustom,
      isShared: row.isShared,
      isActive: row.isActive,
      createdAt: row.createdAt,
      completedToday,
    };
  }
}
