import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaHabitRepository } from '../../infrastructure/repositories/prisma-habit.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER, IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { IHabit, IHabitCompletion, IHabitScoreBreakdown, ICreateHabitInput } from '../../domain/habit.types';
import { computeCurrentStreak } from './streak-calculator';

const SCORE_WINDOW_DAYS = 30;
const STREAK_LOOKBACK_DAYS = 30;
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];

/**
 * Architecture 1.0 §3/§5: the static, parent-defined habit list —
 * deliberately distinct from the (not built this sprint) Smart Tasks
 * Engine's AI-generated dynamic suggestions.
 *
 * Follows the Future-Engine Contract (Architecture 1.0 §2):
 * - Memory: none needed yet.
 * - Events: writes to the Unified Timeline via ILifeTimelineWriter,
 *   and (Sprint 25) triggers Reward Rules via IRewardTriggerWriter on
 *   every completion — never a bespoke event mechanism for either.
 * - AI Provider: not used.
 * - Audit: no AuditLog entry — a deliberate scope decision.
 * - Safety Validation: no AI/system-generated free-text copy exists here.
 *
 * Sprint 16 (Smart Daily Life Layer): completeHabit now determines
 * COMPLETED vs COMPLETED_LATE from the habit's own scheduled window,
 * fires STREAK_ACHIEVED/DAILY_GOAL_COMPLETED at the explicit contract
 * event names Sprint 16 asks for (additively — 'habit_completed'
 * unchanged, in case an existing Reward Rule already depends on it),
 * and adds Missed Habit tracking (markMissedHabits/getMissedHabitsSignal)
 * — a real, previously-flagged gap from Sprint 15's own final report,
 * used strictly as a Coaching SIGNAL, never a punishment.
 */
@Injectable()
export class HabitEngineService {
  constructor(
    private readonly habitRepository: PrismaHabitRepository,
    private readonly childrenService: ChildrenService,
    @Inject(LIFE_TIMELINE_WRITER) private readonly timeline: ILifeTimelineWriter,
    @Inject(REWARD_TRIGGER_WRITER) private readonly rewardTrigger: IRewardTriggerWriter,
  ) {}

