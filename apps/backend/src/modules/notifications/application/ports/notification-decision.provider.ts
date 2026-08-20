/**
 * PHASE F (`F6-002`) — THE SEAM.
 *
 * THE REQUIREMENT, stated as a test rather than as a hope: an
 * `AiNotificationDecisionProvider` must be able to replace
 * `RuleBasedNotificationDecisionProvider` WITHOUT TOUCHING ANYTHING ELSE.
 * `test/notifications/notification-provider-swap.e2e.spec.ts` proves it by
 * overriding this token with a stub and asserting that composition, safety,
 * policy, dedup and delivery all behave identically — because if the seam is
 * real, swapping it changes exactly one thing.
 *
 * WHY A PORT AND NOT AN ABSTRACT CLASS. `AI_PROVIDER` beside it in `ai-core` is
 * a `Symbol` + interface for the reason Decision-068 gives: there is exactly ONE
 * injection point and no feature can reach past it to address a concrete
 * implementation. Same shape, same reason.
 *
 * WHAT A PROVIDER MAY AND MAY NOT DO — and this is the boundary CONTEXT §3
 * principle 2 draws, expressed in a type:
 *
 *   MAY   decide SEND / DEFER / SUPPRESS, assign a band and a score, and say
 *         why in `components`.
 *   MAY   choose a copy key, so a smarter provider can pick a better sentence.
 *   MUST  return a `NotificationDecision`, which is a RECOMMENDATION about ONE
 *         candidate. It is then subject to the fatigue policy, the quiet-hours
 *         matrix, the idempotency indexes and the safety filter, ALL of which
 *         run downstream and none of which a provider can see or influence.
 *   CANNOT deliver, write a row, grant anything, name a recipient, bypass the
 *         approval gate, or read a database. The interface gives it a context
 *         and a policy and takes back a value; there is nothing else in scope.
 *
 * SYNCHRONOUS-OR-ASYNC on purpose. The rule-based provider is pure and
 * synchronous; a future model-backed one will not be. Declaring the return type
 * as a promise-or-value means adding the AI provider does not change the
 * caller's shape either.
 */

import type { NotificationContext } from '../../domain/engine/notification-context';
import type { NotificationDecision } from '../../domain/engine/notification-decision.types';
import type { NotificationPolicy } from '../../domain/engine/notification-policy';

export const NOTIFICATION_DECISION_PROVIDER = Symbol('NOTIFICATION_DECISION_PROVIDER');

/**
 * What the provider returns alongside the decision: the copy key it chose.
 *
 * Kept separate from `NotificationDecision` because the decision is PERSISTED
 * and the copy key is a rendering instruction — and because a provider that
 * returns an unknown key must degrade to `GENERIC` at render time without that
 * degradation being recorded as a different decision.
 */
export interface NotificationDecisionOutput {
  readonly decision: NotificationDecision;
  /** A key in `COPY_CATALOGUE`. An unknown value renders as `GENERIC`; it never
   * throws and never reaches a user as an enum. */
  readonly copyKey: string;
  /** Variables for the copy templates, merged over `context.event.variables` —
   * so a provider can add «this is the third time this week» without the
   * producer having had to know that sentence exists. */
  readonly copyVariables: Readonly<Record<string, string | number>>;
}

export interface NotificationDecisionProvider {
  /** Stable, short, used in logs, metrics and the persisted decision row.
   * `'rule-based'` today; `'ai'` for the future one. */
  readonly id: string;

  decide(
    context: NotificationContext,
    policy: NotificationPolicy,
  ): NotificationDecisionOutput | Promise<NotificationDecisionOutput>;
}
