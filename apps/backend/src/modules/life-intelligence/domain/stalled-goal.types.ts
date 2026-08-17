import type { BusinessDate } from '../../../common/time/family-date';

/**
 * SPRINT F1 — THE VOCABULARY OF A STALLED GOAL, AND THE ARGUMENT FOR WHY THE
 * CONDITION IS DETERMINISTIC RATHER THAN PREDICTED.
 *
 * `GOAL_STALLED_PARENT` had a sentence, a quiet-hours class, an urgency weight
 * and an achievement baseline, and NO PRODUCER — the finding `e2e-14` recorded
 * and pinned at zero. The reason it was never built is stated in that file: a
 * goal NOT being finished emits no domain event, so there is nothing for a
 * consumer to subscribe to. The absence of an event is not the absence of a
 * FACT, and the fact is already in two tables:
 *
 *   `achievement_requests`  the child OPENED an attempt: `status` is
 *                           REQUESTED/IN_PROGRESS, `started_at` is set, and
 *                           `submitted_at` / `decided_at` are both NULL. The
 *                           row also carries `local_date` — the FAMILY-LOCAL
 *                           calendar day the attempt belongs to, decided by
 *                           `AchievementService.start` before the row was
 *                           written.
 *   `reward_programs`       the goal is still something a parent could nudge
 *                           about: `status = 'ACTIVE'`, `archived_at IS NULL`,
 *                           and not past `expires_at`.
 *
 * SO THE CONDITION IS A ROW STATE AT THE END OF A DAY THAT IS OVER, and it
 * needs no model, no threshold and no guess:
 *
 *   THE FAMILY'S DAY `D` HAS CLOSED, AND AN ATTEMPT DATED `D` IS STILL OPEN,
 *   AND NOTHING FOR THAT (child, program, D) WAS EVER SUBMITTED OR VERIFIED,
 *   AND THE PROGRAM IS STILL ACTIVE.
 *
 * WHAT WAS DELIBERATELY NOT BUILT, and each rejection is the same rejection —
 * it would have required inventing a number the schema does not hold:
 *
 *   «the child is BEHIND SCHEDULE mid-day»   would need an expected-progress
 *                                            curve. There is no per-goal
 *                                            deadline column and no partial
 *                                            progress column: `AchievementRequest`
 *                                            records elapsed minutes only AT
 *                                            submission. Anything else is a
 *                                            guess with a confidence interval.
 *   «the child usually finishes by 6pm»      a behavioural baseline, i.e. the
 *                                            speculative AI feature this
 *                                            explicitly must not become.
 *   «duration_minutes has elapsed»           `duration_minutes` is the length
 *                                            of the ACTIVITY, not a window the
 *                                            child promised to start it in. A
 *                                            twenty-minute memorisation opened
 *                                            at 09:00 and finished at 20:00 is
 *                                            a completed goal, not a stalled
 *                                            one, and a grace period on top
 *                                            would be a made-up constant.
 *
 * The day boundary is the only line in this data that is BOTH a real product
 * moment and a fact the database already holds — and it is the family's own
 * boundary, which is why every function here takes a `BusinessDate` that was
 * derived from `Family.timezone` and never a `Date` it could re-derive.
 */

/** One (child, program) whose day closed with the attempt still open. */
export interface StalledGoalCandidate {
  readonly childId: string;
  readonly programId: string;
  /** `reward_programs.target_summary_ar` — the Arabic the parent typed, already
   * derived server-side. It is what goes inside the sentence, so the producer
   * never composes a title of its own. */
  readonly goalTitle: string;
  /** The family-local day the attempt belonged to, and the day the notification
   * is deduplicated on. */
  readonly businessDate: BusinessDate;
  /** How many units the goal asked for, when the target spec states a countable
   * one. `0` means "this activity has no unit count", which the scorer reads as
   * «no completion attached» rather than as «zero of zero done». */
  readonly totalUnits: number;
}

/** What one family's sweep did. Counts only — no ids, nothing a log aggregator
 * turns into a profile, the same rule `JobOutcome.details` states. */
export interface StalledGoalSweepReport {
  /** Rows the condition matched. */
  readonly candidates: number;
  /** Decisions the engine actually recorded — i.e. new causes. */
  readonly produced: number;
  /** Candidates whose cause had already been decided: the ledger's unique key
   * refused the second row and `handleEvent` returned a null decision id. */
  readonly alreadyDecided: number;
  /** Candidates the engine looked at and refused to send (fatigue, floor,
   * preference). Counted separately from `produced` because «the engine said
   * no» and «this was a duplicate» are different facts. */
  readonly refused: number;
}

export const EMPTY_STALLED_GOAL_REPORT: StalledGoalSweepReport = Object.freeze({
  candidates: 0,
  produced: 0,
  alreadyDecided: 0,
  refused: 0,
});

/**
 * HOW MANY UNITS THE GOAL ASKED FOR — from the target spec the parent wrote,
 * and `0` when the activity has no countable unit.
 *
 * WHY ZERO RATHER THAN ONE for an uncountable target. `notification-scoring.ts`
 * treats `totalUnits > 0 && completedUnits >= totalUnits` as «the goal was
 * completed» and scores it as an achievement. A default of `1` on a goal that
 * was NOT completed is harmless only until somebody passes `completedUnits: 1`
 * for a partially-done target; `0` cannot be misread, and the scorer's own
 * comment («no reward or completion attached») is then the honest note.
 *
 * Pure, and it takes the spec as an unknown because it comes out of a `jsonb`
 * column: a driver may hand it back parsed or as text, and neither shape is
 * this function's caller's problem.
 */
export function stalledGoalUnits(spec: unknown): number {
  const s = parseSpec(spec);
  if (!s) return 0;

  const from = positiveInt(s.fromAyah);
  const to = positiveInt(s.toAyah);
  if (from !== null) {
    // A single ayah is one unit; `toAyah` below `fromAyah` is not a range this
    // function repairs — `validateTargetSpec` already refused it at write time.
    if (to === null) return 1;
    return to >= from ? to - from + 1 : 1;
  }

  const quantity = positiveInt(s.quantity);
  if (quantity !== null) return quantity;

  return 0;
}

function parseSpec(spec: unknown): Record<string, unknown> | null {
  if (typeof spec === 'string') {
    try {
      const parsed: unknown = JSON.parse(spec);
      return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return spec !== null && typeof spec === 'object' ? (spec as Record<string, unknown>) : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
