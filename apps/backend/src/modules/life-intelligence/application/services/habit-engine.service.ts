import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { GrowthEventEmitter } from '../../../analytics/application/growth-event-emitter.service';
import { PrismaHabitRepository } from '../../infrastructure/repositories/prisma-habit.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER, IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { IHabit, IHabitCompletion, IHabitScoreBreakdown, ICreateHabitInput } from '../../domain/habit.types';
import { computeCurrentStreak } from './streak-calculator';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { getBusinessDate, getBusinessTimeHHMM, isBusinessDate } from '../../../../common/time/family-date';

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
 *
 * B1+B2 (PA-B-001 · PA-B-004): every "today" in this file used to be UTC
 * midnight, and `isPastScheduledEnd` used the CONTAINER's local clock — two
 * different bugs in one class. Both now go through `FamilyDateService`, so a
 * habit completed at 00:30 in Cairo counts for today rather than yesterday and
 * a 21:00 scheduled window is 21:00 where the child lives.
 *
 * AND `dateStr` IS NO LONGER A DEVICE INPUT. `POST /self/habits/:id/complete`
 * accepted `date` from the child's device and fed it into the reward
 * idempotency key (`habit-completion:{habitId}:{date}`) — PA-B-004, the same
 * exploit as PA-B-003 but outside `/events/batch` and outside its throttler.
 * A back-dated completion is now a PARENT privilege: `completeHabit` takes an
 * explicit `actor`, and a DEVICE actor's date is derived, never supplied.
 */
@Injectable()
export class HabitEngineService {
  constructor(
    private readonly habitRepository: PrismaHabitRepository,
    private readonly childrenService: ChildrenService,
    @Inject(LIFE_TIMELINE_WRITER) private readonly timeline: ILifeTimelineWriter,
    @Inject(REWARD_TRIGGER_WRITER) private readonly rewardTrigger: IRewardTriggerWriter,
    private readonly familyDate: FamilyDateService,
    /** PHASE D (GROWTH). See `createHabit`. */
    private readonly growthEvents: GrowthEventEmitter,
  ) {}

  async createHabit(childId: string, familyId: string, input: Omit<ICreateHabitInput, 'childId'>): Promise<IHabit> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const habit = await this.habitRepository.create({ ...input, childId });

    /**
     * PHASE D (GROWTH) — the FIRST_GOAL funnel step.
     *
     * «A goal» is a product concept spanning habits, tasks, learning goals and
     * reward programs, and the funnel counts households that created ANY of
     * them. Emitting one event name from all four producers is what makes that
     * one query instead of a UNION over four tables that will become five.
     * `goalKind` is the discriminator; the habit's id and name are not sent.
     */
    await this.growthEvents.emit({
      name: 'GOAL_CREATED',
      familyId,
      sessionId: `goals:${familyId}`,
      payload: { goalKind: 'HABIT' },
    });

