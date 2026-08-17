/**
 * PHASE F (`F6-002`) — the decision ledger's port.
 *
 * A PORT for the reason `INotificationDeliveryRepository` is one: the engine
 * that writes these rows lives in `notification-engine/` and the table lives
 * here, and an interface is what keeps that a dependency on a contract rather
 * than on a Prisma model.
 *
 * NOTE WHAT IS NOT ON IT: anything that DELIVERS, and anything that returns a
 * title or a body. This interface reads and writes DECISIONS. The notification
 * itself is `notifications` / `child_messages`' business and neither of those is
 * reachable from here.
 */

import type {
  NotificationDecision,
  NotificationDecisionVerdict,
} from '../../domain/engine/notification-decision.types';

export const NOTIFICATION_DECISION_REPOSITORY = Symbol('NOTIFICATION_DECISION_REPOSITORY');

/** Everything the ledger stores that is NOT already on `NotificationDecision`:
 * the identity of the cause, and the analytics axes frozen at decision time. */
export interface RecordDecisionInput {
  readonly familyId: string;
  readonly childId: string | null;
  readonly sourceEventId: string;
  readonly decision: NotificationDecision;
  readonly eventType: string;
  readonly ageBand: string | null;
  readonly locale: string;
  readonly countryCode: string | null;
  readonly aiRewritten: boolean;
  readonly aiFailed: boolean;
  readonly copyKey: string;
  /** The family's own business date — «last month» means the household's month. */
  readonly businessDate: string;
}

/** One row as a support engineer reads it. `explanation` is the stored
 * arithmetic, returned verbatim. */
export interface DecisionLedgerRow {
  readonly id: string;
  readonly childId: string | null;
  readonly sourceEventId: string;
  readonly trigger: string;
  readonly eventType: string;
  readonly notificationType: string;
  readonly category: string;
  readonly targetAudience: string;
  readonly decision: string;
  readonly priorityBand: string;
  readonly score: number;
  readonly reason: string;
  readonly explanation: unknown;
  readonly providerId: string;
  readonly ageBand: string | null;
  readonly locale: string;
  readonly countryCode: string | null;
  readonly aiRewritten: boolean;
  readonly aiFailed: boolean;
  readonly copyKey: string;
  readonly outcome: string | null;
  readonly outcomeReason: string | null;
  readonly businessDate: string;
  readonly createdAt: Date;
}

/** The filters the Admin dashboard needs, and no others. Every one of them is
 * an axis §9 of the brief names. */
export interface DecisionAnalyticsFilter {
  readonly fromBusinessDate: string;
  readonly toBusinessDate: string;
  readonly countryCode: string | null;
  readonly ageBand: string | null;
  readonly audience: 'PARENT' | 'CHILD' | null;
  readonly category: string | null;
}

/**
 * COUNTS AND RATES, and nothing that names a household.
 *
 * Rates are returned as computed values rather than left to the caller, so that
 * the numerator and denominator of each one are decided in ONE place — the
 * failure mode of an analytics API is two callers dividing by two different
 * things and both being confident.
 */
export interface DecisionAnalyticsReport {
  readonly total: number;
  readonly decidedSend: number;
  readonly decidedDefer: number;
  readonly decidedSuppress: number;
  readonly delivered: number;
  readonly outcomeSuppressed: number;
  readonly duplicates: number;
  readonly fatigueBlocked: number;
  readonly deliveryFailures: number;
  readonly aiRewritten: number;
  readonly aiFailed: number;
  readonly opened: number;
  readonly notificationRows: number;
  readonly averageScore: number;
  readonly suppressionRate: number;
  readonly duplicateRate: number;
  readonly aiRewriteRate: number;
  /** Opened / notification rows written. `0` when nothing was written, never a
   * division by zero and never `NaN` on a dashboard. */
  readonly openRate: number;
  /**
   * A PROXY, and it is labelled one everywhere it appears. This product has no
   * deep-link attribution and no in-app action receipt, so «acted» cannot be
   * measured today. Reported as `null` rather than as a fabricated zero — an
   * honest absence, which is this codebase's standing rule for a number it does
   * not have.
   */
  readonly actionRate: number | null;
  readonly topTypes: readonly { readonly type: string; readonly total: number; readonly suppressed: number }[];
}

export interface INotificationDecisionRepository {
  /** `null` when `(family_id, source_event_id, target_audience)` already had a
   * row — a redelivered cause, correctly ignored, exactly as
   * `INotificationDeliveryRepository.enqueue` reports it. */
  record(input: RecordDecisionInput): Promise<string | null>;

  /** Records what the pipeline did. Scoped by family as well as by id. */
  recordOutcome(
    familyId: string,
    decisionId: string,
    outcome: NotificationDecisionVerdict,
    outcomeReason: string | null,
  ): Promise<void>;

  /** The household's own decisions, newest first. Tenant-scoped. */
  listForFamily(familyId: string, limit: number): Promise<DecisionLedgerRow[]>;

  /** The platform roll-up. CROSS-TENANT by design, counts only. */
  analytics(filter: DecisionAnalyticsFilter, topTypesLimit: number): Promise<DecisionAnalyticsReport>;
}

export const NOTIFICATION_POLICY_REPOSITORY = Symbol('NOTIFICATION_POLICY_REPOSITORY');

export interface INotificationPolicyRepository {
  /** Raw key/value rows for one family. Resolution into a `NotificationPolicy`
   * is `resolveNotificationPolicy`'s job — the repository does not interpret. */
  readSettings(familyId: string): Promise<Record<string, string>>;
  /** Validated against `NOTIFICATION_POLICY_SCHEMAS` before it reaches SQL. */
  upsertSetting(familyId: string, key: string, value: string, updatedBy: string | null): Promise<void>;
}
