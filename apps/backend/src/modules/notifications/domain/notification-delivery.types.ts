/**
 * PHASE D (`PC-D-005`) — the vocabulary of a deferred notification.
 *
 * Everything here is data or a pure type; the engine that acts on it lives in
 * `quiet-hours-release.service.ts` and the SQL it acts through in
 * `notification-delivery.sql.ts`. Same separation, and for the same reason, as
 * `scheduler/domain/job.types.ts`: the anti-flood decision must be provable as
 * a pure function of (rows, now), and it is — see `coalesce-and-digest.ts`.
 */

/**
 * The five states, closed by a CHECK constraint in migration 0014 as well as
 * by this union. There is no «unknown» and no sixth.
 */
export type NotificationDeliveryState =
  | 'PENDING'
  | 'DELIVERING'
  | 'DELIVERED'
  | 'SUPPRESSED'
  | 'DEAD';

/**
 * WHY A ROW EXISTS. One value today; declared as a union rather than a literal
 * because the next reason (a device with no push token yet, a parent who has
 * not finished onboarding) will be a second member, and a column that already
 * holds a vocabulary is cheaper than a column that has to grow one.
 */
export type DeferReason = 'QUIET_HOURS';

/**
 * WHY A ROW WILL NEVER BE DELIVERED. Every one of these is written to
 * `resolution_reason`, which migration 0014 makes NOT NULL for the two resolved
 * states — because «dropped with a recorded reason» and «dropped» differ by
 * exactly this column, and that difference is the subject of this whole phase.
 */
export type ResolutionReason =
  /** The fatigue guard refused it AT DELIVERY TIME, not at enqueue time. */
  | 'COOLDOWN'
  | 'DAILY_MAX'
  | 'CATEGORY_MAX'
  | 'DUPLICATE'
  /** A newer notification of the same (audience, type) superseded it. */
  | 'COALESCED'
  /** Folded into the morning digest instead of being sent on its own. */
  | 'DIGESTED'
  /** The delivery path reported «already delivered» — B9's unique index. */
  | 'ALREADY_NOTIFIED'
  /** Attempts exhausted. The only reason that pairs with state DEAD. */
  | 'MAX_ATTEMPTS'
  /** Re-deferred more times than the cap allows; see RELEASE_DEFAULTS. */
  | 'MAX_DEFERRALS'
  /** No recipient could be resolved — the family has no members left. */
  | 'NO_RECIPIENT';

/** A deferred row as the release path reads it. */
export interface DeferredNotificationRow {
  readonly id: string;
  readonly familyId: string;
  readonly childId: string | null;
  readonly type: string;
  readonly category: string;
  readonly priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
  readonly targetAudience: 'PARENT' | 'CHILD';
  readonly title: string;
  readonly body: string;
  readonly sourceEventId: string;
  readonly scheduledFor: Date;
  readonly businessDate: string;
  readonly attemptCount: number;
  readonly createdAt: Date;
}

/** What the enqueue side is handed. `scheduledFor` is computed by the caller
 * from `FamilyDateService`, never here — this layer does not own a calendar. */
export interface EnqueueDeferredInput {
  readonly familyId: string;
  readonly childId: string | null;
  readonly type: string;
  readonly category: string;
  readonly priority: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
  readonly targetAudience: 'PARENT' | 'CHILD';
  readonly title: string;
  readonly body: string;
  readonly sourceEventId: string;
  readonly deferReason: DeferReason;
  readonly scheduledFor: Date;
  readonly businessDate: string;
}

/** The operator gauge — the same shape `DeadLetterReport` has, on purpose. */
export interface DeliveryBacklogReport {
  readonly pending: number;
  readonly dead: number;
  readonly oldestPendingAgeSeconds: number;
  readonly deadByType: readonly { readonly type: string; readonly count: number }[];
}

export const RELEASE_DEFAULTS = {
  /**
   * How many families one sweep releases for. Bounded for the same reason the
   * scheduler's family fan-out is: an unbounded loop over 60,000 households
   * inside one tick would outlive its own lease and be stolen mid-flight. The
   * remainder is picked up by the next tick five minutes later, and the row
   * state makes that resumption free — there is no cursor to persist.
   */
  familyBatchSize: 100,
  /** How many deferred rows one family's release considers in one pass. */
  perFamilyLimit: 200,
  /**
   * THE ANTI-FLOOD NUMBER. After coalescing, at most this many notifications
   * are delivered individually per (family, audience); everything beyond it
   * becomes ONE digest.
   *
   * Three, not one and not ten. One would mean a parent whose child earned a
   * reward AND broke a streak overnight learns only about the reward until they
   * open the app. Ten is not a limit. Three is the number of items a person
   * reads off a lock screen before dismissing the rest, and the fourth item is
   * where a queue starts to feel like spam rather than news.
   */
  maxIndividualPerAudience: 3,
  /**
   * Below this, a digest is worse than the notifications it replaces: «you have
   * 2 updates» is strictly less useful than the two updates. So a digest is
   * only produced when it is replacing at least this many rows.
   */
  minDigestSize: 2,
  /**
   * Delivery attempts before a row becomes DEAD. Eight, matching
   * `OUTBOX_RELAY_DEFAULTS.maxAttempts` exactly — the two delivery paths in
   * this product should not disagree about how long «keep trying» lasts, and an
   * operator reading two dashboards should not have to remember two numbers.
   */
  maxAttempts: 8,
  /** Backoff base and cap, as seconds. Doubling, capped, no jitter — the same
   * shape as `nextRunAfterFailure`, for the same cross-replica reason. */
  retryBaseSeconds: 60,
  retryMaxSeconds: 3_600,
  /**
   * How many times one notification may be RE-deferred (released into a window
   * that turned out to still be quiet — a timezone change mid-flight, a policy
   * edit, a clock skew). Without a cap this is an infinite loop that looks like
   * a healthy queue; with it, the row goes SUPPRESSED/`MAX_DEFERRALS` and is
   * visible.
   */
  maxDeferrals: 3,
  /** The lease a claiming worker holds over a row, in seconds. Comfortably
   * longer than a release pass and shorter than the 300s cadence. */
  leaseSeconds: 120,
} as const;

/** The type the digest itself is written under. Classified DELIVER in
 * `notification-class.ts` so it can never defer itself. */
export const QUIET_HOURS_DIGEST_TYPE = 'QUIET_HOURS_DIGEST';
