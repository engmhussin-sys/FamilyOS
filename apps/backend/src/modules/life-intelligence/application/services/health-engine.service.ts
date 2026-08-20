import { Inject, Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaHealthRepository } from '../../infrastructure/repositories/prisma-health.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { TIMELINE_COPY_AR } from '../../domain/life-timeline-copy';
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
import { forEntity } from '../../../../shared/notifications/notification-source-key';
import { SmartNotificationEngineService } from '../../../notification-engine/application/services/smart-notification-engine.service';
import type { DailyGoalCause } from '../../../notifications/domain/engine/notification-nouns';
import { computeHydrationTargetMl } from './health-rules';
import { computeCurrentStreak } from './streak-calculator';
import { composeIdempotencyKey } from '../../../../shared/events/idempotency';
import { isStreakMilestone } from '../../../../shared/rewards/streak-milestones';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { businessAgeInYears, getBusinessDate, getBusinessDayRange, isBusinessDate } from '../../../../common/time/family-date';

/**
 * PHASE C (`PC-B-003`) \u2014 how far back a PARENT may back-fill an activity log.
 *
 * The same 30 days `getDailyProgress` already uses as `STREAK_WINDOW_DAYS` and
 * that `logActivity` already passes to `daysAgo(30, ...)` for its own streak
 * query, named once here rather than being a third loose `30` in this file. A
 * log older than the window contributes to no streak and to no daily goal, so
 * accepting one only widens the idempotency key space for no product value.
 */
const ACTIVITY_STREAK_WINDOW_DAYS = 30;

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
 *
 * AND SO IS THE CHILD'S AGE, WHICH THIS FILE USED TO ANSWER FOR ITSELF.
 * `private ageYears(dob)` was `Math.floor((Date.now() - dob) / (365.25 days))`.
 * That is not a calendar. Nine calendar years spanning only two leap days is
 * 3287 days, and 3287 / 365.25 = 8.9993 — EIGHT — while `businessAgeInYears`
 * says nine; adding twelve hours to the same instant flips it back to nine, so
 * the answer moved with the hour the question was asked. Both forms fed
 * `computeHydrationTargetMl`, so on a child's ninth birthday this file set a
 * 1700 ml target while `ChildSignalService` — which asks `businessAgeInYears` —
 * set 2100. `getDailyProgress` said «goal reached», the nudge kept nudging, and
 * `HYDRATION_GOAL_COMPLETED` and its reward fired 400 ml early.
 *
 * Scanned over a year of «today» values for ages 3–18, the two forms disagreed
 * on 3,600 (today, DOB) pairs at 00:00 UTC, 730 of them across a hydration band
 * boundary. `businessAgeInYears` is the one answer and `ageYears` is deleted;
 * `test/life-intelligence/hydration-target-one-age.e2e.spec.ts` drives a real
 * ninth birthday through the Child App's own button and reads the rows.
 */
