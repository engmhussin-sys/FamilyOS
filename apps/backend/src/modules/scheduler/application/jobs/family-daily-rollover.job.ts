import { Injectable, Logger } from '@nestjs/common';

import { addBusinessDays } from '../../../../common/time/family-date';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { HabitEngineService } from '../../../life-intelligence/application/services/habit-engine.service';
import { computeCurrentStreak } from '../../../life-intelligence/application/services/streak-calculator';
import type { FamilyJobContext, FamilyJobDefinition, JobOutcome } from '../../domain/job.types';

export const FAMILY_DAILY_ROLLOVER_JOB = 'family-daily-rollover';

/**
 * A streak has to be worth something before its ending is worth reporting. Two
 * days is a coincidence; three is a habit the child would notice losing. The
 * same threshold the milestone list starts at (`STREAK_MILESTONES[0] === 3` in
 * `streak-detection.consumer.ts`), so «what counts as a streak» has one answer.
 */
export const STREAK_BREAK_MIN_LENGTH = 3;

/** How far back the streak that just ended is reconstructed from. */
const STREAK_LOOKBACK_DAYS = 120;

/**
 * PHASE C P4 — THE DAILY ROLLOVER, ON THE FAMILY'S CALENDAR.
 *
 * WHAT WAS BROKEN BY ITS ABSENCE — a measurement, not a worry:
 *
 *   `habit_completions.status` has had `MISSED` in its vocabulary since Sprint
 *   16, and `HabitEngineService.markMissedHabits()` has existed to write it,
 *   and the ONLY caller in the entire repository is an HTTP route a parent
 *   would have to invoke by hand, per child, per day
 *   (`life-intelligence.controller.ts:93`). So in production no `MISSED` row
 *   has ever been written. Which means `getMissedHabitsSignal()` returns an
 *   empty list forever; which means the Coach rule `MISSED_DAYS_PATTERN`
 *   (`coach-rules.ts:130`) can never fire; which means one of the AI Coach's
 *   named behaviours was unreachable — not broken, UNREACHABLE — and no test
 *   could have caught it because every test that exercises it calls
 *   `markMissedHabits` itself.
 *
 *   A broken streak was likewise invisible. `STREAK_ACHIEVED` is emitted by a
 *   consumer of `HABIT_COMPLETED`, so a streak's END — which is by definition
 *   the absence of a completion — has no event to ride on. Nothing anywhere
 *   noticed.
 *
 * WHY IT IS FAMILY-SCOPED AND WHAT THAT COSTS. Both of the above are
 * JUDGEMENTS ABOUT A DAY THAT IS OVER, and a day is over on the family's clock.
 * Running this on the server's calendar would mark a Cairo child's habits
 * MISSED while the child was still living that evening. So the job does not run
 * "at 02:00"; it runs for each family at ITS 02:00, which means a Riyadh family
 * and a Cairo family roll over at DIFFERENT INSTANTS for most of the year and
 * at the same instant for the rest — because Egypt observes DST and Saudi
 * Arabia does not, a fact this code reads from tzdata rather than remembering.
 * `test/scheduler/family-rollover-timezone.e2e.spec.ts` executes both halves of
 * that sentence.
 *
 * TENANCY. The runner has already entered `runWithTenant({ familyId })` before
 * `handler` is called, exactly as `OutboxRelay.dispatch` does before a
 * consumer. Everything below therefore runs under the ordinary extension with
 * deny-by-default intact: this job cannot touch another household's habits even
 * though the sweep that scheduled it enumerated every household.
 */
@Injectable()
export class FamilyDailyRolloverJob {
  private readonly logger = new Logger(FamilyDailyRolloverJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly habits: HabitEngineService,
  ) {}

  definition(): FamilyJobDefinition {
    return {
      name: FAMILY_DAILY_ROLLOVER_JOB,
      scope: 'FAMILY',
      description:
        'تدوير اليوم لكل أسرة على تقويمها المحلّي: تعليم العادات غير المنجَزة أمس كـ MISSED، ورصد انكسار السلاسل.',
      handler: (ctx) => this.run(ctx),
    };
  }

