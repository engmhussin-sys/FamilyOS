/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import {
  addBusinessDays,
  businessAgeInYears,
  getBusinessDate,
  getBusinessDayEndExclusive,
  getBusinessDayRange,
  getBusinessTimeHHMM,
  type BusinessDate,
} from '../../../../common/time/family-date';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { forEntity } from '../../../../shared/notifications/notification-source-key';
import { SmartNotificationEngineService } from '../../../notification-engine/application/services/smart-notification-engine.service';
import {
  ACTIVITY_STREAK_LOOKBACK_DAYS,
  ACTIVITY_TARGET_MINUTES,
  CHILD_SIGNAL_PRIORITY,
  EMPTY_CHILD_SIGNAL_REPORT,
  HYDRATION_DEFICIT_RATIO,
  SCREEN_MINUTES_FOR_BREAK,
  STREAK_URGENCY_HORIZON_HOURS,
  STREAK_WORTH_PROTECTING_DAYS,
  activityQualifyingDays,
  hoursUntilDayEnds,
  isInsideWindow,
  type ChildSignalCandidate,
  type ChildSignalSweepReport,
} from '../../domain/child-signal.types';
import { PrismaHealthRepository } from '../../infrastructure/repositories/prisma-health.repository';
import { computeHydrationTargetMl } from './health-rules';
import { computeCurrentStreak } from './streak-calculator';

/**
 * SPRINT F1 — THE MISSING PRODUCER OF THE FOUR CHILD-FACING KEYS.
 *
 * `child-signal.types.ts` carries the full argument: which three conditions are
 * row states, why `processSignals` was not given a caller, and why the two GOAL
 * keys are deliberately left on the defect ledger. Read that file first. What
 * belongs HERE is what this class is:
 *
 *   IT IS A READ AND A CALL, exactly like `StalledGoalService`. It asks three
 *   deterministic questions about one child on one family-local day and hands
 *   at most one answer to `SmartNotificationEngineService.handleEvent`.
 *
 *   IT IS NOT A NOTIFICATION PATH. It does not touch `notifications`, it does
 *   not touch `child_messages`, it never calls `createForFamilyOwner` or
 *   `deliverNow`, and it decides nothing about delivery. Scoring, the
 *   quiet-hours class, the copy key, the age band, the safety gate, the deep
 *   link, dedup and delivery are the engine's, unchanged.
 *   `notification-engine-bypass.guard.spec.ts` is the standing proof, and this
 *   file must never appear on its allow-list.
 *
 *   IT IS NOT A SCHEDULER AND READS NO CLOCK. `now` is a parameter, supplied by
 *   the caller, which is what makes «is this child behind on water?» a
 *   deterministic function of rows plus one instant — provable in two timezones
 *   without faking a machine.
 *
 * WHERE IT RUNS FROM, and this is the honest part.
 * `DigitalWellbeingEngineService.recordDailySummary` — the child device's own
 * recurring check-in, which the child app posts on startup, every four hours,
 * and after every fifteen further minutes of screen time
 * (`app.dart:_syncWellbeingSummaryIfThresholdMet`). That is the ONLY recurring
 * intra-day, server-side moment this product has that is not the 02:00
 * rollover, and 02:00 is inside every household's quiet hours — a child
 * reminder produced there would be correctly suppressed every single night.
 *
 * THE LIMIT OF THAT ANCHOR, written down rather than discovered later:
 *
 *   a) It carries the `APP_USAGE_MONITORING` consent gate its host method
 *      already enforces, so a household that declined screen-time monitoring
 *      gets no reminders. That is strictly more than the zero they get today,
 *      and quietly bypassing a consent gate to widen a reminder's reach is not
 *      a trade this product makes.
 *   b) A child whose device does not check in during the habit window or the
 *      last half of the day is not reminded that day. Nothing is lost — the
 *      dedup key is per business date and is never burned by a sweep that
 *      produced nothing.
 *
 * A FAMILY-LOCAL SCHEDULED SWEEP WOULD REMOVE BOTH LIMITS and is the natural
 * home for this method; `sweepChild` is deliberately shaped so a scheduler can
 * call it unchanged. See the report accompanying this sprint for the exact
 * signature.
 *
 * IDEMPOTENT BY DATABASE CONSTRAINTS, NOT BY AN `if`. Two layers, in the order
 * they are reached:
 *
 *   1. `notification_decisions_cause_uniq (family_id, source_event_id,
 *      target_audience)` — `SQL_RECORD_DECISION`'s `ON CONFLICT DO NOTHING`
 *      refuses a second decision for the same cause and `handleEvent` returns a
 *      null `decisionId`. This is what makes the SECOND check-in fifteen
 *      minutes later add nothing.
 *   2. `child_messages (family_id, source_event_id)` — the terminal write for a
 *      CHILD audience, which is what makes a REDELIVERY that somehow got past
 *      layer 1 still produce one row on the child's device.
 *
 * The key that makes both agree is `forEntity('signal', childId, entityId,
 * businessDate)`: THIS child, THIS fact, THIS family-local day. Deliberately
 * NOT `forRecurringSignal` — its five-minute bucket would let the same nudge be
 * re-presented under a new string twelve times an hour, and its own docstring
 * states that limit honestly.
 *
 * IT NEVER THROWS. The standing rule on every notification path here: a
 * notification problem must never fail the thing that triggered it. A malformed
 * habit row must not cost a child their screen-time upload.
 */
