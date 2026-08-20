/**
 * PHASE D (GROWTH) — `CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL`.
 *
 * THE ACTIVATION METRIC. It is worth more than every other number this module
 * produces, because it is the only one that predicts the others: a family that
 * reaches it retains, and a family that does not, does not — and the whole
 * product thesis (CONTEXT §1: sell GROWTH, not FEAR; the wedge is child
 * circumvention) lives or dies on whether a CHILD, not a parent, actually
 * completed something and was actually rewarded for it.
 *
 * SO "MEANINGFUL" HAS TO BE DEFINED PRECISELY, OR THE METRIC IS DECORATION.
 * A definition that admits a parent tapping "done" on a goal they created ten
 * seconds earlier measures curiosity about the UI. This is the definition, and
 * all four gates must hold:
 *
 *   GATE 1 — REAL, AND SERVER-DECIDED.
 *     The completion arrived as a `REWARD_GRANTED` domain event. That event has
 *     exactly one producer in this codebase (`RewardsCompletionConsumer`) and
 *     is emitted only after the LEDGER confirms a grant exists (Phase C
 *     `PC-B-001`). A device cannot originate it — it is not in
 *     `DEVICE_INGESTIBLE_EVENT_TYPES` — so activation cannot be self-declared,
 *     which is the same defence the reward path itself uses.
 *
 *   GATE 2 — A GOAL, NOT AN ARTEFACT OF ONE.
 *     `completionKind` must be in `MEANINGFUL_COMPLETION_KINDS`. `STREAK` is
 *     deliberately EXCLUDED: a streak is derived from completions that were
 *     already counted, and admitting it would let one behaviour activate a
 *     family twice — or, worse, let the streak (which fires later) be the thing
 *     that "activated" a family the first real completion already activated.
 *
 *   GATE 3 — NOT A DEMONSTRATION.
 *     At least `minMinutesAfterChildCreated` (default 60, ADMIN-CONFIGURABLE)
 *     must have elapsed between the child row being created and the completion.
 *     A parent who adds a child and ticks a goal in the same minute is showing
 *     the app to somebody. The threshold is a business decision and is a row in
 *     `growth_settings`, not a constant in this file — see the HUMAN DECISION
 *     note in the Phase D Growth report.
 *
 *   GATE 4 — FIRST, AND ONLY ONCE.
 *     `family_activations.family_id` is UNIQUE. The idempotency is the database
 *     constraint, not an application "check then insert" (CONTEXT §3 principle
 *     6). Two concurrent qualifying completions produce one activation row.
 *
 * TIME-TO-VALUE is `activation.occurredAt − family.createdAt`, stored in
 * MINUTES as an integer on the activation row so the median is computed from
 * stored facts and never recomputed from two timestamps in two timezones.
 *
 * WHAT IS DELIBERATELY *NOT* IN THE DEFINITION: which child, which goal, which
 * app. The activation row carries a family id, a timestamp, a duration and the
 * name of the rule version that admitted it. It does not carry `childId` —
 * CONTEXT §3 principle 8, and §5 of `growth-events.ts`.
 */
import type { CompletionKind } from '../../../shared/events/completion-event';

/**
 * The completion kinds that can activate a family. Five of the six that exist;
 * see GATE 2 for why `STREAK` is not here.
 */
export const MEANINGFUL_COMPLETION_KINDS: ReadonlySet<CompletionKind> = new Set<CompletionKind>([
  'HABIT',
  'TASK',
  'HEALTH_GOAL',
  'LEARNING_SESSION',
  'FAITH_SESSION',
  'ACHIEVEMENT',
]);

/**
 * The rule version stamped onto every activation row.
 *
 * Changing the definition of activation changes the metric, and a metric whose
 * definition changed silently is worse than no metric. Every row records which
 * rule admitted it, so a later change is visible as a discontinuity that can be
 * segmented rather than as an unexplained step in a chart.
 */
export const ACTIVATION_RULE_VERSION = 'MEANINGFUL_GOAL_V1';

export interface IActivationCandidate {
  readonly familyId: string;
  readonly completionKind: CompletionKind;
  /** How many ledger grants the originating REWARD_GRANTED reported. */
  readonly grantCount: number;
  /** When the child row this completion belongs to was created. */
  readonly childCreatedAt: Date;
  /** When the completion happened (server clock, from the domain event). */
  readonly occurredAt: Date;
  /** When the family registered — the start of the time-to-value clock. */
  readonly familyCreatedAt: Date;
}

export type ActivationRejection =
  | 'NOT_A_MEANINGFUL_KIND'
  | 'NO_REWARD_GRANTED'
  | 'TOO_SOON_AFTER_CHILD_CREATED'
  | 'CLOCK_INCONSISTENT';

export interface IActivationDecision {
  readonly qualifies: boolean;
  readonly rejection: ActivationRejection | null;
  /** Minutes from registration to activation. Present only when it qualifies. */
  readonly timeToValueMinutes: number | null;
  readonly ruleVersion: string;
}

const MINUTE_MS = 60_000;

/**
 * The gates, applied in order, as a PURE function of the candidate and the
 * configured threshold. No clock, no database, no I/O — so the definition is
 * testable as a definition, and the test that pins it is the specification.
 */
export function evaluateActivation(
  candidate: IActivationCandidate,
  minMinutesAfterChildCreated: number,
): IActivationDecision {
  const base = { ruleVersion: ACTIVATION_RULE_VERSION, timeToValueMinutes: null } as const;

  // GATE 2 — checked before GATE 1's numeric guard because it is the cheaper
  // and more common rejection (streak events are frequent).
  if (!MEANINGFUL_COMPLETION_KINDS.has(candidate.completionKind)) {
    return { ...base, qualifies: false, rejection: 'NOT_A_MEANINGFUL_KIND' };
  }

  // GATE 1 — the ledger said a grant exists. `REWARD_GRANTED` is only emitted
  // with a non-zero count, so a zero here means the payload was malformed;
  // rejecting is the safe direction (an activation that never happened is
  // unrecoverable, a missed one is re-emitted by the next completion).
  if (!Number.isInteger(candidate.grantCount) || candidate.grantCount < 1) {
    return { ...base, qualifies: false, rejection: 'NO_REWARD_GRANTED' };
  }

  const elapsedSinceChild = candidate.occurredAt.getTime() - candidate.childCreatedAt.getTime();
  const timeToValueMs = candidate.occurredAt.getTime() - candidate.familyCreatedAt.getTime();

  // A completion that predates the family or the child is a clock problem, not
  // an activation. It is rejected rather than clamped, because clamping would
  // put a 0-minute time-to-value into the median.
  if (elapsedSinceChild < 0 || timeToValueMs < 0) {
    return { ...base, qualifies: false, rejection: 'CLOCK_INCONSISTENT' };
  }

  // GATE 3.
  if (elapsedSinceChild < minMinutesAfterChildCreated * MINUTE_MS) {
    return { ...base, qualifies: false, rejection: 'TOO_SOON_AFTER_CHILD_CREATED' };
  }

  return {
    qualifies: true,
    rejection: null,
    timeToValueMinutes: Math.floor(timeToValueMs / MINUTE_MS),
    ruleVersion: ACTIVATION_RULE_VERSION,
  };
}
