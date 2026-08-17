/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { BusinessDate } from '../../../../common/time/family-date';
import { forEntity } from '../../../../shared/notifications/notification-source-key';
import { SmartNotificationEngineService } from '../../../notification-engine/application/services/smart-notification-engine.service';
import {
  EMPTY_STALLED_GOAL_REPORT,
  stalledGoalUnits,
  type StalledGoalCandidate,
  type StalledGoalSweepReport,
} from '../../domain/stalled-goal.types';
import { SQL_LIST_STALLED_GOALS } from '../../infrastructure/stalled-goal.sql';

/**
 * SPRINT F1 — THE MISSING PRODUCER OF `GOAL_STALLED_PARENT`.
 *
 * `e2e-14` measured the gap and pinned it: the type had a sentence, a
 * quiet-hours class, an urgency weight, an achievement baseline and a deep-link
 * destination — five deliberate rows in five tables — and nothing in `src/`
 * ever emitted it. A goal that is not finished emits no domain event, so there
 * was no consumer to hang it on and no scheduled sweep asked the question.
 *
 * WHAT THIS CLASS IS AND IS NOT:
 *
 *   IT IS A READ AND A CALL. It asks `SQL_LIST_STALLED_GOALS` which goals a
 *   family's CLOSED day left open, and hands each one to
 *   `SmartNotificationEngineService.handleEvent`. That is the whole class.
 *
 *   IT IS NOT A NOTIFICATION PATH. It does not touch `notifications`, it does
 *   not touch `child_messages`, it does not call `createForFamilyOwner`, it
 *   does not call `deliverNow`, and it does not decide anything. Scoring,
 *   dedup, the quiet-hours class, the copy, the safety band, the deep link and
 *   the delivery are the engine's, unchanged. `notification-engine-bypass.guard.spec.ts`
 *   is the standing proof of that, and this file must never appear on its
 *   allow-list.
 *
 *   IT IS NOT A SECOND SCHEDULER. It has no timer and reads no clock: `now` and
 *   `businessDate` are parameters, supplied by `FamilyDailyRolloverJob` from
 *   the runner's own per-family fan-out. That is what makes «is this goal
 *   stalled?» a deterministic function of rows plus one instant, provable
 *   without faking a machine.
 *
 * THE CONDITION IS DETERMINISTIC, and `stalled-goal.types.ts` carries the full
 * argument, including the three heuristics that were rejected for needing a
 * number this schema does not hold.
 *
 * THE FAMILY'S CALENDAR, NOT UTC. `businessDate` arrives already derived from
 * `Family.timezone` — `JobRunner.executeFamilies` computes it per household
 * with `closableBusinessDate`, and `achievement_requests.local_date` was
 * written from `FamilyDateService.toDateColumn` at start time. Both sides of
 * the comparison are family-local days, and nothing here re-derives one from an
 * instant. A Cairo household and a Riyadh household therefore ask about
 * DIFFERENT calendar days at the same instant, which is the property
 * `stalled-goal-producer.e2e.spec.ts` executes in both zones.
 *
 * IDEMPOTENT BY A DATABASE CONSTRAINT, NOT BY AN `if`. Three independent
 * layers, in the order they are reached:
 *
 *   1. `job_runs (job_name, family_id, business_date)` UNIQUE — the sweep
 *      itself runs once per household per closed day, so a second tick, a
 *      second replica or an operator pressing «Run now» never reaches this
 *      method a second time for that day.
 *   2. `notification_decisions_cause_uniq (family_id, source_event_id,
 *      target_audience)` — `SQL_RECORD_DECISION`'s `ON CONFLICT DO NOTHING`
 *      refuses a second decision for the same cause and `handleEvent` returns a
 *      null `decisionId`. This is the layer that holds when layer 1 is bypassed
 *      — a manual invocation, a catch-up run, this file called twice by a test.
 *   3. `notifications (family_id, source_event_id, user_id)` UNIQUE — the
 *      terminal write, which is what makes a REDELIVERY that somehow got past
 *      both of the above still produce one row on the parent's phone.
 *
 * The key that makes all three agree is `forEntity('signal', childId,
 * programId, businessDate)`: THIS child, THIS goal, THIS family-local day. A
 * stalled goal has no `domain_events.id` — that absence is the whole reason it
 * had no producer — but it does have that stable business identity, which is
 * the case `notification-source-key.ts` documents `forEntity` for. It is
 * deliberately NOT `forRecurringSignal`: a bucketed key would let the same fact
 * be re-presented under a new string later the same day, and the honest limit
 * of that form is written in its own docstring.
 *
 * IT NEVER THROWS. The standing rule on every notification path here: a
 * notification problem must never fail the thing that triggered it. One
 * household's malformed row must not stop the rollover that also marks habits
 * MISSED, so each candidate is attempted independently and a failure is
 * counted and logged rather than propagated.
 */
