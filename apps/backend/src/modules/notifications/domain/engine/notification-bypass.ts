/**
 * ============================================================================
 * THE LEDGER ENTRY FOR A NOTIFICATION THE ENGINE NEVER DECIDED.
 * ============================================================================
 *
 * WHAT WAS MEASURED, on a real PostgreSQL, driving a real distress check-in
 * through the real HTTP route (`e2e-16 ACT IV`): a child-safety escalation
 * produced ONE `ai_alerts` row, ONE `notifications` row for the parent, and
 * ZERO `notification_decisions` rows. The most important message this product
 * sends was invisible to `GET /system/notifications/analytics`, to
 * `GET /system/notifications/decision-breakdown` and to
 * `GET /notifications/decisions`.
 *
 * WHY IT WAS ZERO, AND WHY THAT HALF IS CORRECT. The two SYSTEM entries on
 * `ENGINE_BYPASS_ALLOWLIST` — `DistressEscalationService` and
 * `RuntimeAlertService` — deliberately do not enter
 * `SmartNotificationEngineService.handleEvent`, because that door has a scorer,
 * a fatigue cap and a quiet-hours matrix behind it and NONE of them may be
 * given the opportunity to silence a safety alert. The ledger, however, is
 * written from that same door and only from it, so «not scored» silently meant
 * «not recorded».
 *
 * WHAT THIS FILE IS. The vocabulary for recording those notifications WITHOUT
 * routing them through scoring. Nothing here decides anything: every value is
 * either a fact the producer already stated, a lookup in a table this codebase
 * already owns, or a constant that names the bypass itself. A bypass row is a
 * RECEIPT — «delivered, by bypass, because the producer classified it
 * safety-critical» — and it is deliberately NOT a manufactured decision that
 * pretends deliberation occurred.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR COLUMNS THAT CARRY THE PROVENANCE, AND WHY EACH ONE.
 *
 *   `provider_id`  = `safety-bypass`   THE DISCRIMINATOR, and it is the one
 *                    an operator sees WITHOUT reading a second column.
 *                    `provider_id` is the PROVENANCE dimension of
 *                    `GET /system/notifications/decision-breakdown` — «WHICH
 *                    decision provider produced this verdict» — and the honest
 *                    answer here is «none did». The provider abstraction exists
 *                    precisely so that question is askable, and a bypass is an
 *                    answer to it, not an absence of one.
 *
 *   `explanation`  = `[]`                 THE PROOF THAT NOTHING WAS SCORED.
 *                    On the engine's path this column holds the component-by-
 *                    component arithmetic. An empty array is not a missing
 *                    value: it is the statement that no term was ever weighed,
 *                    and it is what stops `score` below from being read as the
 *                    output of a calculation.
 *
 *   `reason`       = `SAFETY_CRITICAL_OVERRIDE`
 *                    THE SAME WORD THE ENGINE'S OWN OVERRIDE BRANCH WRITES.
 *                    `RuleBasedNotificationDecisionProvider` step 2 emits
 *                    exactly this reason, with exactly this band, for exactly
 *                    this class of notification — a DELIVER-class or
 *                    priority-overridden type that must not be weighed. Reusing
 *                    the word rather than minting a new one is deliberate: the
 *                    fact is the same fact, and a ledger with two vocabularies
 *                    for one fact is a ledger nobody can group by. It is also
 *                    the answer to «why was this not deferred at 22:00» — the
 *                    override outranks the night, which is `§11.4`'s rule.
 *
 *   `trigger`      = `SAFETY_SIGNAL`      THE SOURCE, kept inside the closed
 *                    eight-member `NOTIFICATION_TRIGGERS` vocabulary rather
 *                    than growing a ninth. Every producer that can reach this
 *                    path today is on `ENGINE_BYPASS_ALLOWLIST` classified
 *                    SYSTEM, and SYSTEM means exactly «a safety- or
 *                    integrity-critical condition». A new SOURCE bucket would
 *                    change the shape of an operator's table to say something
 *                    the PROVENANCE column already says better.
 *
 * ---------------------------------------------------------------------------
 * ON `score`, WHICH IS THE ONE COLUMN WITH NO NATURALLY TRUE VALUE.
 *
 * `notification_decisions.score` is `NOT NULL` and `CHECK (0..100)`, and a
 * bypassed notification was never scored. Three values were considered:
 *
 *   0    REJECTED. A scored row with `score = 0` is a row that fell below the
 *        floor and was SUPPRESSED; writing it beside `decision = 'SEND'` would
 *        make the row read as a defect and would drag the platform average
 *        toward a number no scorer produced.
 *   NULL REJECTED, though it is the most honest of the three. It costs a
 *        migration that widens `DecisionLedgerRow.score` to `number | null` on
 *        `GET /notifications/decisions` — an existing response contract with
 *        consumers this change does not own.
 *   100  CHOSEN, and it is a STATEMENT rather than a measurement: «unconditional
 *        — nothing could have lowered this». It is internally consistent with
 *        `decision = 'SEND'` and `priority_band = 'HIGH'`, which is an
 *        invariant the table really does hold (a band is derived from a score),
 *        and it cannot be mistaken for arithmetic because `explanation` is
 *        empty and `provider_id` names the bypass. It is also the direction the
 *        engine's own override branch moves the number — `Math.max(score.total,
 *        thresholdHigh)` — rather than against it.
 *
 * The value is a NAMED CONSTANT and not a literal at the call site precisely so
 * that this paragraph has somewhere to live.
 */