    return habit;
  }

  async listHabits(childId: string, familyId: string): Promise<IHabit[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    // B2: "is this habit already done today?" is answered on the family
    // calendar, so the Child App's Today screen stops showing a completed
    // habit as outstanding for the three hours after local midnight.
    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const today = FamilyDateService.toDateColumn(getBusinessDate(new Date(), timeZone));
    return this.habitRepository.listActiveForChild(childId, today);
  }

  /**
   * B1 (PA-B-004). `actor` decides whether `dateStr` is even looked at.
   *
   *   'DEVICE' — the child's own app. The date is DERIVED from the family
   *              calendar and `dateStr` is ignored entirely. This is what
   *              closes the second entry point to the replay exploit: the
   *              idempotency key below is `habit-completion:{habitId}:{day}`,
   *              and a device that chose `{day}` chose the key.
   *   'PARENT' — an authenticated parent session, which may legitimately
   *              back-fill a missed day. Bounded to the last 30 days and never
   *              into the future, so "back-fill" cannot become "mint 200 keys".
   *
   * The default is 'DEVICE' — the safe side — so a future call site that
   * forgets to declare an actor gets the derived date rather than the
   * caller-chosen one.
   */
  async completeHabit(
    habitId: string,
    childId: string,
    familyId: string,
    dateStr?: string,
    actor: 'PARENT' | 'DEVICE' = 'DEVICE',
  ): Promise<IHabitCompletion> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const habit = await this.habitRepository.findById(habitId);
    if (!habit || habit.childId !== childId) {
      // Same ownership-check discipline as every other module's
      // getChildOrThrow pattern: a habitId that exists but belongs to
      // a DIFFERENT child must fail identically to a habitId that
      // doesn't exist at all — never leak which case it was.
      throw new NotFoundException('Habit not found');
    }

    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const now = new Date();
    const todayStr = getBusinessDate(now, timeZone);
    const businessDate = this.resolveCompletionDate(dateStr, todayStr, actor, timeZone);
    const date = FamilyDateService.toDateColumn(businessDate);

    // Sprint 16 — CLOSES A REAL GAP: no distinction between on-time
    // and late completion existed. Only evaluated when completing
    // for TODAY (a past-dated completion has no meaningful "late"
    // concept relative to a window that has already fully elapsed
    // either way) and only when the habit actually has a scheduled
    // end time (habits with no scheduled window are never "late").
    const isToday = businessDate === todayStr;
    const status = isToday && habit.scheduledEndTime && this.isPastScheduledEnd(habit.scheduledEndTime, now, timeZone)
      ? 'COMPLETED_LATE' as const
      : 'COMPLETED' as const;

    const completion = await this.habitRepository.recordCompletion(habitId, childId, date, status);

    const priorCompletions = await this.habitRepository.countCompletionsInWindow(childId, this.daysAgo(SCORE_WINDOW_DAYS, timeZone));
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
      // Sprint 16.1 (Double Reward Protection): idempotencyKey is
      // habitId+date — the SAME habit completed twice for the SAME
      // date (a retry, a duplicate client request, or two concurrent
      // taps) must grant this reward exactly once, matching
      // recordCompletion's own [habitId, date] uniqueness at the
      // data layer.
      await this.rewardTrigger.trigger(childId, familyId, {
        engine: 'habit-builder',
        type: 'HABIT_COMPLETED',
        // B4: `verifiedBy` is read by a rule that sets a `minVerifiedBy` floor.
        // A habit ticked on the child's own device is SELF evidence; the same
        // completion recorded from a parent's authenticated session is PARENT
        // evidence. Nothing else in the payload can be mistaken for a
        // verification claim, and the child cannot set this field.
        payload: { habitId, category: habit.category, isShared: habit.isShared, status, verifiedBy: actor === 'PARENT' ? 'PARENT' : 'SELF' },
        // B1: `businessDate` is a SERVER output — `Family.timezone` applied to
        // the server clock, or a parent-authorised back-fill inside a bounded
        // window. It is never the raw string a device sent.
        idempotencyKey: `habit-completion:${habitId}:${businessDate}`,
      });

      const since = this.daysAgo(STREAK_LOOKBACK_DAYS, timeZone);
      const dailyCompletions = await this.habitRepository.countCompletionsInWindow(childId, since);
      // Streak here is measured across ALL habits completed that day
      // (at least one), matching this engine's own "Habits Score is a
      // completion RATE, not per-habit" existing discipline — a
      // per-individual-habit streak is a real, separate future
      // extension this pass doesn't invent.
      if (dailyCompletions > 0) {
        const qualifyingDays = await this.getQualifyingCompletionDays(childId, since);
        const streakDays = computeCurrentStreak(qualifyingDays, todayStr);
        if (STREAK_MILESTONES.includes(streakDays)) {
          // Sprint 16.1: idempotencyKey is childId+metric+streakDays
          // — reaching the SAME milestone (e.g. "7-day streak")
          // twice (e.g. two completions logged the same day, or a
          // retry) must grant this milestone reward exactly once.
          await this.rewardTrigger.trigger(childId, familyId, {
            engine: 'habit-builder',
            type: 'STREAK_ACHIEVED',
            payload: { metric: 'habits', streakDays },
            idempotencyKey: `streak:${childId}:habits:${streakDays}`,
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
    // B2: "yesterday" is yesterday ON THE FAMILY CALENDAR. Marking a habit
    // MISSED is a judgement about a day that is over, and the old UTC version
    // declared a Cairo child's evening missed while it was still that evening.
    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const businessDate = dateStr && isBusinessDate(dateStr)
      ? dateStr
      : FamilyDateService.addDays(getBusinessDate(new Date(), timeZone), -1);
    return this.habitRepository.markMissedHabitsForDate(childId, FamilyDateService.toDateColumn(businessDate));
  }

  /** Sprint 16 — Coaching-facing read: recent missed habits as a
   * SIGNAL. Deliberately returns raw facts (which habit, which date)
   * — no severity score, no "this is bad" framing baked in here; a
   * Coaching layer decides what tone/action, if any, this warrants. */
  async getMissedHabitsSignal(childId: string, familyId: string, windowDays = 7) {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const since = this.daysAgo(windowDays, await this.familyDate.timeZoneOf(familyId));
    return this.habitRepository.findMissedHabitsInWindow(childId, since);
  }

  /** Feeds the Habits Score sub-component of the Digital Twin
   * (Architecture 1.0 §6.2) — a plain, explainable rate over a
   * trailing window, not a hidden formula. */
  async getScoreBreakdown(childId: string, familyId: string): Promise<IHabitScoreBreakdown> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const since = this.daysAgo(SCORE_WINDOW_DAYS, timeZone);
    const activeHabitCount = await this.habitRepository.countActiveHabits(childId);
    const sharedHabitCount = await this.habitRepository.countActiveHabits(childId, true);
    const totalHabitDays = activeHabitCount * SCORE_WINDOW_DAYS;
    const completedHabitDays = await this.habitRepository.countCompletionsInWindow(childId, since);
    const sharedCompletions = await this.habitRepository.countCompletionsInWindow(childId, since, true);
    const totalSharedDays = sharedHabitCount * SCORE_WINDOW_DAYS;

    // CLOSES A REAL GAP found in the Digital Twin audit — reuses the
    // exact same computeCurrentStreak + qualifying-days pattern this
    // service's own completeHabit already uses for STREAK_ACHIEVED,
    // not a second implementation.
    const completionDates = await this.habitRepository.findDistinctCompletionDates(childId, since);
    const streakDays = computeCurrentStreak(completionDates, getBusinessDate(new Date(), timeZone));

    return {
      childId,
      windowDays: SCORE_WINDOW_DAYS,
      totalHabitDays,
      completedHabitDays,
      completionRate: totalHabitDays > 0 ? completedHabitDays / totalHabitDays : 0,
      sharedTaskCompletionRate: totalSharedDays > 0 ? sharedCompletions / totalSharedDays : 0,
      streakDays,
    };
  }

  /**
   * B2, SERVER-LOCAL CLASS. `"HH:MM"` against the FAMILY's wall clock.
   *
   * This used to be `new Date().setHours(h, m, 0, 0)` — which reads the
   * CONTAINER's timezone. That is neither UTC nor the family's, it is unset in
   * this image (so it silently equals UTC today), and it would change the
   * meaning of every habit's scheduled window the first time the service was
   * deployed to a host configured differently. A behaviour that depends on an
   * undocumented, unpinned environment variable is not a behaviour, and the
   * comment that called it "an honest approximation" was describing a bug.
   *
   * Both sides of the comparison are now plain `HH:MM` strings on the family's
   * calendar, so there is no `Date` arithmetic left to be wrong.
   */
  private isPastScheduledEnd(scheduledEndTime: string, now: Date, timeZone: string): boolean {
    const [hours, minutes] = scheduledEndTime.split(':').map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return false;
    const scheduledEnd = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    return getBusinessTimeHHMM(now, timeZone) > scheduledEnd;
  }

  /**
   * B1 (PA-B-004). The only place a caller-supplied completion date is allowed
   * in, and the bounds it must survive.
   */
  private resolveCompletionDate(
    dateStr: string | undefined,
    todayStr: string,
    actor: 'PARENT' | 'DEVICE',
    timeZone: string,
  ): string {
    if (actor !== 'PARENT' || dateStr === undefined) return todayStr;

    const requested = isBusinessDate(dateStr) ? dateStr : getBusinessDate(new Date(dateStr), timeZone);
    // Never the future: a future-dated completion is either a mistake or an
    // attempt to pre-mint keys for days that have not happened.
    if (requested > todayStr) return todayStr;
    // Never further back than the scoring window; beyond that the completion
    // affects no score and no streak, and only widens the key space.
    const earliest = FamilyDateService.addDays(todayStr, -SCORE_WINDOW_DAYS);
    return requested < earliest ? earliest : requested;
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

  /**
   * B2: the lower bound of a lookback window, as an instant. The DATE is
   * computed on the family calendar and only then anchored to the UTC midnight
   * the `@db.Date` / timestamp columns store it at — a storage convention
   * applied after the calendar decision, not instead of it.
   */
  private daysAgo(days: number, timeZone: string): Date {
    return FamilyDateService.toDateColumn(
      FamilyDateService.addDays(getBusinessDate(new Date(), timeZone), -days),
    );
  }
}
