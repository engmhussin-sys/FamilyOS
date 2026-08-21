import type { AiAlertStatus } from '../../ai-core/domain/ai-alert.types';

/**
 * ===========================================================================
 * THE FOURTEEN TRANSITIONS AN ALERT MAY MAKE — three of which never existed.
 * ===========================================================================
 *
 * `AlertStatus` has had four values since the table was created and exactly ONE
 * of them was reachable. `PrismaAiAlertRepository` pins the fact in its own
 * types (`_statusIsExhaustive: AlertStatus = 'NEW'`), and nothing anywhere
 * could move an alert out of `NEW`. Every distress signal this product has
 * raised is, right now, unreviewed — and a growth alarm counts exactly those
 * and could therefore only ever climb.
 *
 * ── WHY A TABLE AND NOT `if` STATEMENTS ────────────────────────────────
 *
 * The same reason the pairing state machine has one: the legal moves are then
 * a value that a test can enumerate, rather than a shape spread across
 * handlers. `safety-review.spec.ts` asserts properties OF this table — that
 * nothing may reach `NEW` except a reopen, that no move is a no-op, that every
 * status is reachable — none of which is assertable about scattered `if`s.
 *
 * ── WHY DISMISSED AND REVIEWED ARE BOTH TERMINAL-ISH ───────────────────
 *
 * They are different claims. REVIEWED means «a human looked and acted».
 * DISMISSED means «a human looked and this was not what it seemed». Collapsing
 * them would lose the only signal that tells the safety desk whether the
 * DETECTOR is working: a queue that is 90% dismissed is a detector problem, and
 * a queue that is 90% reviewed is a child-safety workload.
 *
 * ── AND WHY REOPEN EXISTS ──────────────────────────────────────────────
 *
 * Because people are wrong. A dismissal made at 2am on thin information has to
 * be undoable, and the alternative — a second, duplicate alert — would break
 * the `(familyId, sourceEventId)` uniqueness that stops a replayed detection
 * from becoming two alerts.
 *
 * NOTHING HERE DELETES. There is no transition to a removed state, no archive,
 * and no route that drops a row: the directive is categorical that an operator
 * may not delete safety history, and the closest an alert comes to going away
 * is DISMISSED, which is a decision somebody signed.
 */

export interface SafetyTransition {
  readonly from: AiAlertStatus;
  readonly to: AiAlertStatus;
  /** Which permission the actor must hold. One per transition, never a list. */
  readonly permission: 'safety.review' | 'safety.escalate';
}

export const SAFETY_TRANSITIONS: readonly SafetyTransition[] = [
  // A fresh alert: looked at, waved off, or pushed up.
  { from: 'NEW', to: 'REVIEWED', permission: 'safety.review' },
  { from: 'NEW', to: 'DISMISSED', permission: 'safety.review' },
  { from: 'NEW', to: 'ESCALATED', permission: 'safety.escalate' },

  // An escalation ends somewhere. It cannot go back to NEW: «we escalated this
  // and then pretended nobody had seen it» is not a state this product offers.
  { from: 'ESCALATED', to: 'REVIEWED', permission: 'safety.review' },
  { from: 'ESCALATED', to: 'DISMISSED', permission: 'safety.review' },

  // Reopening. The ONLY way back to NEW, and it is deliberately available from
  // both settled states — a wrong review is as reopenable as a wrong dismissal.
  { from: 'REVIEWED', to: 'NEW', permission: 'safety.review' },
  { from: 'DISMISSED', to: 'NEW', permission: 'safety.review' },

  // And a settled alert may still be escalated: new information arrives after
  // somebody has already closed it, which is exactly when escalation matters.
  { from: 'REVIEWED', to: 'ESCALATED', permission: 'safety.escalate' },
  { from: 'DISMISSED', to: 'ESCALATED', permission: 'safety.escalate' },
];

export class IllegalSafetyTransitionError extends Error {
  constructor(
    readonly from: AiAlertStatus,
    readonly to: AiAlertStatus,
  ) {
    super(`An alert cannot move from ${from} to ${to}.`);
    this.name = 'IllegalSafetyTransitionError';
  }
}

/** The legal move, or null. Pure — no clock, no database, no context. */
export function findTransition(from: AiAlertStatus, to: AiAlertStatus): SafetyTransition | null {
  return SAFETY_TRANSITIONS.find((rule) => rule.from === from && rule.to === to) ?? null;
}

/**
 * Whether an alert in this state still needs somebody. `NEW` and `ESCALATED`
 * both do, for different reasons, and the queue's default filter is this
 * predicate rather than `status = 'NEW'` — an escalation that nobody comes back
 * to is the failure mode escalation creates.
 */
export function isOpen(status: AiAlertStatus): boolean {
  return status === 'NEW' || status === 'ESCALATED';
}