@Injectable()
export class HealthEngineService {
  constructor(
    private readonly repository: PrismaHealthRepository,
    private readonly childrenService: ChildrenService,
    @Inject(LIFE_TIMELINE_WRITER) private readonly timeline: ILifeTimelineWriter,
    @Inject(REWARD_TRIGGER_WRITER) private readonly rewardTrigger: IRewardTriggerWriter,
    private readonly familyDate: FamilyDateService,
    /**
     * SPRINT F1 — THE ONLY DOOR, and the reason this class is now a producer.
     * See `announceDailyGoal`. It decides nothing: scoring, the quiet-hours
     * class, the copy, the safety band, the deep link and the delivery are the
     * engine's, unchanged, and this file must never appear on
     * `notification-engine-bypass.guard.spec.ts`'s allow-list.
     */
    private readonly notifications: SmartNotificationEngineService,
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
        title: TIMELINE_COPY_AR.firstNutritionLogToday(),
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
    const target = computeHydrationTargetMl(businessAgeInYears(child.dateOfBirth, todayStr, timeZone));

    // Milestone: reaching the daily target for the first time TODAY
    // (crossing the line exactly this log, not already past it before).
    if (totalToday >= target && totalToday - input.amountMl < target) {
      await this.timeline.record({
        childId,
        sourceEngine: 'health',
        category: 'HEALTH',
        eventType: 'hydration_target_reached',
        title: TIMELINE_COPY_AR.hydrationTargetReached(),
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
          // B4: SELF, honestly. The CROSSING is decided server-side (the target
          // comes from the child's age, the total is summed from stored rows on
          // the family's business day), but the millilitres themselves are
          // child-reported. Claiming SENSOR or SYSTEM here would overstate the
          // evidence, and a family that wants a stronger bar can raise the
          // rule's `minVerifiedBy` and log hydration from the parent app.
          payload: { metric: 'hydration', targetMl: target, totalMl: totalToday, verifiedBy: 'SELF' },
          idempotencyKey: `daily-goal:hydration:${childId}:${todayStr}`,
        });

        /**
         * ===================================================================
         * THE CONTRACT NAME, FIRED BESIDE THE LEGACY ONE — AND THE REASON THE
         * KEY IS COMPOSED RATHER THAN WRITTEN.
         * ===================================================================
         *
         * THE DEFECT THIS CLOSES, MEASURED BEFORE IT WAS FIXED. Migration 0026
         * seeds `first_hydration_goal` against `eventType:
         * 'HYDRATION_GOAL_COMPLETED'`. This method fired only
         * `DAILY_GOAL_COMPLETED`, a name no badge rule carries, and
         * `HYDRATION_GOAL_COMPLETED` was produced as a REWARD TRIGGER by exactly
         * one thing — `RewardsCompletionConsumer`, i.e. only for a completion
         * that arrived through `POST /events/batch`. So a child crossing their
         * target with the Child App's own hydration button got the XP and could
         * NEVER earn the badge, while the same crossing posted as a device event
         * did. Two doors onto one business event, one of them badge-blind.
         *
         * THIS IS `HabitEngineService.completeHabit`'S SHAPE, NOT A NEW ONE. That
         * method fires the contract name `HABIT_COMPLETED` additively beside its
         * legacy `habit_completed`, and that is precisely why `first_habit` is
         * earnable through both doors. Health is now the same. The alternative —
         * re-seeding the badge against `DAILY_GOAL_COMPLETED` — would have traded
         * the working door for the broken one, because the device door produces
         * `HYDRATION_GOAL_COMPLETED` and nothing else.
         *
         * THE KEY IS `composeIdempotencyKey`, AND THAT IS THE LOAD-BEARING PART.
         * A hand-written key here (`hydration-goal:{child}:{date}`) would have
         * awarded the badge and still been wrong: `EventIngestionService` composes
         * the device door's key with exactly this call, so a hand-written one
         * would NOT collide, and a child who both pressed the button and had a
         * device event for the same crossing would be paid the
         * `default:hydration:goal` XP TWICE on the same business day. Composing it
         * makes the two doors produce a BYTE-IDENTICAL key, and
         * `rewards_ledger_entries (child_id, idempotency_key)` — a DATABASE
         * UNIQUE CONSTRAINT, not a check-then-insert — is what refuses the second
         * grant, in whichever order the two doors arrive.
         *
         * `todayStr` IS THE FAMILY'S BUSINESS DATE, `Family.timezone` applied to
         * the server clock by `getBusinessDate` — never UTC and never a string a
         * device sent. It is the same value the ingestion path derives, which is
         * the other half of why the two keys agree.
         */
        await this.rewardTrigger.trigger(childId, familyId, {
          engine: 'health',
          type: 'HYDRATION_GOAL_COMPLETED',
          // Same honest evidence level as the legacy trigger above: the CROSSING
          // is server-decided, the millilitres are child-reported.
          payload: { metric: 'hydration', targetMl: target, totalMl: totalToday, verifiedBy: 'SELF' },
          idempotencyKey: composeIdempotencyKey('HYDRATION_GOAL_COMPLETED', {
            childId,
            localDate: todayStr,
          }),
        });

        // SPRINT F1 — AND THE CHILD IS TOLD. Same crossing, same day, same
        // server-decided target; see `announceDailyGoal`.
        await this.announceDailyGoal(childId, familyId, 'HYDRATION_GOAL_COMPLETED', todayStr);

        // Streak milestone — only fires a SEPARATE event on real
        // milestone streak lengths (not every single day), matching
        // this codebase's own "Timeline gets curated moments, not
        // every daily tick" discipline (see this file's Timeline
        // writes elsewhere).
        const since = this.daysAgo(30, timeZone);
        const dailyTotals = await this.repository.getDailyHydrationTotals(childId, since, timeZone);
        const qualifyingDays = [...dailyTotals.entries()].filter(([, ml]) => ml >= target).map(([d]) => d);
        const streakDays = computeCurrentStreak(qualifyingDays, todayStr);
        // ONE LIST, `shared/rewards/streak-milestones.ts`. This was an INLINE
        // array literal, and it was a SHORTER copy of the one the habit engine
        // used — it stopped at thirty days. `STREAK_ACHIEVED` pays, so a child
        // who kept a hydration or activity streak for sixty or a hundred days
        // was told nothing and paid nothing, while the same length in habits
        // paid COINS. See `test/rewards/streak-milestones.spec.ts`.
        if (isStreakMilestone(streakDays)) {
          // Sprint 16.1: idempotencyKey is childId+metric+streakDays —
          // reaching the same milestone twice must grant it once.
          await this.rewardTrigger.trigger(childId, familyId, {
            engine: 'health',
            type: 'STREAK_ACHIEVED',
            payload: { metric: 'hydration', streakDays },
            // ONE HOME FOR THE KEY. This was a hand-written template beside
            // `composeIdempotencyKey`'s own `STREAK_ACHIEVED` shape — the second
            // implementation of one concept that let the HABIT streak be paid
            // twice once a second producer appeared. There is no second producer
            // of a hydration streak today; there was no second producer of a
            // habit streak either, until there was.
            idempotencyKey: composeIdempotencyKey('STREAK_ACHIEVED', {
              childId,
              kind: 'hydration',
              milestone: streakDays,
            }),
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

  /**
   * PHASE C (`PC-B-003`) — THE ONE HEALTH PATH B1 NEVER REACHED.
   *
   * THE EXPLOIT, measured before it was closed
   * (`test/rewards/reward-source-forgery.e2e.spec.ts`). `POST
   * /life-intelligence/self/health/activity-logs` is a DEVICE-token route and
   * it passed `dto.date` straight into `ActivityLog.date` — the `@db.Date`
   * column `getDailyActivityTotals` reads back VERBATIM, precisely because that
   * repository method is documented as timezone-free on the grounds that the
   * column «already holds a business date». It held whatever the child typed.
   * Thirty POSTs dated across the previous thirty days, the last of them dated
   * today so the 60-minute goal crossing fires, and `computeCurrentStreak`
   * returned 30: `streak:{childId}:activity:30` granted, 100 COINS, zero
   * exercise. The ledger key from that run is quoted in the Phase C report.
   *
   * B1 (PA-B-004) closed exactly this on Habits, B4 on Faith, and
   * `LearningEngineService` carries its own `resolveSessionDate`. Activity was
   * missed because its date arrives INSIDE the DTO object rather than as a
   * separate argument, so the `actor` parameter the other three grew was never
   * added here and the gap was invisible at every call site.
   *
   * THE FIX IS THE SAME FIX, NOT A NEW ONE. `actor` defaults to `'DEVICE'`, so
   * a route that forgets to pass it fails CLOSED (the child's date is
   * discarded) rather than open. A parent keeps a BOUNDED back-fill — never the
   * future, never further back than the streak window — which is a real product
   * need at a different trust level, and is the same shape as
   * `HabitEngineService.resolveCompletionDate` on purpose rather than a fourth
   * variation of the rule.
   */
  async logActivity(
    childId: string,
    familyId: string,
    input: Omit<ICreateActivityLogInput, 'childId'>,
    actor: 'PARENT' | 'DEVICE' = 'DEVICE',
  ): Promise<IActivityLog> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const timeZone = await this.familyDate.timeZoneOf(familyId);
    // Resolved BEFORE the row is written, so the day that is STORED and the day
    // every downstream goal, streak and idempotency key is decided on are the
    // same value rather than two derivations that could disagree.
    const logDate = this.resolveLogDate(
      input.date,
      getBusinessDate(new Date(), timeZone),
      actor,
      timeZone,
    );
    const log = await this.repository.createActivityLog({ ...input, childId, date: logDate });

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
          title: TIMELINE_COPY_AR.firstGroupActivity(null),
          metadata: { activityType: input.activityType },
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
    /**
     * PHASE C (`PC-B-004`) — `logDate === todayStr` IS NEW, AND IT IS NOT
     * DECORATION.
     *
     * The crossing test is «today's total reached the target, and it had not
     * before THIS log». The second half subtracts `input.durationMinutes` from
     * today's total — which is only meaningful if this log LANDED on today. A
     * back-dated parent log does not, so the subtraction removed minutes that
     * were never added and re-declared a goal already crossed hours earlier: a
     * duplicate timeline entry and a re-fired trigger on every back-fill. The
     * ledger's idempotency key absorbed the grant, which is exactly why this
     * stayed invisible; the timeline entry had no such protection.
     */
    if (
      logDate === todayStr &&
      todayMinutes >= activityTargetMinutes &&
      todayMinutes - input.durationMinutes < activityTargetMinutes
    ) {
      await this.timeline.record({
        childId,
        sourceEngine: 'health',
        category: 'HEALTH',
        eventType: 'activity_target_reached',
        title: TIMELINE_COPY_AR.activityTargetReached(),
        metadata: { targetMinutes: activityTargetMinutes, totalMinutes: todayMinutes },
      });

      try {
        await this.rewardTrigger.trigger(childId, familyId, {
          engine: 'health',
          type: 'DAILY_GOAL_COMPLETED',
          payload: { metric: 'activity', targetMinutes: activityTargetMinutes, totalMinutes: todayMinutes, verifiedBy: 'SELF' },
          idempotencyKey: `daily-goal:activity:${childId}:${todayStr}`,
        });

        /**
         * THE CONTRACT NAME, for the same reason and with the same key
         * discipline as `logHydration`'s own `HYDRATION_GOAL_COMPLETED` trigger
         * — read that comment; it carries the full argument and the measurement.
         *
         * In short: `first_activity_goal` is seeded against
         * `ACTIVITY_GOAL_COMPLETED`, this method fired only
         * `DAILY_GOAL_COMPLETED`, and so the badge was unreachable through
         * `POST /life-intelligence/self/health/activity-logs` while being
         * reachable through `POST /events/batch`. `composeIdempotencyKey` is what
         * makes the two doors share one key, so the ledger's own unique
         * constraint — not an `if` — refuses the second grant.
         *
         * `todayStr`, not `logDate`, and they are provably equal here: this whole
         * block is behind `logDate === todayStr` (see PC-B-004 above), so a
         * back-dated parent log never reaches it. Using the same variable the
         * legacy trigger and `announceDailyGoal` already use keeps one day per
         * crossing rather than two derivations that could drift.
         */
        await this.rewardTrigger.trigger(childId, familyId, {
          engine: 'health',
          type: 'ACTIVITY_GOAL_COMPLETED',
          payload: { metric: 'activity', targetMinutes: activityTargetMinutes, totalMinutes: todayMinutes, verifiedBy: 'SELF' },
          idempotencyKey: composeIdempotencyKey('ACTIVITY_GOAL_COMPLETED', {
            childId,
            localDate: todayStr,
          }),
        });

        // SPRINT F1 — AND THE CHILD IS TOLD. See `announceDailyGoal`.
        await this.announceDailyGoal(childId, familyId, 'ACTIVITY_GOAL_COMPLETED', todayStr);

        const since = this.daysAgo(30, timeZone);
        const dailyTotals = await this.repository.getDailyActivityTotals(childId, since);
        const qualifyingDays = [...dailyTotals.entries()].filter(([, min]) => min >= activityTargetMinutes).map(([d]) => d);
        const streakDays = computeCurrentStreak(qualifyingDays, todayStr);
        // ONE LIST, `shared/rewards/streak-milestones.ts`. This was an INLINE
        // array literal, and it was a SHORTER copy of the one the habit engine
        // used — it stopped at thirty days. `STREAK_ACHIEVED` pays, so a child
        // who kept a hydration or activity streak for sixty or a hundred days
        // was told nothing and paid nothing, while the same length in habits
        // paid COINS. See `test/rewards/streak-milestones.spec.ts`.
        if (isStreakMilestone(streakDays)) {
          await this.rewardTrigger.trigger(childId, familyId, {
            engine: 'health',
            type: 'STREAK_ACHIEVED',
            payload: { metric: 'activity', streakDays },
            // Same one home as `logHydration`'s streak key above.
            idempotencyKey: composeIdempotencyKey('STREAK_ACHIEVED', {
              childId,
              kind: 'activity',
              milestone: streakDays,
            }),
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

    const target = computeHydrationTargetMl(
      businessAgeInYears(child.dateOfBirth, dateStrBusiness, timeZone),
    );

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
    const target = computeHydrationTargetMl(businessAgeInYears(child.dateOfBirth, dateStr, timeZone));
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

  /**
   * PHASE C (`PC-B-003`) — B1's RULE, ON THE PATH THAT NEVER GOT IT.
   *
   * Deliberately a COPY OF THE SHAPE of `HabitEngineService.resolveCompletionDate`
   * and `FaithEngineService.resolveLogDate`, not a fourth variation and not an
   * abstraction extracted in a security fix. The three differ only in the
   * window constant they clamp to, and the reason each one lives next to the
   * engine whose window it uses is that a shared helper would have to take the
   * window as a parameter — at which point the call site can pass the wrong
   * one, which is the failure mode this fix exists to remove, not to relocate.
   *
   *   A DEVICE gets `todayStr`. Always. Its `date` is not read at all, so
   *   there is no bound to get wrong and nothing to validate.
   *
   *   A PARENT gets a bounded back-fill: never the FUTURE (a future-dated log
   *   pre-mints an idempotency key for a day that has not happened — measured
   *   as reachable before this fix), and never further back than
   *   `ACTIVITY_STREAK_WINDOW_DAYS`, beyond which the log affects no streak and
   *   no goal and only widens the key space.
   */
  private resolveLogDate(
    dateStr: string | undefined,
    todayStr: string,
    actor: 'PARENT' | 'DEVICE',
    timeZone: string,
  ): string {
    if (actor !== 'PARENT' || dateStr === undefined) return todayStr;

    const requested = isBusinessDate(dateStr) ? dateStr : getBusinessDate(new Date(dateStr), timeZone);
    if (requested > todayStr) return todayStr;
    const earliest = FamilyDateService.addDays(todayStr, -ACTIVITY_STREAK_WINDOW_DAYS);
    return requested < earliest ? earliest : requested;
  }

  /** B2: lookback lower bound, as the UTC-midnight instant the day columns
   * store — the calendar decision happens first, in `getBusinessDate`. */
  private daysAgo(days: number, timeZone: string): Date {
    return FamilyDateService.toDateColumn(
      FamilyDateService.addDays(getBusinessDate(new Date(), timeZone), -days),
    );
  }

  /**
   * ==========================================================================
   * SPRINT F1 — THE MISSING PRODUCER OF `DAILY_GOAL_COMPLETED`.
   * ==========================================================================
   *
   * WHAT WAS MEASURED. `DAILY_GOAL_COMPLETED` had four tone bands of Arabic and
   * English, a quiet-hours class (`DEFER` — «the completion row exists and a
   * receipt is still a receipt in the morning»), two scoring rows and a
   * deep-link destination, and NOTHING IN `src/` produced it. It sat on
   * `PRODUCERLESS_DEFECT_LEDGER` for «no server-owned Arabic name for a daily
   * goal exists»: `TYPE_SPECS.DAILY_GOAL_COMPLETED.aggregateType = 'DailyGoal'`
   * names a model with no table, and the only candidate text was device-supplied
   * `metadata` — client prose, which must never be rendered as if the server
   * wrote it.
   *
   * WHAT A DAILY GOAL ACTUALLY IS IN THIS PRODUCT, and the evidence is these two
   * call sites. `HealthEngineService` is the ONLY thing in this codebase that
   * emits the name `DAILY_GOAL_COMPLETED` server-side, and it emits exactly two:
   * the hydration target in `logHydration` and the 60-minute activity target in
   * `logActivity`. Both TARGETS are the server's — one derived from the child's
   * age by `computeHydrationTargetMl`, one the same constant `getDailyProgress`
   * and `computeAndStoreHealthScore` already use — and both CROSSINGS are summed
   * from stored rows on the family's business day. Neither takes a title, a
   * label or any other string from a device.
   *
   * IT IS NOT THE HABIT ENGINE, which was the other candidate: `habit-engine.service.ts`
   * mentions the name in a comment and fires `HABIT_COMPLETED`, never this one.
   * A habit is a different fact with a different Arabic word and a different
   * screen, and calling one the other would have been the producer firing on a
   * hunch.
   *
   * SO THE NAME IS THE SERVER'S TO WRITE, and it is written in
   * `notification-nouns.ts`, beside the copy, in both languages, keyed on the
   * ORIGINATING DOMAIN EVENT TYPE (`HYDRATION_GOAL_COMPLETED` /
   * `ACTIVITY_GOAL_COMPLETED`, both already in `DOMAIN_EVENT_TYPES`) — never a
   * new vocabulary invented at the notification layer. `cause` is the field
   * `NotificationEventFacts` documents for exactly this, and the decision
   * provider turns it into `{goalTitle}` in the household's own language.
   *
   * THE CONDITION IS THE CROSSING, NOT THE LOG. Both call sites are already
   * inside «today's total reached the target AND had not before THIS log», which
   * is why a child who drinks a tenth glass is not congratulated ten times.
   *
   * IDEMPOTENT AT THE DATABASE, NOT BY AN `if`. `forEntity('signal', childId,
   * 'daily-goal:<cause>', businessDate)` — THIS child, THIS goal, THIS
   * family-local day — is refused by
   * `notification_decisions_cause_uniq (family_id, source_event_id,
   * target_audience)` on the second attempt, and by
   * `child_messages (family_id, source_event_id)` on a redelivery that somehow
   * got past it. The crossing test above is a `if`, and it is deliberately NOT
   * the guarantee: a back-dated parent log, a retried request or a second replica
   * can all re-enter this method, and only the constraint stops the second row.
   * The key mirrors the reward trigger's own `daily-goal:{metric}:{child}:{day}`
   * so the grant and the message are deduplicated on the same fact.
   *
   * IT NEVER THROWS, and it is called from inside the same best-effort
   * `try`/`catch` the reward trigger already sits in: a notification problem must
   * never fail the hydration log that caused it.
   */
  private async announceDailyGoal(
    childId: string,
    familyId: string,
    cause: DailyGoalCause,
    businessDate: string,
  ): Promise<void> {
    await this.notifications.handleEvent({
      familyId,
      childId,
      eventType: 'DAILY_GOAL_COMPLETED',
      cause,
      sourceEventId: forEntity('signal', childId, `daily-goal:${cause}`, businessDate),
      /**
       * `DOMAIN_EVENT` and not `PERIODIC_SIGNAL`: unlike the two goal-nudge
       * producers, this one is standing at the moment the fact happened. The
       * crossing IS the event, and `NOTIFICATION_TRIGGERS` documents this member
       * as «a domain event arrived».
       */
      trigger: 'DOMAIN_EVENT',
      /**
       * «The child was talking to this server at `now`» — and here, uniquely
       * among this sprint's producers, that is an observation rather than an
       * assumption: this method is reached from the child's own log request.
       */
      activity: { isEngagedNow: true },
    });
  }
}