@Injectable()
export class ChildSignalService {
  private readonly logger = new Logger(ChildSignalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly familyDate: FamilyDateService,
    private readonly health: PrismaHealthRepository,
    /** THE ONLY DOOR. See the class header: this producer decides nothing. */
    private readonly notifications: SmartNotificationEngineService,
  ) {}

  /**
   * The three questions, asked about one child at one instant, with at most one
   * of them told.
   *
   * MUST BE CALLED INSIDE `runWithTenant({ familyId })`. Every caller today is
   * already inside one (an authenticated device request); this method
   * deliberately does not enter one of its own, because a producer that
   * establishes its own tenant scope is a producer that can be called with any
   * family id from anywhere. Same rule as `StalledGoalService.sweepFamily`.
   */
  async sweepChild(input: {
    familyId: string;
    childId: string;
    now: Date;
    /**
     * Screen minutes the device has reported SO FAR for its own local day, or
     * `null` when the check-in carried no figure this producer may use — a
     * back-dated upload, or a caller that has none. Never read from a table:
     * the number arrives with the check-in that is the reason this sweep is
     * happening, and the caller is the only thing that knows whether the upload
     * was about today.
     */
    screenMinutesToday: number | null;
    /**
     * «The child's device was talking to this server at `now`.» Feeds
     * `RELEVANCE`, which is the score component that separates a nudge to a
     * child who is present from a poke at a child who is not. A parameter
     * rather than an assumption, so a future scheduled caller — which observes
     * no such thing — states `false` and is scored accordingly.
     */
    isEngagedNow: boolean;
  }): Promise<ChildSignalSweepReport> {
    try {
      const timeZone = await this.familyDate.timeZoneOf(input.familyId);
      const businessDate = getBusinessDate(input.now, timeZone);

      const candidates = await this.evaluate(input, timeZone, businessDate);
      if (candidates.length === 0) return EMPTY_CHILD_SIGNAL_REPORT;

      /**
       * AT MOST ONE NEW NOTIFICATION PER SWEEP. `CHILD_SIGNAL_PRIORITY` carries
       * the product argument for the ORDER; the loop below carries the one for
       * when it moves on.
       *
       *   PRODUCED         stop. The child has been told one thing.
       *   ALREADY_DECIDED  KEEP GOING. The ledger refused the cause because it
       *                    was decided earlier today — nothing was written, the
       *                    child was not interrupted, and stopping here would
       *                    let one long-running condition (a habit window open
       *                    from 16:00 to 19:00) STARVE every lower-priority
       *                    signal for the rest of the day. Measured, not
       *                    imagined: the anti-spam case in
       *                    `child-signal-producer.e2e.spec.ts` went red on
       *                    exactly this.
       *   REFUSED          stop. The engine has said «not now» — quiet hours, a
       *                    cap, the floor — and those apply to this household
       *                    rather than to this type. Trying the next candidate
       *                    would be the producer shopping for a message that
       *                    gets past a refusal, which is fatigue-guard evasion
       *                    written as a loop.
       */
      const ordered = [...candidates].sort(
        (a, b) => CHILD_SIGNAL_PRIORITY.indexOf(a.kind) - CHILD_SIGNAL_PRIORITY.indexOf(b.kind),
      );

      let produced = 0;
      let alreadyDecided = 0;
      let refused = 0;

      for (const candidate of ordered) {
        const outcome = await this.tell(input.familyId, input.childId, candidate, businessDate, input);
        if (outcome === 'ALREADY_DECIDED') {
          alreadyDecided += 1;
          continue;
        }
        if (outcome === 'REFUSED') {
          refused += 1;
          break;
        }
        produced += 1;
        // Counts, one family id prefix and the signal name. No child id, no
        // habit title — the same discipline as the rollover's own log line.
        this.logger.log(
          `child.signal_produced family=${input.familyId.slice(0, 8)} businessDate=${businessDate} ` +
            `signal=${candidate.kind} candidates=${candidates.length}`,
        );
        break;
      }

      return { candidates: candidates.length, produced, alreadyDecided, refused };
    } catch (err) {
      this.logger.warn(
        `child.signal_sweep_failed family=${input.familyId.slice(0, 8)} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return EMPTY_CHILD_SIGNAL_REPORT;
    }
  }

  // =========================================================================
  // THE THREE CONDITIONS
  // =========================================================================

  private async evaluate(
    input: { familyId: string; childId: string; now: Date; screenMinutesToday: number | null },
    timeZone: string,
    businessDate: BusinessDate,
  ): Promise<ChildSignalCandidate[]> {
    const [habitWindow, streak, hydration] = await Promise.all([
      this.habitWindow(input.childId, businessDate, input.now, timeZone),
      this.activityStreak(input.childId, businessDate, input.now, timeZone),
      this.hydration(input.childId, businessDate, timeZone, input.screenMinutesToday, input.now),
    ]);
    return [habitWindow, streak, hydration].filter((c): c is ChildSignalCandidate => c !== null);
  }

  /**
   * `STUDY_REMINDER` — A HABIT WHOSE PARENT-SET WINDOW IS OPEN RIGHT NOW.
   *
   * «بدأ وقتك المعتاد لـ {goalTitle}» is only honest if somebody actually SET a
   * usual time, and `habits.scheduled_start_time` is that column: «HH:MM 24h
   * local time — the start of the scheduled window this task is meant for».
   * A learned «the child usually studies at 17:00» would have been the
   * speculative inference this producer must not be.
   *
   * A COMPLETION ROW OF ANY MEANING ENDS IT. `COMPLETED` and `COMPLETED_LATE`
   * are done; `SKIPPED` is the child having decided, and re-asking after a
   * decision is nagging. `MISSED` is written by the rollover for a day that has
   * CLOSED, so it cannot exist for today — but it is matched anyway, because a
   * producer that depends on another job's schedule for its correctness is a
   * producer that breaks when that schedule changes.
   *
   * NO `goal:` FACTS ARE PASSED BY THIS PRODUCER AT ALL, and that is deliberate
   * rather than an omission — `child-signal.types.ts` carries the argument. The
   * habit's title travels as a plain variable instead, which is exactly the
   * slot `COPY_CATALOGUE.STUDY_REMINDER` declares
   * (`variables: ['goalTitle']`).
   */
  private async habitWindow(
    childId: string,
    businessDate: BusinessDate,
    now: Date,
    timeZone: string,
  ): Promise<ChildSignalCandidate | null> {
    const nowHHMM = getBusinessTimeHHMM(now, timeZone);
    const day = FamilyDateService.toDateColumn(businessDate);

    const [habits, settled] = await Promise.all([
      this.models().habit.findMany({
        where: { childId, isActive: true, deletedAt: null, scheduledStartTime: { not: null } },
        select: { id: true, title: true, scheduledStartTime: true, scheduledEndTime: true },
        orderBy: [{ scheduledStartTime: 'asc' }, { id: 'asc' }],
      }),
      this.models().habitCompletion.findMany({
        where: {
          childId,
          date: day,
          status: { in: ['COMPLETED', 'COMPLETED_LATE', 'SKIPPED', 'MISSED'] },
        },
        select: { habitId: true },
      }),
    ]);

    const done = new Set(settled.map((c: { habitId: string }) => c.habitId));
    const open = habits.find(
      (h: { id: string; scheduledStartTime: string | null; scheduledEndTime: string | null }) =>
        !done.has(h.id) && isInsideWindow(nowHHMM, h.scheduledStartTime, h.scheduledEndTime),
    );
    if (!open) return null;

    return {
      kind: 'HABIT_WINDOW',
      eventType: 'STUDY_REMINDER',
      // Per HABIT per day, not per child per day: two windows a parent set
      // hours apart are two different things to be told about, and the type's
      // own 90-minute cooldown and 2/day cap in `DEFAULT_FATIGUE_POLICY` are
      // what bound the total.
      entityId: `habit:${open.id}`,
      variables: { goalTitle: open.title },
    };
  }

  /**
   * `STREAK_AT_RISK` / `EXERCISE_ENCOURAGEMENT` — A LIVE ACTIVITY STREAK WITH
   * NOTHING LOGGED TODAY AND LESS THAN HALF THE DAY LEFT.
   *
   * The streak is COMPUTED, never stored — the same decision, for the same
   * reason, as `FamilyDailyRolloverJob.streakBrokeOn`: there is no
   * `current_streak` column anywhere in this schema, and adding one would
   * create a counter that at-least-once delivery and manual re-runs could push
   * out of step. `computeCurrentStreak` walks the CALENDAR from YESTERDAY,
   * because a streak asked about today is zero by definition while today is
   * still unearned.
   *
   * WHICH SENTENCE, AND WHY THE PRODUCER DECIDES THE FACTS BUT NOT THE WORDS:
   * a streak of three days or more is a habit the child would notice losing
   * (`STREAK_WORTH_PROTECTING_DAYS` carries the citation), so the `streak`
   * facts are supplied and the rule table selects `STREAK_AT_RISK` and the
   * scorer raises `URGENCY` with the hours left. One or two days is a
   * coincidence; the day count travels as a plain variable, no rule fires, and
   * the child reads the gentler «حركة بسيطة تبقي سلسلتك حية».
   *
   * BOTH SHARE ONE DEDUP KEY — `ACTIVITY_STREAK` — so a child can be told about
   * this fact at most once per family-local day whichever sentence it earns.
   */
  private async activityStreak(
    childId: string,
    businessDate: BusinessDate,
    now: Date,
    timeZone: string,
  ): Promise<ChildSignalCandidate | null> {
    const nextDayStart = getBusinessDayEndExclusive(businessDate, timeZone);
    const hoursLeft = hoursUntilDayEnds(now, nextDayStart);
    if (hoursLeft >= STREAK_URGENCY_HORIZON_HOURS) return null;

    const since = FamilyDateService.toDateColumn(
      addBusinessDays(businessDate, -ACTIVITY_STREAK_LOOKBACK_DAYS),
    );
    const totals = await this.health.getDailyActivityTotals(childId, since);

    if ((totals.get(businessDate) ?? 0) >= ACTIVITY_TARGET_MINUTES) return null;

    const days = computeCurrentStreak(
      activityQualifyingDays(totals),
      addBusinessDays(businessDate, -1),
    );
    if (days <= 0) return null;

    return {
      kind: 'ACTIVITY_STREAK',
      eventType: 'EXERCISE_ENCOURAGEMENT',
      entityId: 'ACTIVITY_STREAK',
      ...(days >= STREAK_WORTH_PROTECTING_DAYS
        ? { streak: { days, atRisk: true, hoursUntilBreak: hoursLeft } }
        : { variables: { days } }),
    };
  }

  /**
   * `HYDRATION_REMINDER` — A LONG STRETCH ON SCREEN AND BELOW HALF THE DAY'S
   * WATER.
   *
   * `screenMinutesToday` is the figure the device just uploaded and the caller
   * has already established belongs to the family's CURRENT business date. It
   * is never re-read from `daily_behavioral_snapshots` here, because the row
   * that matters is the one that caused this sweep and reading it back would
   * make the answer depend on which of two writes landed first.
   *
   * The water is summed over the FAMILY'S business day
   * (`getBusinessDayRange`), not over a UTC day: `hydration_logs.logged_at` is
   * a timestamp, and a Cairo child's 22:00 glass counted against tomorrow is
   * `PA-B-001` exactly — the bug `HealthEngineService` was already fixed for.
   * The target is `computeHydrationTargetMl` on the child's age computed on the
   * family's calendar, so this producer and the progress screen agree.
   */
  private async hydration(
    childId: string,
    businessDate: BusinessDate,
    timeZone: string,
    screenMinutesToday: number | null,
    now: Date,
  ): Promise<ChildSignalCandidate | null> {
    if (screenMinutesToday === null || screenMinutesToday < SCREEN_MINUTES_FOR_BREAK) return null;

    const child = await this.models().child.findUnique({
      where: { id: childId },
      // TWO COLUMNS, not the row. The date of birth is consumed into an integer
      // age here and never travels — the same rule `NotificationContextAssembler`
      // states for its own read.
      select: { dateOfBirth: true },
    });
    if (!child?.dateOfBirth) return null;

    const targetMl = computeHydrationTargetMl(businessAgeInYears(child.dateOfBirth, now, timeZone));
    if (targetMl <= 0) return null;

    const { start, endExclusive } = getBusinessDayRange(businessDate, timeZone);
    const actualMl = await this.health.sumHydrationMlOnDate(childId, start, endExclusive);

    if (actualMl >= targetMl * HYDRATION_DEFICIT_RATIO) return null;

    return {
      kind: 'HYDRATION',
      eventType: 'HYDRATION_REMINDER',
      entityId: 'HYDRATION',
    };
  }

  // =========================================================================
  // THE DOOR
  // =========================================================================

  /**
   * ONE CANDIDATE, THROUGH THE ENGINE'S REAL ENTRY POINT.
   *
   * `trigger: 'PERIODIC_SIGNAL'` because that is what this is —
   * `NOTIFICATION_TRIGGERS` documents that member as «a periodic signal scan
   * produced a candidate». It is deliberately not `DOMAIN_EVENT`: none of these
   * three facts emits one, which is the whole reason they had no producer, and
   * claiming one on the ledger row would make the trigger column a lie about
   * how the product learned this.
   */
  private async tell(
    familyId: string,
    childId: string,
    candidate: ChildSignalCandidate,
    businessDate: BusinessDate,
    context: { now: Date; isEngagedNow: boolean },
  ): Promise<'PRODUCED' | 'ALREADY_DECIDED' | 'REFUSED'> {
    try {
      const result = await this.notifications.handleEvent({
        familyId,
        childId,
        eventType: candidate.eventType,
        sourceEventId: forEntity('signal', childId, candidate.entityId, businessDate),
        trigger: 'PERIODIC_SIGNAL',
        variables: candidate.variables,
        streak: candidate.streak ?? null,
        activity: { isEngagedNow: context.isEngagedNow },
        now: context.now,
      });

      // A NULL decision id is the ledger's unique key refusing a cause it has
      // already recorded — the idempotency guarantee, read as the absence of a
      // returned id rather than as a boolean somebody could forget to check.
      if (result.decisionId === null) return 'ALREADY_DECIDED';
      return result.decision.verdict === 'SUPPRESS' ? 'REFUSED' : 'PRODUCED';
    } catch (err) {
      this.logger.warn(
        `child.signal_notify_failed family=${familyId.slice(0, 8)} signal=${candidate.kind} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'REFUSED';
    }
  }

  /**
   * The same structural cast, for the same reason, as `JobRunner.prismaRaw()`
   * and `StalledGoalService.raw()`: this code must work against both the
   * extended production client and the WASM-engine client the tenancy proof
   * suites build, and naming a generated type would bind it to one of them.
   */
  private models(): { habit: any; habitCompletion: any; child: any } {
    return this.prisma as any;
  }
}
