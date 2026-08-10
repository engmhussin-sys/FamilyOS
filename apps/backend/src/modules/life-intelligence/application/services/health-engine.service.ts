import { Inject, Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaHealthRepository } from '../../infrastructure/repositories/prisma-health.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { REWARD_TRIGGER_WRITER, IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import {
  IActivityLog,
  ICreateActivityLogInput,
  ICreateHydrationLogInput,
  ICreateNutritionLogInput,
  ICreateSleepLogInput,
  IHealthScoreBreakdown,
  IHydrationLog,
  INutritionLog,
  ISleepLog,
} from '../../domain/health.types';
import { computeHydrationTargetMl } from './health-rules';

/**
 * Architecture 1.0 \u00a73/\u00a75: merges what were three separate engines
 * (Nutrition, Hydration, Activity) into one, plus Sleep \u2014 per the
 * approved decision that activity explicitly belongs to Health
 * Engine's remit, not a fourth standalone engine.
 *
 * Future-Engine Contract (Architecture 1.0 \u00a72):
 * - Memory: not used this sprint.
 * - Events: writes to the Unified Timeline, and (Sprint 25) triggers
 *   Reward Rules on the hydration-target-reached and activity-logged
 *   milestones via IRewardTriggerWriter.
 * - AI Provider: not used.
 * - Audit: no AuditLog entry, matching Habit Engine's own reasoning.
 * - Safety Validation: no AI/system-generated free-text copy exists here.
 */
@Injectable()
export class HealthEngineService {
  constructor(
    private readonly repository: PrismaHealthRepository,
    private readonly childrenService: ChildrenService,
    @Inject(LIFE_TIMELINE_WRITER) private readonly timeline: ILifeTimelineWriter,
    @Inject(REWARD_TRIGGER_WRITER) private readonly rewardTrigger: IRewardTriggerWriter,
  ) {}

