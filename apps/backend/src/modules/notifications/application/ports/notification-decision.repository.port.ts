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
  /**
   * SPRINT F1 — THE TWO FIELDS THAT MAKE `ai_rewritten = false` READABLE.
   *
   * `aiAllowed` is the PERMISSION at the instant of composition (the feature
   * flag AND a bound provider); `aiInvoked` is whether the model was actually
   * entered. Both are produced by `NotificationComposerService.compose`, which
   * has always computed them and until now threw them away — see
   * `ComposedNotification.aiAllowed` for the four histories that were
   * indistinguishable without them.
   */
  readonly aiAllowed: boolean;
  readonly aiInvoked: boolean;
  /**
   * The safety layer's closed refusal reason, or `null` when nothing was
   * refused. `ComposedNotification.safetyRejection`, persisted rather than
   * discarded: it is what separates «the model answered and we said no» from
   * «the model answered the same sentence back».
   */
  readonly aiSafetyRejection: string | null;
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
  readonly aiAllowed: boolean;
  readonly aiInvoked: boolean;
  readonly aiSafetyRejection: string | null;
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

/**
 * ONE BUCKET OF A BREAKDOWN — a named slice of the ledger and its six counts.
 *
 * `bucket` is the VALUE of the dimension being grouped on: `'PARENT'`,
 * `'DOMAIN_EVENT'`, `'rule-based-v1'`, `'2026-01-15'`, `'REWARD_GRANTED'`. It
 * is a column this codebase writes, never anything a user typed and never an
 * identifier — which is what makes a platform-wide table of these safe to show.
 *
 * BOTH SIDES OF THE DISAGREEMENT ARE ON EVERY ROW. `decidedSend/Defer/Suppress`
 * is what the ENGINE concluded; `delivered` and `deliveryErrors` are what the
 * PIPELINE then did. «SOURCE = SAFETY_SIGNAL, decided 400 sends, delivered 12»
 * is the row an operator is looking for, and it is legible only because the two
 * sit side by side.
 */
export interface DecisionBreakdownBucket {
  readonly bucket: string;
  readonly total: number;
  readonly decidedSend: number;
  readonly decidedDefer: number;
  readonly decidedSuppress: number;
  readonly delivered: number;
  readonly deliveryErrors: number;
}

/**
 * THE OPERATIONAL VIEW OF THE DECISION LOG — counts only, no identity.
 *
 * DELIBERATELY NOT A SUPERSET OF `DecisionAnalyticsReport`. That report answers
 * «what is the platform's suppression rate»; this one answers «WHERE is the
 * suppression». It carries no rates at all: a rate per bucket invites division
 * by a bucket total of 3, and the roll-up already owns the one denominator this
 * product has agreed on.
 *
 * `totals` comes from the SAME grouping-set scan as the dimensions, so the sum
 * of any dimension's buckets equals `totals` by construction rather than by
 * hope. The two TOP-N lists are the exception and they say so: `byNotificationType`
 * and `topCauses` are TRUNCATED, therefore do NOT sum to `totals`, and
 * `limits.*Truncated` is what lets the dashboard say that out loud instead of
 * letting an operator subtract and find a hole.
 */
export interface DecisionBreakdownReport {
  /** Echoed back RESOLVED, not as the caller sent them — the caller may have
   * sent nothing at all and defaults applied. A page that prints the window it
   * is actually showing cannot mislabel its own numbers. */
  readonly fromBusinessDate: string;
  readonly toBusinessDate: string;
  readonly totals: DecisionBreakdownBucket;
  readonly byAudience: readonly DecisionBreakdownBucket[];
  readonly byNotificationType: readonly DecisionBreakdownBucket[];
  readonly bySource: readonly DecisionBreakdownBucket[];
  readonly byProvenance: readonly DecisionBreakdownBucket[];
  readonly byDate: readonly DecisionBreakdownBucket[];
  readonly topCauses: readonly DecisionBreakdownBucket[];
  /** The caps that produced this response, and whether either top-N list hit
   * one. Reported rather than assumed, because «is this the whole list» is the
   * first question a truncated list raises, and the dashboard must be able to
   * answer it without hard-coding the constant a second time. */
  readonly limits: {
    readonly topLimit: number;
    readonly maxRangeDays: number;
    readonly typesTruncated: boolean;
    readonly causesTruncated: boolean;
  };
}

/** The caps, passed IN rather than read from a constant in the repository, so
 * the ROUTE owns its own bounds and no caller can reach this query without
 * having stated one. */
export interface DecisionBreakdownCaps {
  readonly topLimit: number;
  readonly maxRangeDays: number;
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

  /** The platform breakdown behind it: the same population, sliced by audience,
   * type, source, provenance, date and cause. CROSS-TENANT by design, counts
   * only, and bounded by `caps` in both directions. */
  breakdown(
    filter: DecisionAnalyticsFilter,
    caps: DecisionBreakdownCaps,
  ): Promise<DecisionBreakdownReport>;
}

export const NOTIFICATION_POLICY_REPOSITORY = Symbol('NOTIFICATION_POLICY_REPOSITORY');

export interface INotificationPolicyRepository {
  /** Raw key/value rows for one family. Resolution into a `NotificationPolicy`
   * is `resolveNotificationPolicy`'s job — the repository does not interpret. */
  readSettings(familyId: string): Promise<Record<string, string>>;
  /** Validated against `NOTIFICATION_POLICY_SCHEMAS` before it reaches SQL. */
  upsertSetting(familyId: string, key: string, value: string, updatedBy: string | null): Promise<void>;
}
