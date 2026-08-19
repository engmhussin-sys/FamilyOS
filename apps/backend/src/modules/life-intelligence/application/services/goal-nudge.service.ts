/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { runAsSystemAsync } from '../../../../common/tenancy/system-context';
import { runWithTenant } from '../../../../common/tenancy/tenant-context';
import {
  addBusinessDays,
  businessAgeInYears,
  getBusinessDate,
  type BusinessDate,
} from '../../../../common/time/family-date';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { forEntity } from '../../../../shared/notifications/notification-source-key';
import { SmartNotificationEngineService } from '../../../notification-engine/application/services/smart-notification-engine.service';
import {
  canNameUnits,
  goalUnitKindForActivity,
} from '../../../notifications/domain/engine/notification-nouns';
import {
  EMPTY_GOAL_NUDGE_TOTALS,
  GOAL_DEADLINE_MAX_MINUTES,
  GOAL_DEADLINE_MIN_MINUTES,
  GOAL_NUDGE_PRIORITY,
  goalNudgeEntityId,
  type GoalNudgeCandidate,
  type GoalNudgeSweepReport,
  type GoalNudgeSweepTotals,
} from '../../domain/goal-nudge.types';
import {
  SQL_LIST_ALMOST_DONE_GOALS,
  SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES,
  SQL_LIST_GOAL_DEADLINES,
} from '../../infrastructure/goal-nudge.sql';

/**
 * SPRINT F1 — THE MISSING PRODUCER OF `GOAL_DEADLINE_NEAR` AND `GOAL_ALMOST_DONE`.
 *
 * `goal-nudge.types.ts` carries the full argument: which two conditions are row
 * states, why NO progress column was added, and why the deadline band is three
 * to ten minutes. Read that file first. What belongs HERE is what this class is:
 *
 *   IT IS A READ AND A CALL, exactly like `StalledGoalService` and
 *   `ChildSignalService`. It asks two deterministic questions about one child on
 *   one family-local day and hands at most one answer to
 *   `SmartNotificationEngineService.handleEvent`.
 *
 *   IT IS NOT A NOTIFICATION PATH. It does not touch `notifications`, it does
 *   not touch `child_messages`, it never calls `createForFamilyOwner` or
 *   `deliverNow`, and it decides nothing about delivery. Scoring, the
 *   quiet-hours class, the copy key, the age band, the safety gate, the deep
 *   link, dedup and delivery are the engine's, unchanged.
 *   `notification-engine-bypass.guard.spec.ts` is the standing proof, and this
 *   file must never appear on its allow-list.
 *
 *   IT IS NOT A SCHEDULER AND READS NO CLOCK. `now` is a parameter all the way
 *   down, supplied by `GoalNudgeSweepJob` from the runner's own tick, which is
 *   what makes «is this window closing?» a deterministic function of rows plus
 *   one instant — provable in two timezones without faking a machine.
 *
 * WHERE IT RUNS FROM, AND WHY IT NEEDED A JOB OF ITS OWN.
 * `goal-nudge-sweep`, a PLATFORM job on a 300-second cadence, seeded by
 * migration 0024. Neither of the two recurring moments this product already had
 * could carry these two facts:
 *
 *   `family-daily-rollover` runs ONCE per household per day at 02:00 local —
 *   inside every household's quiet hours, and long after any window closed.
 *   The child device's own check-in (`recordDailySummary`, which
 *   `ChildSignalService` rides) is four hours apart at best, carries the
 *   `APP_USAGE_MONITORING` consent gate, and happens only while the child is on
 *   the phone. A deadline band eight real minutes wide cannot be watched by any
 *   of that.
 *
 * A 300-second cadence against an eight-minute window is the whole reason the
 * band is reachable, and `goal-nudge.types.ts` states that inequality as a
 * property rather than as a hope.
 *
 * IDEMPOTENT BY DATABASE CONSTRAINTS, NOT BY AN `if`. Three layers, in the order
 * they are reached:
 *
 *   1. `notification_decisions_cause_uniq (family_id, source_event_id,
 *      target_audience)` — `SQL_RECORD_DECISION`'s `ON CONFLICT DO NOTHING`
 *      refuses a second decision for the same cause and `handleEvent` returns a
 *      null `decisionId`. This is the layer that makes the NEXT tick, five
 *      minutes later, add nothing — and there are up to 288 ticks a day.
 *   2. `child_messages (family_id, source_event_id)` — the terminal write for a
 *      CHILD audience, which is what makes a REDELIVERY that somehow got past
 *      layer 1 still produce one row on the child's device.
 *   3. the AUDIENCE is part of the key at both layers. The deferral defect that
 *      cost a child ten hours a night was a unique key WITHOUT an audience
 *      column, so the child's row lost to the parent's under `ON CONFLICT DO
 *      NOTHING`; `forChildAudience` and the ledger's `target_audience` column are
 *      what stop that shape here, and this producer relies on both rather than
 *      composing a key of its own.
 *
 * The key that makes every layer agree is `forEntity('signal', childId,
 * '<kind>:<programId>', businessDate)`: THIS child, THIS fact about THIS goal,
 * THIS family-local day. Deliberately NOT `forRecurringSignal` — its five-minute
 * bucket is exactly this job's cadence, so every single tick would mint a new
 * string and the child would be told 288 times.
 *
 * IT NEVER THROWS. The standing rule on every notification path here: a
 * notification problem must never fail the thing that triggered it. One
 * household's malformed row must not stop the sweep that also watches every
 * other household's closing windows, so each family and each candidate is
 * attempted independently and a failure is counted and logged rather than
 * propagated.
 */
