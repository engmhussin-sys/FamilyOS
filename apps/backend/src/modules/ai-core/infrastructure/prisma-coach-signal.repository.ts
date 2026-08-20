import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { FamilyDateService } from '../../../common/time/family-date.service';
import { ChildrenService } from '../../children/application/services/children.service';
import { ScreenTimeService } from '../../screen-time/application/services/screen-time.service';
import { ageBandFor } from '../domain/age-band';
import type { CoachSignals, ICoachSignalProvider } from '../domain/coach.types';

/** The two windows every rule in `coach-rules.ts` reasons over. Named once. */
const WINDOW_SHORT_DAYS = 7;
const WINDOW_BASELINE_DAYS = 28;

/**
 * B8 — THE COACH'S READ SIDE, AND ONLY ITS READ SIDE.
 *
 * EVERY QUERY IN THIS FILE IS `findMany` / `count`. There is no `create`, no
 * `update`, no `upsert`, no `delete`, and no raw-SQL escape hatch of any kind —
 * and `ai-boundary.spec.ts` scans this file, with the rest of
 * `modules/ai-core/**`, and fails the build if one appears. That is the
 * mechanism behind §2.2's «الـ AI منتج بيانات، لا عميل مميّز»: the coach can
 * SEE the whole family and can CHANGE nothing about it.
 *
 * (Aside worth keeping: an earlier draft of this docstring named the two tables
 * and the raw-query method in the same paragraph, and `ci:tenant-guard` flagged
 * the FILE for unscoped raw SQL — its RULE 2 reads a 25-line window and cannot
 * tell prose from code. The guard was right to be blunt; the comment is what
 * changed.)
 *
 * WHY IT READS THE PROGRAM AND HABIT TABLES DIRECTLY INSTEAD OF CALLING
 * `RewardProgramService`. Injecting those services would hand `ai-core` a
 * reference to objects carrying `create`, `grant` and `approve`. The boundary
 * would then rest on nobody ever calling them — a promise. Reading read-only
 * means the capability is absent from this module's object graph entirely,
 * which is the difference between §2.2's E2 (a module boundary) and a
 * code-review convention.
 *
 * BUSINESS DATES COME FROM `FamilyDateService` (B8 task 8; B1/B2's rule,
 * unchanged). "Today", "this week" and "28 days" below are all anchored to the
 * FAMILY's calendar. There is no `new Date()` day arithmetic in this file and
 * no `setHours(0,0,0,0)` anywhere — a household in Riyadh whose child finishes
 * a task at 01:00 local must not have it counted as yesterday because the
 * server happens to run in UTC.
 */