  /**
   * IDEMPOTENT AT TWO LEVELS, on purpose, because one would have been enough
   * only until the first operator pressed «Run now» twice:
   *
   *   1. `job_runs (job_name, family_id, business_date)` is UNIQUE, so the
   *      second attempt at the same family-day never reaches this method at
   *      all — the database refuses it.
   *   2. The BODY is independently idempotent anyway.
   *      `markMissedHabitsForDate` writes through
   *      `habit_completions (habit_id, date)` UNIQUE with `skipDuplicates`, so
   *      running it twice writes the same rows once, and a real completion
   *      that lands between the two reads wins rather than being overwritten.
   *      Streak-break detection is a pure recomputation over the completion
   *      rows — same rows in, same answer out — and writes nothing.
   *
   * Level 2 is what makes level 1 safe to bypass for a manual re-run, and it
   * is what would still be true if someone deleted the unique index. Defence
   * that survives its own removal is the only kind worth documenting.
   */
  async run(ctx: FamilyJobContext): Promise<JobOutcome> {
    const children = await this.activeChildren(ctx.familyId);

    let missed = 0;
    let streaksBroken = 0;

    for (const childId of children) {
      missed += await this.habits.markMissedHabits(childId, ctx.familyId, ctx.businessDate);
      if (await this.streakBrokeOn(childId, ctx.businessDate)) streaksBroken += 1;
    }

    if (missed > 0 || streaksBroken > 0) {
      // Counts and one family id prefix. No child id, no habit title, nothing
      // a log aggregator would turn into a profile.
      this.logger.log(
        `rollover.completed family=${ctx.familyId.slice(0, 8)} tz=${ctx.timeZone} businessDate=${ctx.businessDate} children=${children.length} missed=${missed} streaksBroken=${streaksBroken}`,
      );
    }

    return {
      affectedRows: missed,
      details: {
        children: children.length,
        habits_marked_missed: missed,
        streaks_broken: streaksBroken,
      },
    };
  }

  /**
   * DID A STREAK OF AT LEAST `STREAK_BREAK_MIN_LENGTH` DAYS END ON
   * `businessDate`?
   *
   * Computed, never stored, and the distinction matters: there is no
   * `current_streak` column anywhere in this schema, and adding one would
   * create a counter that at-least-once delivery and manual re-runs would both
   * be able to push out of step. Instead the question is answered from the
   * completion rows themselves — «the streak ending the day BEFORE this one was
   * >= 3, and this day has no qualifying completion» — which is a pure function
   * of rows that are already the source of truth.
   *
   * Note the direction: this asks about the day that has just CLOSED. Asking
   * about "today" would be asking whether a day still in progress has been
   * missed, which is the same error `markMissedHabits` exists to avoid.
   */
  private async streakBrokeOn(childId: string, businessDate: string): Promise<boolean> {
    const since = new Date(`${addBusinessDays(businessDate, -STREAK_LOOKBACK_DAYS)}T00:00:00.000Z`);
    const qualifyingDays = await this.habitRepo().findDistinctCompletionDates(childId, since);

    if (qualifyingDays.includes(businessDate)) return false;
    const previous = computeCurrentStreak(qualifyingDays, addBusinessDays(businessDate, -1));
    return previous >= STREAK_BREAK_MIN_LENGTH;
  }

  /**
   * The family's live children. Read under the ambient TENANT context the
   * runner established, so the extension pins it to this household — there is
   * no `runAsSystem` here and there must not be.
   */
  private async activeChildren(familyId: string): Promise<string[]> {
    const rows = await this.prismaModels().child.findMany({
      where: { familyId, deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r: { id: string }) => r.id);
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private prismaModels(): { child: any; habitCompletion: any } {
    return this.prisma as any;
  }

  /**
   * The streak read goes straight to Prisma rather than through
   * `HabitEngineService.getScoreBreakdown`, and that is deliberate: the
   * breakdown computes the streak AS OF TODAY, and this job needs it as of the
   * day that just closed. Reusing the wrong window would have produced an
   * answer that looks right and is off by one day for every family east of the
   * date line at rollover time.
   */
  private habitRepo(): { findDistinctCompletionDates(childId: string, since: Date): Promise<string[]> } {
    const prisma = this.prismaModels();
    return {
      findDistinctCompletionDates: async (childId: string, since: Date): Promise<string[]> => {
        const rows = await prisma.habitCompletion.findMany({
          where: { childId, date: { gte: since }, status: { in: ['COMPLETED', 'COMPLETED_LATE'] } },
          select: { date: true },
          distinct: ['date'],
        });
        // `@db.Date` already holds a business date — the engine decided which
        // day it was on the family calendar before writing it. Re-projecting it
        // through a timezone here would shift every stored day by one for every
        // family east of UTC. Same note as `prisma-habit.repository.ts:152`.
        return rows.map((r: { date: Date }) => r.date.toISOString().slice(0, 10));
      },
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
