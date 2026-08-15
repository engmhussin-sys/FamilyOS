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
import { computeCurrentStreak } from './streak-calculator';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { getBusinessDate, getBusinessDayRange, isBusinessDate } from '../../../../common/time/family-date';

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
 *
 * B2 (PA-B-001): "today" here decided a child's daily hydration and activity
 * GOALS, the idempotency keys of the grants that follow them, and both streaks.
 * All of it was UTC. A Cairo child drinking their last glass at 22:00 local had
 * it counted against the NEXT day's target, so today's goal never closed and
 * tomorrow's opened three hours early. Every one of those decisions is now made
 * on the family's calendar.
 */
@Injectable()
export class HealthEngineService {
  constructor(
    private readonly repository: PrismaHealthRepository,
    private readonly childrenService: ChildrenService,
    @Inject(LIFE_TIMELINE_WRITER) private readonly timeline: ILifeTimelineWriter,
    @Inject(REWARD_TRIGGER_WRITER) private readonly rewardTrigger: IRewardTriggerWriter,
    private readonly familyDate: FamilyDateService,
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

    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const todayStr = getBusinessDate(new Date(), timeZone);
    const { start: dayStart, endExclusive: dayEnd } = getBusinessDayRange(todayStr, timeZone);
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

        // Sprint 15 — CLOSES A REAL GAP: the brief's own explicit
        // contract event name (DAILY_GOAL_COMPLETED), fired
        // ADDITIVELY alongside the pre-existing 'hydration_event'
        // type above — a future Rewards Engine consumer can listen
        // for this specific name without this project guessing at
        // that engine's own internal rule structure.
        // Sprint 16.1 (Double Reward Protection): idempotencyKey is
        // childId+metric+date — reaching today's hydration goal is a
        // once-per-day event; a retry or duplicate log crossing the
        // threshold again must not grant this twice.
        await this.rewardTrigger.trigger(childId, familyId, {
          engine: 'health',
          type: 'DAILY_GOAL_COMPLETED',
          payload: { metric: 'hydration', targetMl: target, totalMl: totalToday },
          idempotencyKey: `daily-goal:hydration:${childId}:${todayStr}`,
        });

        // Streak milestone — only fires a SEPARATE event on real
        // milestone streak lengths (not every single day), matching
        // this codebase's own "Timeline gets curated moments, not
        // every daily tick" discipline (see this file's Timeline
        // writes elsewhere).
        const since = this.daysAgo(30, timeZone);
        const dailyTotals = await this.repository.getDailyHydrationTotals(childId, since, timeZone);
        const qualifyingDays = [...dailyTotals.entries()].filter(([, ml]) => ml >= target).map(([d]) => d);
        const streakDays = computeCurrentStreak(qualifyingDays, todayStr);
        if ([3, 7, 14, 30].includes(streakDays)) {
          // Sprint 16.1: idempotencyKey is childId+metric+streakDays —
          // reaching the same milestone twice must grant it once.
          await this.rewardTrigger.trigger(childId, familyId, {
            engine: 'health',
            type: 'STREAK_ACHIEVED',
            payload: { metric: 'hydration', streakDays },
            idempotencyKey: `streak:${childId}:hydration:${streakDays}`,
          });
        }
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

    const timeZone = await this.familyDate.timeZoneOf(familyId);

    if (input.socialContext === 'GROUP' || input.socialContext === 'TEAM') {
      const since = this.daysAgo(30, timeZone);
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

    // Sprint 16.3 Priority 3 — CLOSES A REAL GAP: mirrors
    // logHydration's own exact milestone-crossing pattern, same
    // target (60 min/day) getDailyProgress already uses for its own
    // isAchieved field — same source of truth, not a second one.
    const todayStr = getBusinessDate(new Date(), timeZone);
    const today = FamilyDateService.toDateColumn(todayStr);
    const todayMinutes = await this.repository.sumActivityMinutesOnDate(childId, today);
    const activityTargetMinutes = 60;
    if (todayMinutes >= activityTargetMinutes && todayMinutes - input.durationMinutes < activityTargetMinutes) {
      await this.timeline.record({
        childId,
        sourceEngine: 'health',
        category: 'HEALTH',
        eventType: 'activity_target_reached',
        title: 'Reached today’s activity goal',
        metadata: { targetMinutes: activityTargetMinutes, totalMinutes: todayMinutes },
      });

      try {
        await this.rewardTrigger.trigger(childId, familyId, {
          engine: 'health',
          type: 'DAILY_GOAL_COMPLETED',
          payload: { metric: 'activity', targetMinutes: activityTargetMinutes, totalMinutes: todayMinutes },
          idempotencyKey: `daily-goal:activity:${childId}:${todayStr}`,
        });

        const since = this.daysAgo(30, timeZone);
        const dailyTotals = await this.repository.getDailyActivityTotals(childId, since);
        const qualifyingDays = [...dailyTotals.entries()].filter(([, min]) => min >= activityTargetMinutes).map(([d]) => d);
        const streakDays = computeCurrentStreak(qualifyingDays, todayStr);
        if ([3, 7, 14, 30].includes(streakDays)) {
          await this.rewardTrigger.trigger(childId, familyId, {
            engine: 'health',
            type: 'STREAK_ACHIEVED',
            payload: { metric: 'activity', streakDays },
            idempotencyKey: `streak:${childId}:activity:${streakDays}`,
          });
        }
      } catch {
        // Intentionally swallowed — same best-effort discipline as
        // logHydration's own identical try/catch above.
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

    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const dateStrBusiness = dateStr && isBusinessDate(dateStr)
      ? dateStr
      : getBusinessDate(dateStr ?? new Date(), timeZone);
    const date = FamilyDateService.toDateColumn(dateStrBusiness);
    const { start: dayStart, endExclusive: dayEnd } = getBusinessDayRange(dateStrBusiness, timeZone);

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

    return { childId, date: dateStrBusiness, score, breakdown };
  }

  /** Sprint 15 (Health & Daily Habits Engine) — CLOSES A REAL GAP:
   * no unified "how am I doing today, and what's my streak" view
   * existed — Hydration/Activity data existed (via logHydration/
   * logActivity) but was never surfaced together with streak
   * information in one place a Parent/Child App screen could
   * display directly. Reuses StreakCalculator (Sprint 15's own new
   * shared utility) — built ONCE, not duplicated per metric. */
  async getDailyProgress(childId: string, familyId: string): Promise<{
    date: string;
    hydration: { actualMl: number; targetMl: number; ratio: number; remaining: number; isAchieved: boolean; streakDays: number };
    activity: { totalMinutes: number; targetMinutes: number; ratio: number; remaining: number; isAchieved: boolean; streakDays: number };
  }> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const child = await this.childrenService.getChildOrThrow(childId, familyId);

    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const dateStr = getBusinessDate(new Date(), timeZone);
    const date = FamilyDateService.toDateColumn(dateStr);
    const { start: dayStart, endExclusive: dayEnd } = getBusinessDayRange(dateStr, timeZone);
    const target = computeHydrationTargetMl(this.ageYears(child.dateOfBirth));
    const activityTargetMinutes = 60; // same pediatric-guideline baseline as computeAndStoreHealthScore's own activityRatio

    const STREAK_WINDOW_DAYS = 30; // enough real history for a meaningful streak without an unbounded query
    const since = this.daysAgo(STREAK_WINDOW_DAYS, timeZone);

    const [actualMl, activityMinutes, hydrationDailyTotals, activityDailyTotals] = await Promise.all([
      this.repository.sumHydrationMlOnDate(childId, dayStart, dayEnd),
      this.repository.sumActivityMinutesOnDate(childId, date),
      this.repository.getDailyHydrationTotals(childId, since, timeZone),
      this.repository.getDailyActivityTotals(childId, since),
    ]);

    const hydrationQualifyingDays = [...hydrationDailyTotals.entries()].filter(([, ml]) => ml >= target).map(([d]) => d);
    const activityQualifyingDays = [...activityDailyTotals.entries()].filter(([, min]) => min >= activityTargetMinutes).map(([d]) => d);

    return {
      date: dateStr,
      hydration: {
        actualMl,
        targetMl: target,
        ratio: target > 0 ? Math.min(1, actualMl / target) : 0,
        remaining: Math.max(0, target - actualMl),
        isAchieved: actualMl >= target,
        streakDays: computeCurrentStreak(hydrationQualifyingDays, dateStr),
      },
      activity: {
        totalMinutes: activityMinutes,
        targetMinutes: activityTargetMinutes,
        ratio: Math.min(1, activityMinutes / activityTargetMinutes),
        remaining: Math.max(0, activityTargetMinutes - activityMinutes),
        isAchieved: activityMinutes >= activityTargetMinutes,
        streakDays: computeCurrentStreak(activityQualifyingDays, dateStr),
      },
    };
  }

  /** B2: lookback lower bound, as the UTC-midnight instant the day columns
   * store — the calendar decision happens first, in `getBusinessDate`. */
  private daysAgo(days: number, timeZone: string): Date {
    return FamilyDateService.toDateColumn(
      FamilyDateService.addDays(getBusinessDate(new Date(), timeZone), -days),
    );
  }

  private ageYears(dateOfBirth: Date | string): number {
    const diffMs = Date.now() - new Date(dateOfBirth).getTime();
    return Math.floor(diffMs / (365.25 * 24 * 3600 * 1000));
  }
}