@Injectable()
export class GoalNudgeService {
  private readonly logger = new Logger(GoalNudgeService.name);

  /** How many households one tick may look at. A bound on a sweep, not on a
   * product rule — the same knob `RELEASE_DEFAULTS` gives the release sweep. */
  static readonly MAX_FAMILIES_PER_SWEEP = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly familyDate: FamilyDateService,
    /** THE ONLY DOOR. See the class header: this producer decides nothing. */
    private readonly notifications: SmartNotificationEngineService,
  ) {}

  /**
   * ONE TICK, ACROSS EVERY HOUSEHOLD THAT COULD HAVE A CANDIDATE.
   *
   * The fan-out reads TENANT IDS ONLY, under `runAsSystemAsync` with a written
   * justification, and every household is then evaluated inside its own
   * `runWithTenant` — the same shape `QuietHoursReleaseService.sweep` uses, and
   * for the same reason: a cross-tenant statement that touched content would be
   * a tenancy hole no test could see afterwards.
   */
  async sweep(now: Date = new Date()): Promise<GoalNudgeSweepTotals> {
    const familyIds = await this.familiesWithCandidates(now);
    if (familyIds.length === 0) return EMPTY_GOAL_NUDGE_TOTALS;

    let totals: GoalNudgeSweepTotals = { ...EMPTY_GOAL_NUDGE_TOTALS, families: familyIds.length };

    for (const familyId of familyIds) {
      try {
        const one = await runWithTenant(
          { familyId, actorType: 'SYSTEM', actorId: 'goal-nudge-sweep' },
          () => this.sweepFamily({ familyId, now }),
        );
        totals = {
          families: totals.families,
          children: totals.children + one.children,
          candidates: totals.candidates + one.candidates,
          produced: totals.produced + one.produced,
          alreadyDecided: totals.alreadyDecided + one.alreadyDecided,
          refused: totals.refused + one.refused,
        };
      } catch (err) {
        // One household's bad row must not stop every other household's sweep.
        this.logger.warn(
          `goal.nudge_family_failed family=${familyId.slice(0, 8)} ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (totals.produced > 0) {
      // Counts only. No family id, no child id, no goal title — the same
      // discipline `StalledGoalService` and the rollover both follow.
      this.logger.log(
        `goal.nudge_swept families=${totals.families} children=${totals.children} ` +
          `candidates=${totals.candidates} produced=${totals.produced} ` +
          `alreadyDecided=${totals.alreadyDecided} refused=${totals.refused}`,
      );
    }

    return totals;
  }

  /**
   * ONE HOUSEHOLD, ON ITS OWN CALENDAR.
   *
   * MUST BE CALLED INSIDE `runWithTenant({ familyId })`. `sweep` enters it
   * before every household and the tests enter it explicitly; this method
   * deliberately does not enter one of its own, because a producer that
   * establishes its own tenant scope is a producer that can be called with any
   * family id from anywhere. Same rule as `StalledGoalService.sweepFamily` and
   * `ChildSignalService.sweepChild`.
   */
  async sweepFamily(input: {
    familyId: string;
    now: Date;
  }): Promise<GoalNudgeSweepTotals> {
    const timeZone = await this.familyDate.timeZoneOf(input.familyId);
    const businessDate = getBusinessDate(input.now, timeZone);

    const byChild = await this.evaluate(input.familyId, businessDate, input.now, timeZone);
    if (byChild.size === 0) return { ...EMPTY_GOAL_NUDGE_TOTALS, children: 0 };

    let totals: GoalNudgeSweepTotals = { ...EMPTY_GOAL_NUDGE_TOTALS, children: byChild.size };
    for (const [childId, candidates] of byChild) {
      const one = await this.tellOne(input.familyId, childId, candidates, businessDate, input.now);
      totals = {
        families: totals.families,
        children: totals.children,
        candidates: totals.candidates + one.candidates,
        produced: totals.produced + one.produced,
        alreadyDecided: totals.alreadyDecided + one.alreadyDecided,
        refused: totals.refused + one.refused,
      };
    }
    return totals;
  }

  // =========================================================================
  // THE TWO CONDITIONS
  // =========================================================================

  /**
   * Both questions, asked once for the whole household, and grouped by child —
   * because the «at most one» rule is per CHILD, not per family: two siblings
   * are two people and one of them being nudged is no reason to silence the
   * other.
   */
  private async evaluate(
    familyId: string,
    businessDate: BusinessDate,
    now: Date,
    timeZone: string,
  ): Promise<Map<string, GoalNudgeCandidate[]>> {
    const weekFrom = addBusinessDays(businessDate, -6);

    const [deadlines, almostDone] = await Promise.all([
      this.raw().$queryRawUnsafe<GoalNudgeRow[]>(
        SQL_LIST_GOAL_DEADLINES,
        familyId,
        businessDate,
        now,
        GOAL_DEADLINE_MIN_MINUTES,
        GOAL_DEADLINE_MAX_MINUTES,
      ),
      this.raw().$queryRawUnsafe<GoalNudgeRow[]>(
        SQL_LIST_ALMOST_DONE_GOALS,
        familyId,
        businessDate,
        weekFrom,
        now,
      ),
    ]);

    const out = new Map<string, GoalNudgeCandidate[]>();
    const add = (candidate: GoalNudgeCandidate | null, childId: string): void => {
      if (!candidate) return;
      const list = out.get(childId) ?? [];
      list.push(candidate);
      out.set(childId, list);
    };

    for (const row of deadlines) add(this.deadlineCandidate(row, now, timeZone), row.child_id);
    for (const row of almostDone) add(this.almostDoneCandidate(row, now, timeZone), row.child_id);
    return out;
  }

  /**
   * `GOAL_DEADLINE_NEAR` — «باقي لك ٥ دقائق فقط لإكمال هدفك في {goalTitle}».
   *
   * The SQL has already applied every row-state gate. What is left here is the
   * one gate that is a TypeScript function rather than a column comparison: the
   * child's age on the FAMILY'S calendar, against the program's `min_age`. It is
   * `businessAgeInYears` and not a second age derived in SQL, because two
   * different ages in two different languages is how a child gets invited to a
   * program the next screen refuses.
   */
  private deadlineCandidate(
    row: GoalNudgeRow,
    now: Date,
    timeZone: string,
  ): GoalNudgeCandidate | null {
    if (!this.oldEnough(row, now, timeZone)) return null;
    const unitKind = goalUnitKindForActivity(row.activity);
    if (!unitKind) return null;

    const minutesRemaining = Number(row.minutes_remaining);
    // Belt and braces with the SQL band: the sentence prints this number, and a
    // number outside the band is a number the Arabic template cannot inflect.
    if (
      !Number.isInteger(minutesRemaining) ||
      minutesRemaining < GOAL_DEADLINE_MIN_MINUTES ||
      minutesRemaining > GOAL_DEADLINE_MAX_MINUTES
    ) {
      return null;
    }

    return {
      kind: 'GOAL_DEADLINE',
      eventType: 'STUDY_REMINDER',
      programId: row.program_id,
      goalTitle: row.goal_title,
      completedUnits: Number(row.verified_today),
      totalUnits: Number(row.max_per_day),
      minutesRemaining,
      unitKind,
    };
  }

  /**
   * `GOAL_ALMOST_DONE` — «أنجزت ٤ من ٥ آيات — هل تكمل الأخيرة الآن؟».
   *
   * THE LAST GATE IS THE LANGUAGE, and it is the reason this producer can be
   * trusted with a child's screen: `canNameUnits` is false exactly when the
   * count is one Arabic cannot write after a numeral (the dual), and this method
   * then returns `null`. The child is told NOTHING rather than told it wrongly,
   * and nothing degrades to `GENERIC` — because the fact never reaches the
   * engine at all. `notification-nouns.ts` carries the grammar.
   */
  private almostDoneCandidate(
    row: GoalNudgeRow,
    now: Date,
    timeZone: string,
  ): GoalNudgeCandidate | null {
    if (!this.oldEnough(row, now, timeZone)) return null;
    const unitKind = goalUnitKindForActivity(row.activity);
    if (!unitKind) return null;

    const totalUnits = Number(row.max_per_day);
    const completedUnits = Number(row.verified_today);
    if (!canNameUnits(unitKind, totalUnits)) return null;

    return {
      kind: 'GOAL_ALMOST_DONE',
      eventType: 'STUDY_REMINDER',
      programId: row.program_id,
      goalTitle: row.goal_title,
      completedUnits,
      totalUnits,
      // NO DEADLINE. `DEADLINE_PROXIMITY` then contributes zero — the honest
      // reading for a plan with the rest of the day in it — and
      // `COPY_RULES.GOAL_DEADLINE_NEAR`, which is ordered first, cannot fire.
      minutesRemaining: null,
      unitKind,
    };
  }

  /** The program's own `min_age`, against the child's age on the FAMILY'S
   * calendar. `CHILD_BELOW_MIN_AGE` is a refusal the child would hit on the very
   * next screen. */
  private oldEnough(row: GoalNudgeRow, now: Date, timeZone: string): boolean {
    const dob = row.date_of_birth instanceof Date ? row.date_of_birth : new Date(row.date_of_birth);
    if (Number.isNaN(dob.getTime())) return false;
    return businessAgeInYears(dob, now, timeZone) >= Number(row.min_age ?? 0);
  }

  // =========================================================================
  // THE DOOR
  // =========================================================================

  /**
   * AT MOST ONE NEW NOTIFICATION PER CHILD PER SWEEP. `GOAL_NUDGE_PRIORITY`
   * carries the product argument for the ORDER; this loop carries the one for
   * when it moves on, and it is the same three-way rule `ChildSignalService`
   * arrived at:
   *
   *   PRODUCED         stop. The child has been told one thing.
   *   ALREADY_DECIDED  KEEP GOING. The ledger refused the cause because it was
   *                    decided earlier today — nothing was written and the child
   *                    was not interrupted. Stopping here would let one
   *                    long-lived fact («one session left», true from noon)
   *                    starve the deadline of a DIFFERENT goal for the rest of
   *                    the day.
   *   REFUSED          stop. The engine has said «not now» — quiet hours, a cap,
   *                    the floor — and those apply to this household rather than
   *                    to this goal. Trying the next candidate would be the
   *                    producer shopping for a message that gets past a refusal,
   *                    which is fatigue-guard evasion written as a loop.
   */
  private async tellOne(
    familyId: string,
    childId: string,
    candidates: readonly GoalNudgeCandidate[],
    businessDate: BusinessDate,
    now: Date,
  ): Promise<GoalNudgeSweepReport> {
    const ordered = [...candidates].sort(
      (a, b) => GOAL_NUDGE_PRIORITY.indexOf(a.kind) - GOAL_NUDGE_PRIORITY.indexOf(b.kind),
    );

    let produced = 0;
    let alreadyDecided = 0;
    let refused = 0;

    for (const candidate of ordered) {
      const outcome = await this.tell(familyId, childId, candidate, businessDate, now);
      if (outcome === 'ALREADY_DECIDED') {
        alreadyDecided += 1;
        continue;
      }
      if (outcome === 'REFUSED') {
        refused += 1;
        break;
      }
      produced += 1;
      // Counts and the signal name. No child id, no goal title.
      this.logger.log(
        `goal.nudge_produced businessDate=${businessDate} signal=${candidate.kind} ` +
          `candidates=${candidates.length}`,
      );
      break;
    }

    return { candidates: candidates.length, produced, alreadyDecided, refused };
  }

  /**
   * ONE CANDIDATE, THROUGH THE ENGINE'S REAL ENTRY POINT.
   *
   * `trigger: 'PERIODIC_SIGNAL'` because that is what this is —
   * `NOTIFICATION_TRIGGERS` documents that member as «a periodic signal scan
   * produced a candidate». It is deliberately not `DOMAIN_EVENT`: a goal
   * approaching its expiry emits nothing, which is the whole reason it had no
   * producer, and claiming an event on the ledger row would make the trigger
   * column a lie about how the product learned this.
   *
   * THE FACTS PASSED ARE THE ROWS', not a summary of them: the goal's own Arabic
   * title (`reward_programs.target_summary_ar`, derived once by
   * `describeTargetSpec` and already on the child's own goal card), the count of
   * VERIFIED attempts today, the parent's own `max_per_day`, and the unit kind so
   * the copy layer can inflect the noun. WHICH SENTENCE those facts deserve is
   * the decision provider's, recorded on `notification_decisions.copy_key`.
   */
  private async tell(
    familyId: string,
    childId: string,
    candidate: GoalNudgeCandidate,
    businessDate: BusinessDate,
    now: Date,
  ): Promise<'PRODUCED' | 'ALREADY_DECIDED' | 'REFUSED'> {
    try {
      const result = await this.notifications.handleEvent({
        familyId,
        childId,
        eventType: candidate.eventType,
        // `'signal'`, the producer `StalledGoalService` and `ChildSignalService`
        // both name, because that is what this is: a PERIODIC SIGNAL SCAN. The
        // entity id carries the goal AND which fact about it, so a nudge from
        // this producer can never collide with one of theirs.
        sourceEventId: forEntity(
          'signal',
          childId,
          goalNudgeEntityId(candidate.kind, candidate.programId),
          businessDate,
        ),
        trigger: 'PERIODIC_SIGNAL',
        goal: {
          title: candidate.goalTitle,
          completedUnits: candidate.completedUnits,
          totalUnits: candidate.totalUnits,
          minutesRemaining: candidate.minutesRemaining,
          unitKind: candidate.unitKind,
        },
        /**
         * `false`, and it is a statement rather than a default. RELEVANCE asks
         * «is the child here right now», and a SCHEDULED sweep observes no such
         * thing — it is looking at rows, not at a device that just spoke. Saying
         * `true` would inflate the score of every nudge in the product with an
         * engagement nobody measured.
         */
        activity: { isEngagedNow: false },
        now,
      });

      // A NULL decision id is the ledger's unique key refusing a cause it has
      // already recorded — the idempotency guarantee, read as the absence of a
      // returned id rather than as a boolean somebody could forget to check.
      if (result.decisionId === null) return 'ALREADY_DECIDED';
      return result.decision.verdict === 'SUPPRESS' ? 'REFUSED' : 'PRODUCED';
    } catch (err) {
      this.logger.warn(
        `goal.nudge_notify_failed family=${familyId.slice(0, 8)} signal=${candidate.kind} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'REFUSED';
    }
  }

  /**
   * THE FAN-OUT. Tenant ids only, and the justification is the API's own
   * argument for why that is allowed here.
   */
  private async familiesWithCandidates(now: Date): Promise<string[]> {
    return runAsSystemAsync(
      // `SCHEDULED_JOB`, the reason that already exists for exactly this: «the
      // FAN-OUT ENUMERATION» of a job whose body then re-enters a tenant. A new
      // reason would have widened a closed union to say a thing it already says.
      'SCHEDULED_JOB',
      'The goal-nudge sweep enumerates the households whose children have touched a live reward program near today; it reads TENANT IDS ONLY and then re-enters runWithTenant for each one before reading a single row of content.',
      async () => {
        const rows = await this.raw().$queryRawUnsafe<Array<{ family_id: string }>>(
          SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES,
          now,
          GoalNudgeService.MAX_FAMILIES_PER_SWEEP,
        );
        return rows.map((r) => r.family_id);
      },
    );
  }

  /**
   * The same structural cast, for the same reason, as `JobRunner.prismaRaw()`,
   * `StalledGoalService.raw()` and `ChildSignalService.models()`: this code must
   * work against both the extended production client and the WASM-engine client
   * the tenancy proof suites build, and naming a generated type would bind it to
   * one of them.
   */
  private raw(): { $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T> } {
    return this.prisma as any;
  }
}

/** The eight columns the two per-family statements return, and not one more. */
interface GoalNudgeRow {
  readonly child_id: string;
  readonly program_id: string;
  readonly goal_title: string;
  readonly activity: string;
  readonly max_per_day: number;
  readonly min_age: number | null;
  readonly date_of_birth: Date | string;
  readonly verified_today: number;
  readonly minutes_remaining?: number;
}