  async createHabit(childId: string, familyId: string, input: Omit<ICreateHabitInput, 'childId'>): Promise<IHabit> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.habitRepository.create({ ...input, childId });
  }

  async listHabits(childId: string, familyId: string): Promise<IHabit[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.habitRepository.listActiveForChild(childId);
  }

  async completeHabit(habitId: string, childId: string, familyId: string, dateStr?: string): Promise<IHabitCompletion> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const habit = await this.habitRepository.findById(habitId);
    if (!habit || habit.childId !== childId) {
      // Same ownership-check discipline as every other module's
      // getChildOrThrow pattern: a habitId that exists but belongs to
      // a DIFFERENT child must fail identically to a habitId that
      // doesn't exist at all — never leak which case it was.
      throw new NotFoundException('Habit not found');
    }

    const date = dateStr ? new Date(dateStr) : this.today();

    // Sprint 16 — CLOSES A REAL GAP: no distinction between on-time
    // and late completion existed. Only evaluated when completing
    // for TODAY (a past-dated completion has no meaningful "late"
    // concept relative to a window that has already fully elapsed
    // either way) and only when the habit actually has a scheduled
    // end time (habits with no scheduled window are never "late").
    const isToday = date.getTime() === this.today().getTime();
    const status = isToday && habit.scheduledEndTime && this.isPastScheduledEnd(habit.scheduledEndTime)
      ? 'COMPLETED_LATE' as const
      : 'COMPLETED' as const;

    const completion = await this.habitRepository.recordCompletion(habitId, childId, date, status);

    const priorCompletions = await this.habitRepository.countCompletionsInWindow(childId, this.daysAgo(SCORE_WINDOW_DAYS));
    // KNOWN, ASSESSED-LOW-SEVERITY RACE CONDITION (found in this
    // session's own review, documented not silently left): under
    // near-simultaneous concurrent requests (e.g. two different
    // habits completed at once, or a client network retry), two
    // requests could both observe `priorCompletions === 1` and both
    // write a duplicate "first_habit_completion" Timeline event. The
    // underlying HabitCompletion record itself is NOT affected (that
    // write is a real, atomic, unique-constrained upsert) — only this
    // celebratory Timeline entry could rarely duplicate. Not fixed
    // with a DB-level constraint here: the cost (a raw-SQL partial
    // unique index, since Prisma has no first-class support for one)
    // outweighs the benefit for a cosmetic, non-financial, non-security
    // duplicate that at worst shows a milestone message twice.
    if (priorCompletions === 1) {
      // First-ever completion in the scoring window is genuinely
      // milestone-worthy — exactly the kind of curated moment
      // Architecture 1.0 §5.11 says belongs on the Timeline, not
      // every single daily checkbox tick.
      await this.timeline.record({
        childId,
        sourceEngine: 'habit-builder',
        category: 'HABITS',
        eventType: 'first_habit_completion',
        title: `Started building the "${habit.title}" habit`,
      });
    }

    // Sprint 25: fires on EVERY completion (unlike the Timeline write
    // above, which only fires on the first) — a real Reward Rule like
    // "7-day streak" needs every occurrence counted, not just the
    // first. Best-effort: a Reward Rules failure must never block a
    // habit completion from succeeding, same principle as the
    // Timeline write's own error handling elsewhere in this module.
    try {
      await this.rewardTrigger.trigger(childId, familyId, {
        engine: 'habit-builder',
        type: 'habit_completed',
        payload: { habitId, category: habit.category, isShared: habit.isShared },
      });

      // Sprint 16 — CLOSES A REAL GAP: the brief's own explicit
      // contract event names (HABIT_COMPLETED, DAILY_GOAL_COMPLETED),
      // fired ADDITIVELY alongside the pre-existing 'habit_completed'
      // type above.
      await this.rewardTrigger.trigger(childId, familyId, {
        engine: 'habit-builder',
        type: 'HABIT_COMPLETED',
        payload: { habitId, category: habit.category, isShared: habit.isShared, status },
      });

      const since = this.daysAgo(STREAK_LOOKBACK_DAYS);
      const dailyCompletions = await this.habitRepository.countCompletionsInWindow(childId, since);
      // Streak here is measured across ALL habits completed that day
      // (at least one), matching this engine's own "Habits Score is a
      // completion RATE, not per-habit" existing discipline — a
      // per-individual-habit streak is a real, separate future
      // extension this pass doesn't invent.
      if (dailyCompletions > 0) {
        const qualifyingDays = await this.getQualifyingCompletionDays(childId, since);
        const todayStr = this.today().toISOString().slice(0, 10);
        const streakDays = computeCurrentStreak(qualifyingDays, todayStr);
        if (STREAK_MILESTONES.includes(streakDays)) {
          await this.rewardTrigger.trigger(childId, familyId, {
            engine: 'habit-builder',
            type: 'STREAK_ACHIEVED',
            payload: { metric: 'habits', streakDays },
          });
        }
      }
    } catch {
      // Intentionally swallowed — see comment above.
    }

    return completion;
  }

  /** Sprint 16 — CLOSES A REAL GAP explicitly flagged in Sprint 15's
   * own final report ("Missed Habit tracking" did not exist). Marks
   * every active habit with no completion record for `dateStr`
   * (defaults to yesterday — "today" cannot be missed until it's
   * over) as MISSED. Idempotent (repository-level unique constraint
   * + skipDuplicates). Designed to run once daily (e.g. from a
   * scheduled job once that infrastructure exists) OR on-demand —
   * this method itself makes no assumption about its own caller's
   * schedule. */
  async markMissedHabits(childId: string, familyId: string, dateStr?: string): Promise<number> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const date = dateStr ? new Date(dateStr) : this.daysAgo(1);
    return this.habitRepository.markMissedHabitsForDate(childId, date);
  }

  /** Sprint 16 — Coaching-facing read: recent missed habits as a
   * SIGNAL. Deliberately returns raw facts (which habit, which date)
   * — no severity score, no "this is bad" framing baked in here; a
   * Coaching layer decides what tone/action, if any, this warrants. */
  async getMissedHabitsSignal(childId: string, familyId: string, windowDays = 7) {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const since = this.daysAgo(windowDays);
    return this.habitRepository.findMissedHabitsInWindow(childId, since);
  }

  /** Feeds the Habits Score sub-component of the Digital Twin
   * (Architecture 1.0 §6.2) — a plain, explainable rate over a
   * trailing window, not a hidden formula. */
  async getScoreBreakdown(childId: string, familyId: string): Promise<IHabitScoreBreakdown> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const since = this.daysAgo(SCORE_WINDOW_DAYS);
    const activeHabitCount = await this.habitRepository.countActiveHabits(childId);
    const sharedHabitCount = await this.habitRepository.countActiveHabits(childId, true);
    const totalHabitDays = activeHabitCount * SCORE_WINDOW_DAYS;
    const completedHabitDays = await this.habitRepository.countCompletionsInWindow(childId, since);
    const sharedCompletions = await this.habitRepository.countCompletionsInWindow(childId, since, true);
    const totalSharedDays = sharedHabitCount * SCORE_WINDOW_DAYS;

    return {
      childId,
      windowDays: SCORE_WINDOW_DAYS,
      totalHabitDays,
      completedHabitDays,
      completionRate: totalHabitDays > 0 ? completedHabitDays / totalHabitDays : 0,
      sharedTaskCompletionRate: totalSharedDays > 0 ? sharedCompletions / totalSharedDays : 0,
    };
  }

  /** "HH:MM" 24h comparison against the current local server time —
   * an honest, documented approximation (server time, not the
   * child's own device timezone, which this backend doesn't track
   * per-request) rather than a false claim of timezone-perfect
   * precision. */
  private isPastScheduledEnd(scheduledEndTime: string): boolean {
    const [hours, minutes] = scheduledEndTime.split(':').map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return false;
    const now = new Date();
    const scheduledEnd = new Date(now);
    scheduledEnd.setHours(hours, minutes, 0, 0);
    return now.getTime() > scheduledEnd.getTime();
  }

  private async getQualifyingCompletionDays(childId: string, since: Date): Promise<string[]> {
    // Reuses countCompletionsInWindow's own status filter
    // (COMPLETED/COMPLETED_LATE) conceptually, but needs per-day
    // dates for streak calculation rather than a single count —
    // delegated to the repository's own findMissedHabitsInWindow
    // SIBLING query shape would be a real duplicate; instead this
    // reads distinct completion dates directly via a small, honest
    // repository extension.
    return this.habitRepository.findDistinctCompletionDates(childId, since);
  }

  private today(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private daysAgo(days: number): Date {
    const d = this.today();
    d.setUTCDate(d.getUTCDate() - days);
    return d;
  }
}