  async logNutrition(childId: string, familyId: string, input: Omit<ICreateNutritionLogInput, 'childId'>): Promise<INutritionLog> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const priorCount = await this.repository.countNutritionLogsOnDate(childId, new Date(input.date));
    const log = await this.repository.createNutritionLog({ ...input, childId });
    if (priorCount === 0) {
      await this.timeline.record({
        childId,
        sourceEngine: 'health',
        category: 'HEALTH',
        eventType: 'first_nutrition_log_today',
        title: 'Logged today\u2019s first meal',
      });
    }
    return log;
  }

  async logHydration(childId: string, familyId: string, input: Omit<ICreateHydrationLogInput, 'childId'>): Promise<IHydrationLog> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const child = await this.childrenService.getChildOrThrow(childId, familyId);

    const log = await this.repository.createHydrationLog({ ...input, childId });

    const { dayStart, dayEnd } = this.dayBounds(new Date());
    const totalToday = await this.repository.sumHydrationMlOnDate(childId, dayStart, dayEnd);
    const target = computeHydrationTargetMl(this.ageYears(child.dateOfBirth));

    // Milestone: reaching the daily target for the first time TODAY
    // (crossing the line exactly this log, not already past it before).
    if (totalToday >= target && totalToday - input.amountMl < target) {
      await this.timeline.record({
        childId,
        sourceEngine: 'health',
        category: 'HEALTH',
        eventType: 'hydration_target_reached',
        title: 'Reached today\u2019s hydration goal',
        metadata: { targetMl: target, totalMl: totalToday },
      });

      // Sprint 25: same best-effort principle as HabitEngineService's
      // own wiring — a Reward Rules failure never blocks the log itself.
      try {
        await this.rewardTrigger.trigger(childId, familyId, {
          engine: 'health',
          type: 'hydration_event',
          payload: { metric: 'hydration_target_reached' },
        });
      } catch {
        // Intentionally swallowed — see comment above.
      }
    }

    return log;
  }

  async logSleep(childId: string, familyId: string, input: Omit<ICreateSleepLogInput, 'childId'>): Promise<ISleepLog> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.createSleepLog({ ...input, childId });
  }

  async logActivity(childId: string, familyId: string, input: Omit<ICreateActivityLogInput, 'childId'>): Promise<IActivityLog> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const log = await this.repository.createActivityLog({ ...input, childId });

    if (input.socialContext === 'GROUP' || input.socialContext === 'TEAM') {
      const since = this.daysAgo(30);
      const groupCount = await this.repository.countGroupActivitiesInWindow(childId, since);
      // Same known, low-severity race condition as HabitEngineService's
      // identical pattern (see its own comment) — a rare, cosmetic
      // duplicate Timeline entry, never affecting the underlying
      // ActivityLog record itself.
      if (groupCount === 1) {
        await this.timeline.record({
          childId,
          sourceEngine: 'health',
          category: 'HEALTH',
          eventType: 'first_group_activity',
          title: `Joined a group activity: ${input.activityType}`,
        });
      }
    }

    return log;
  }

  /** Computes and persists the explainable daily Health Score \u2014 the
   * Health Score sub-component of the Digital Twin (Architecture 1.0
   * \u00a76.2). A plain weighted average over verifiable inputs, every
   * contributing figure surfaced in `breakdown`, never a hidden formula. */
  async computeAndStoreHealthScore(childId: string, familyId: string, dateStr?: string): Promise<IHealthScoreBreakdown> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const child = await this.childrenService.getChildOrThrow(childId, familyId);

    const date = dateStr ? new Date(dateStr) : this.today();
    const { dayStart, dayEnd } = this.dayBounds(date);

    const target = computeHydrationTargetMl(this.ageYears(child.dateOfBirth));

    // FIXING A REAL PERFORMANCE GAP (found in this session's own
    // review): these four reads are fully independent of one another
    // — none needs another's result — but were previously awaited one
    // at a time (5 sequential round trips end-to-end instead of 2).
    const [actualMl, totalMinutes, groupMinutes, sleepLog, nutritionLogsCount] = await Promise.all([
      this.repository.sumHydrationMlOnDate(childId, dayStart, dayEnd),
      this.repository.sumActivityMinutesOnDate(childId, date),
      this.repository.sumActivityMinutesOnDate(childId, date, true),
      this.repository.findSleepLogForDate(childId, date),
      this.repository.countNutritionLogsOnDate(childId, date),
    ]);

    const hydrationRatio = target > 0 ? Math.min(1, actualMl / target) : 0;
    // 60 active minutes/day is a widely-cited general pediatric activity
    // guideline, directional, not a medical claim.
    const activityRatio = Math.min(1, totalMinutes / 60);
    const sleepHours = sleepLog ? (sleepLog.sleepEnd.getTime() - sleepLog.sleepStart.getTime()) / 3_600_000 : null;
    const sleepRatio = sleepHours !== null ? Math.min(1, sleepHours / 9) : 0.5; // neutral if unlogged, not zero
    const nutritionRatio = Math.min(1, nutritionLogsCount / 3); // 3 logged meals/day baseline

    const score = Math.round(((hydrationRatio + activityRatio + sleepRatio + nutritionRatio) / 4) * 100);

    const breakdown: IHealthScoreBreakdown['breakdown'] = {
      hydration: { targetMl: target, actualMl, ratio: hydrationRatio },
      activity: { totalMinutes, groupMinutes },
      sleepHours,
      nutritionLogsCount,
    };

    await this.repository.upsertHealthScore(childId, date, score, breakdown as unknown as Record<string, unknown>);

    return { childId, date: date.toISOString().slice(0, 10), score, breakdown };
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

  private dayBounds(date: Date): { dayStart: Date; dayEnd: Date } {
    const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    return { dayStart, dayEnd };
  }

  private ageYears(dateOfBirth: Date | string): number {
    const diffMs = Date.now() - new Date(dateOfBirth).getTime();
    return Math.floor(diffMs / (365.25 * 24 * 3600 * 1000));
  }
}
