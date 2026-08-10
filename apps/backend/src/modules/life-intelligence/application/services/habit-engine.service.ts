import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaHabitRepository } from '../../infrastructure/repositories/prisma-habit.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER, IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { IHabit, IHabitCompletion, IHabitScoreBreakdown, ICreateHabitInput } from '../../domain/habit.types';

const SCORE_WINDOW_DAYS = 30;

/**
 * Architecture 1.0 \u00a73/\u00a75: the static, parent-defined habit list \u2014
 * deliberately distinct from the (not built this sprint) Smart Tasks
 * Engine's AI-generated dynamic suggestions.
 *
 * Follows the Future-Engine Contract (Architecture 1.0 \u00a72):
 * - Memory: none needed yet.
 * - Events: writes to the Unified Timeline via ILifeTimelineWriter,
 *   and (Sprint 25) triggers Reward Rules via IRewardTriggerWriter on
 *   every completion \u2014 never a bespoke event mechanism for either.
 * - AI Provider: not used.
 * - Audit: no AuditLog entry \u2014 a deliberate scope decision.
 * - Safety Validation: no AI/system-generated free-text copy exists here.
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
      // doesn't exist at all \u2014 never leak which case it was.
      throw new NotFoundException('Habit not found');
    }

    const date = dateStr ? new Date(dateStr) : this.today();
    const completion = await this.habitRepository.recordCompletion(habitId, childId, date);

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
      // milestone-worthy \u2014 exactly the kind of curated moment
      // Architecture 1.0 \u00a75.11 says belongs on the Timeline, not
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
    } catch {
      // Intentionally swallowed — see comment above.
    }

    return completion;
  }

  /** Feeds the Habits Score sub-component of the Digital Twin
   * (Architecture 1.0 \u00a76.2) \u2014 a plain, explainable rate over a
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