import {
  notificationCategoryOf,
  quietHoursClassOf,
} from '../../../../shared/notifications/notification-class';
import type {
  NotificationDecision,
  NotificationDecisionReason,
  NotificationPriorityBand,
  NotificationTrigger,
} from './notification-decision.types';

/**
 * THE PROVENANCE. Read as a `provider_id`: «no decision provider produced this
 * verdict; the producer bypassed the engine under the safety rule».
 *
 * SPELLED LIKE `NotificationDecisionProvider.id` — `rule-based` is the only
 * other value this column has ever held, and a bypass sitting beside it in the
 * PROVENANCE column of an operator's table has to read as a member of the same
 * vocabulary, not as an escape from it.
 *
 * FORTY CHARACTERS IS THE COLUMN. `notification_decisions.provider_id` is
 * `VARCHAR(40)`; this is 13.
 */
export const ENGINE_BYPASS_PROVENANCE = 'safety-bypass';

/** See the header: a statement of unconditionality, not a measurement. */
export const ENGINE_BYPASS_SCORE = 100;

/** The SOURCE dimension, inside the closed vocabulary. See the header. */
export const ENGINE_BYPASS_TRIGGER: NotificationTrigger = 'SAFETY_SIGNAL';

/** The same reason `RuleBasedNotificationDecisionProvider`'s override branch
 * writes, for the same fact. See the header. */
export const ENGINE_BYPASS_REASON: NotificationDecisionReason = 'SAFETY_CRITICAL_OVERRIDE';

/** The same band that branch writes, and the band `ENGINE_BYPASS_SCORE` implies. */
export const ENGINE_BYPASS_BAND: NotificationPriorityBand = 'HIGH';

/**
 * IS THIS ROW A BYPASS? One predicate, so that the analytics layer, the tests
 * and any future dashboard all ask the question the same way instead of three
 * of them hard-coding the string.
 */
export function isEngineBypassProvenance(providerId: string | null | undefined): boolean {
  return providerId === ENGINE_BYPASS_PROVENANCE;
}

export interface EngineBypassCause {
  /** `notification-class.ts`'s type — the thing the matrix and the copy
   * catalogue are keyed on. `RUNTIME_ALERT` when the producer named none. */
  readonly notificationType: string;
  /** The producer's own assertion about loudness, passed through untouched. */
  readonly priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
}

/**
 * THE ROW'S DECISION HALF, AS A VALUE — pure, total, and free of Nest, Prisma
 * and the clock, so the test that pins these columns can call it directly.
 *
 * `targetAudience` IS `PARENT` AND CANNOT BE ANYTHING ELSE, for
 * `PrismaRuntimeAlertRepository.withDestination`'s stated reason: the single
 * writer this path reaches writes `notifications`, whose recipient is resolved
 * as the family's owner. The child's half of the product is `child_messages`, a
 * different writer, which no bypass producer reaches.
 *
 * NOTHING HERE IS DERIVED FROM THE CHILD'S WORDS, and nothing could be: the
 * input is a notification TYPE and a PRIORITY. `DistressEscalationService`
 * keeps the free text and even the classification code inside its own method
 * (`§11.4` properties 2 and 3), and this function is given neither — so the
 * ledger cannot become the back door to a child's sentence even by accident.
 */
export function engineBypassDecision(cause: EngineBypassCause): NotificationDecision {
  return {
    trigger: ENGINE_BYPASS_TRIGGER,
    // IT WAS SENT. The verdict column records what happened, and what happened
    // is that a notification row was written and a phone was pushed.
    verdict: 'SEND',
    band: ENGINE_BYPASS_BAND,
    score: ENGINE_BYPASS_SCORE,
    reason: ENGINE_BYPASS_REASON,
    // THE PROOF THAT NOTHING WAS WEIGHED. See the header.
    components: [],
    notificationType: cause.notificationType,
    // The SAME map the engine reads, asked the same question. A bypass row that
    // invented its own category would be invisible to the `category` filter
    // every analytics surface offers.
    category: notificationCategoryOf(cause.notificationType),
    targetAudience: 'PARENT',
    priority: cause.priority,
    providerId: ENGINE_BYPASS_PROVENANCE,
  };
}

/**
 * WHAT THE QUIET-HOURS MATRIX SAYS ABOUT THIS TYPE — exported so the bypass
 * path's log line and its tests can state the premise rather than assume it.
 *
 * It is NOT stored: there is no column for it, and inventing one would be a
 * dormant column of the kind `dormant-schema.guard.spec.ts` exists to refuse.
 * `reason = SAFETY_CRITICAL_OVERRIDE` is the stored form of the same sentence.
 */
export function engineBypassQuietHoursClass(cause: EngineBypassCause): string {
  return quietHoursClassOf(cause.notificationType, cause.priority);
}