@Injectable()
export class StalledGoalService {
  private readonly logger = new Logger(StalledGoalService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** THE ONLY DOOR. See the class header: this producer decides nothing. */
    private readonly notifications: SmartNotificationEngineService,
  ) {}

  /**
   * Every goal this family left open on `businessDate`, told to the engine once.
   *
   * MUST BE CALLED INSIDE `runWithTenant({ familyId })`. The job runner enters
   * it before every family handler and the tests enter it explicitly; this
   * method deliberately does not enter one of its own, because a producer that
   * establishes its own tenant scope is a producer that can be called with any
   * family id from anywhere.
   */
  async sweepFamily(input: {
    familyId: string;
    businessDate: BusinessDate;
    now: Date;
  }): Promise<StalledGoalSweepReport> {
    const candidates = await this.findStalled(input.familyId, input.businessDate, input.now);
    if (candidates.length === 0) return EMPTY_STALLED_GOAL_REPORT;

    let produced = 0;
    let alreadyDecided = 0;
    let refused = 0;

    for (const candidate of candidates) {
      const outcome = await this.tell(input.familyId, candidate, input.now);
      if (outcome === 'PRODUCED') produced += 1;
      else if (outcome === 'ALREADY_DECIDED') alreadyDecided += 1;
      else refused += 1;
    }

    if (produced > 0) {
      // Counts and one family id prefix, same discipline as the rollover's own
      // log line. No child id, no goal title.
      this.logger.log(
        `goal.stalled_swept family=${input.familyId.slice(0, 8)} businessDate=${input.businessDate} ` +
          `candidates=${candidates.length} produced=${produced} alreadyDecided=${alreadyDecided} refused=${refused}`,
      );
    }

    return { candidates: candidates.length, produced, alreadyDecided, refused };
  }

  /**
   * ONE CANDIDATE, THROUGH THE ENGINE'S REAL ENTRY POINT.
   *
   * `trigger: 'PERIODIC_SIGNAL'` because that is what this is — `NOTIFICATION_TRIGGERS`
   * documents that member as «a periodic signal scan produced a candidate», and
   * it is deliberately not `DOMAIN_EVENT`: there is no event, and claiming one
   * on the ledger row would make the trigger column a lie about how the product
   * learned this.
   *
   * THE FACTS PASSED ARE THE ROW'S, not a summary of it: the goal's own Arabic
   * title (`reward_programs.target_summary_ar`, which the parent wrote and the
   * child already sees), zero completed units, the target's unit count, and NO
   * deadline — `DEADLINE_PROXIMITY` then contributes zero, which is the honest
   * reading for a goal whose day is over rather than a guessed urgency.
   */
  private async tell(
    familyId: string,
    candidate: StalledGoalCandidate,
    now: Date,
  ): Promise<'PRODUCED' | 'ALREADY_DECIDED' | 'REFUSED'> {
    try {
      const result = await this.notifications.handleEvent({
        familyId,
        childId: candidate.childId,
        eventType: 'GOAL_STALLED_PARENT',
        sourceEventId: forEntity('signal', candidate.childId, candidate.programId, candidate.businessDate),
        trigger: 'PERIODIC_SIGNAL',
        goal: {
          title: candidate.goalTitle,
          completedUnits: 0,
          totalUnits: candidate.totalUnits,
          minutesRemaining: null,
        },
        now,
      });

      // A NULL decision id is the ledger's unique key refusing a cause it has
      // already recorded — the idempotency guarantee, read as the absence of a
      // returned id rather than as a boolean somebody could forget to check.
      if (result.decisionId === null) return 'ALREADY_DECIDED';
      return result.decision.verdict === 'SUPPRESS' ? 'REFUSED' : 'PRODUCED';
    } catch (err) {
      this.logger.warn(
        `goal.stalled_notify_failed family=${familyId.slice(0, 8)} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'REFUSED';
    }
  }

  private async findStalled(
    familyId: string,
    businessDate: BusinessDate,
    now: Date,
  ): Promise<StalledGoalCandidate[]> {
    const rows: StalledGoalRow[] = await this.raw().$queryRawUnsafe<StalledGoalRow[]>(
      SQL_LIST_STALLED_GOALS,
      familyId,
      businessDate,
      now,
    );

    return rows.map((row) => ({
      childId: row.child_id,
      programId: row.program_id,
      goalTitle: row.goal_title,
      businessDate,
      totalUnits: stalledGoalUnits(row.target_spec),
    }));
  }

  /**
   * The same structural cast, for the same reason, as `JobRunner.prismaRaw()`:
   * this code must work against both the extended production client and the
   * WASM-engine client the tenancy proof suites build, and naming a generated
   * type would bind it to one of them.
   */
  private raw(): { $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T> } {
    return this.prisma as any;
  }
}

/** The four columns `SQL_LIST_STALLED_GOALS` returns, and not one more. */
interface StalledGoalRow {
  readonly child_id: string;
  readonly program_id: string;
  readonly goal_title: string;
  readonly target_spec: unknown;
}