@Injectable()
export class PrismaCoachSignalRepository implements ICoachSignalProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly familyDate: FamilyDateService,
    private readonly children: ChildrenService,
    private readonly screenTime: ScreenTimeService,
  ) {}

  async build(childId: string, familyId: string, now: Date = new Date()): Promise<CoachSignals> {
    // Ownership first, and allowed to throw: a 404 for another family's child is
    // the right answer, and swallowing it into an empty coach card would be an
    // information leak wearing graceful degradation as a disguise.
    const child = await this.children.getChildOrThrow(childId, familyId);

    const businessDate = await this.familyDate.getBusinessDate(familyId, now);
    const todayRange = await this.familyDate.getBusinessDayRange(familyId, now);
    const date7 = await this.familyDate.businessDateDaysAgo(familyId, WINDOW_SHORT_DAYS - 1, now);
    const date28 = await this.familyDate.businessDateDaysAgo(familyId, WINDOW_BASELINE_DAYS - 1, now);
    const start7d = await this.familyDate.getStartOfBusinessDay(familyId, date7);
    const start28d = await this.familyDate.getStartOfBusinessDay(familyId, date28);
    const ageYears = await this.familyDate.ageInYears(familyId, child.dateOfBirth, now);

    const [policy, activeHabits, completions28d, completedToday, programs, achievements28d] = await Promise.all([
      this.screenTime.getPolicy(childId, familyId),
      this.prisma.habit.findMany({
        where: { childId, isActive: true, deletedAt: null },
        select: { id: true, title: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      this.prisma.habitCompletion.findMany({
        where: { childId, completedAt: { gte: start28d } },
        select: { completedAt: true, status: true, date: true },
      }),
      this.prisma.habitCompletion.count({
        where: {
          childId,
          completedAt: { gte: todayRange.start, lt: todayRange.endExclusive },
          status: { notIn: ['MISSED', 'SKIPPED'] },
        },
      }),
      this.prisma.rewardProgram.findMany({
        where: { childId, status: 'ACTIVE', archivedAt: null },
        select: { category: true, difficulty: true },
      }),
      this.prisma.achievementRequest.findMany({
        where: { childId, createdAt: { gte: start28d } },
        select: { status: true, createdAt: true, program: { select: { category: true } } },
      }),
    ]);

    const done28 = completions28d.filter((c) => c.status !== 'MISSED' && c.status !== 'SKIPPED');
    const done7 = done28.filter((c) => c.completedAt >= start7d);
    const missed7 = completions28d.filter(
      (c) => (c.status === 'MISSED' || c.status === 'SKIPPED') && c.completedAt >= start7d,
    );

    const byCategory: Record<string, number> = {};
    const byDifficulty: Record<string, number> = {};
    for (const p of programs) {
      byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
      byDifficulty[p.difficulty] = (byDifficulty[p.difficulty] ?? 0) + 1;
    }

    const verified28 = achievements28d.filter((a) => a.status === 'VERIFIED');
    const in7d = achievements28d.filter((a) => a.createdAt >= start7d);

    return {
      childId,
      familyId,
      ageYears,
      ageBand: ageBandFor(ageYears),
      businessDate,
      habits: {
        active: activeHabits.length,
        completed7d: done7.length,
        completed28d: done28.length,
        missed7d: missed7.length,
        completedToday,
        dueToday: activeHabits.length,
      },
      streak: this.streakFrom(done28, businessDate, completedToday),
      programs: {
        active: programs.length,
        byCategory: Object.freeze(byCategory),
        byDifficulty: Object.freeze(byDifficulty),
      },
      achievements: {
        verified7d: in7d.filter((a) => a.status === 'VERIFIED').length,
        rejected7d: in7d.filter((a) => a.status === 'REJECTED').length,
        submitted7d: in7d.filter((a) => a.status === 'SUBMITTED' || a.status === 'PENDING_PARENT').length,
        verified28d: verified28.length,
      },
      screenTime: {
        dailyLimitMinutes: policy?.dailyLimitMinutes ?? null,
        focusModeEnabled: policy?.focusModeEnabled ?? false,
      },
      interests: this.interestsFrom(verified28.map((a) => a.program?.category ?? null)),
      // UNTRUSTED — the one user-authored string in the whole signal set, and
      // the reason `prompt-safety.ts` exists. It is deliberately NOT sanitised
      // HERE: this layer's job is to report the stored value truthfully, and a
      // parent-facing screen may legitimately show a habit title verbatim.
      // Wrapping happens at the PROMPT boundary, in `ParentCoachService`, which
      // is the only place it is a prompt rather than data.
      topHabitTitles: Object.freeze(activeHabits.slice(0, 5).map((h) => h.title)),
    };
  }

  /**
   * The streak, computed from the family's own calendar DATES rather than from
   * timestamps. `habit_completions.date` is a `@db.Date` already written in the
   * family's business date by B1/B2's path (stored as UTC midnight, INTERPRETED
   * as a family-local day — `FamilyDateService.toDateColumn`'s stated
   * convention), so counting back over distinct date strings is both correct
   * and free of any UTC boundary question.
   */
  private streakFrom(
    completions: readonly { date: Date; status: string }[],
    businessDate: string,
    completedToday: number,
  ): CoachSignals['streak'] {
    const days = new Set(completions.map((c) => c.date.toISOString().slice(0, 10)));

    const shift = (iso: string, byDays: number): string => {
      const d = new Date(`${iso}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() + byDays);
      return d.toISOString().slice(0, 10);
    };

    // Start at YESTERDAY when nothing is recorded today: a live streak that has
    // not yet been extended today is still live — that is precisely the
    // `STREAK_AT_RISK` case, and starting at today would report it as broken
    // and send the parent the wrong card every single morning.
    let current = 0;
    for (let back = days.has(businessDate) ? 0 : 1; back < 400; back++) {
      if (!days.has(shift(businessDate, -back))) break;
      current++;
    }

    let best = 0;
    let run = 0;
    const sorted = [...days].sort();
    for (let i = 0; i < sorted.length; i++) {
      run = i > 0 && sorted[i] === shift(sorted[i - 1], 1) ? run + 1 : 1;
      best = Math.max(best, run);
    }

    return { currentDays: current, bestDays: Math.max(best, current), atRisk: current > 0 && completedToday === 0 };
  }

  /** "Interests" as this product can honestly know them: the categories the
   * child actually FINISHED, most-engaged first — never a self-declared
   * profile field, which nothing in the schema collects anyway. */
  private interestsFrom(categories: readonly (string | null)[]): readonly string[] {
    const counts = new Map<string, number>();
    for (const c of categories) {
      if (!c) continue;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return Object.freeze(
      [...counts.entries()]
        .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
        .slice(0, 5)
        .map(([code]) => code),
    );
  }
}
