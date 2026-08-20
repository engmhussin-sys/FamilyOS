export const RUNTIME_ALERT_REPOSITORY = Symbol('RUNTIME_ALERT_REPOSITORY');

export interface ICreateRuntimeAlertInput {
  familyId: string;
  childId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** CLOSES A REAL GAP (Master Completeness Audit): every caller
   * previously created notifications with zero priority distinction.
   * Defaults to 'NORMAL' at the call site, not here, so each real
   * alert type states its own priority explicitly.
   * Sprint 16.1 Phase 3: widened from CRITICAL|NORMAL to match
   * NotificationFatigueGuard's real 4-level scale — HIGH/LOW are
   * additive options, CRITICAL/NORMAL callers are unaffected. */
  priority?: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
  /** Sprint 16.1 Phase 3 (Smart Notification Integration) — CLOSES A
   * REAL GAP: every existing caller of this method got the same
   * hardcoded type ('RUNTIME_ALERT'), which is semantically wrong
   * for Smart Notifications (HYDRATION_REMINDER, STUDY_REMINDER,
   * etc.) — NotificationFatigueGuard's own per-type cooldown/category
   * logic depends on a real, distinct type. Optional, defaults to
   * 'RUNTIME_ALERT' — zero behavior change for any existing caller
   * that doesn't pass this. */
  type?: string;
  /**
   * B9 (PA-B-007 / PA-B-008) — REQUIRED, and «required» is the whole point.
   *
   * `notifications.source_event_id` is NOT NULL behind a unique index on
   * `(family_id, source_event_id, user_id)`. Making this field optional here
   * would have meant a default somewhere, and a default is exactly how a
   * producer silently opts out of a constraint. Compose it with one of the
   * three documented forms in
   * `src/shared/notifications/notification-source-key.ts`; the choice of form
   * IS the statement of what makes this notification the same notification.
   */
  sourceEventId: string;
  /**
   * PHASE D (`PD-N-002`) — WHO OWNS THE PUSH RETRY FOR THIS WRITE.
   *
   * Default `false`, i.e. EXACTLY today's behaviour: this repository writes the
   * `notifications` row and then fires the FCM push best-effort, swallowing any
   * transport failure. Every existing caller is unaffected and none of them
   * passes this field.
   *
   * `true` is passed by exactly one caller — `QuietHoursReleaseService` — and
   * it means «write the row, do NOT push; I have a durable row in
   * `notification_deliveries` with an attempt counter, a backoff and a terminal
   * DEAD state, and I will drive the push myself so a transient FCM failure is
   * retried instead of logged».
   *
   * It is a flag rather than a second method because the ROW-WRITING logic —
   * owner resolution, the five-minute window, the unique-index conflict, the
   * priority default — must not exist twice. Duplicating it so the push could
   * be omitted would be a second notification writer, which is the one thing
   * `PrismaRuntimeAlertRepository`'s docstring promises there is not.
   */
  deferPushToCaller?: boolean;
}

/**
 * PHASE D (`PD-N-002`) — the aggregate result of pushing one notification to
 * every device a recipient owns.
 *
 *   SENT       at least one device accepted it. Done.
 *   SKIPPED    Firebase is not configured in this environment — a documented
 *              no-op, and NOT a failure to retry (retrying it eight times in an
 *              environment with no credentials would manufacture DEAD rows out
 *              of a deployment choice).
 *   NONE       the recipient has no registered push token. Also not a failure:
 *              the in-app row exists and the app will show it on next open.
 *   RETRYABLE  every device failed transiently. THE CALLER SHOULD RETRY.
 *   PERMANENT  every device failed terminally (revoked tokens, wrong
 *              credentials). Retrying cannot help; the row stands as the record.
 *   NO_RECIPIENT the family has no members left to notify.
 *
 * The aggregation is deliberately OPTIMISTIC — one success makes the whole
 * fan-out a success — because the product question is «was the household
 * reached», not «did every device succeed».
 */
export type PushFanoutOutcome =
  | 'SENT'
  | 'SKIPPED'
  | 'NONE'
  | 'RETRYABLE'
  | 'PERMANENT'
  | 'NO_RECIPIENT';

export interface IRuntimeAlertRecord {
  id: string;
  childId: string | null;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface IRuntimeAlertRepository {
  /** Notifies the family's owner (Sprint 6 scope — all-members fanout is
   * a real follow-up, not built here). Reuses the existing Notification
   * model (Phase 1 schema) — no new table for Runtime Alerts.
   *
   * B9: returns whether a row was actually WRITTEN. `false` means the
   * notification already existed — either the five-minute window matched, or
   * the unique index refused the insert. Callers that report a decision
   * (`SmartNotificationIntegrationService`) need to tell "sent" from "already
   * sent"; callers that do not, ignore it. `void` would have made a
   * constraint-refused duplicate indistinguishable from a real send. */
  createForFamilyOwner(input: ICreateRuntimeAlertInput): Promise<boolean>;

  /**
   * PHASE D (`PD-N-002`) — PUSH ONLY, for a notification whose row already
   * exists.
   *
   * This is the retry half of the delivery-failure fix, and it exists as its
   * own method for a reason worth stating: a retry must be able to RE-PUSH
   * without RE-WRITING. `createForFamilyOwner` is idempotent by design — the
   * second call finds the row and returns `false` — so driving a push retry
   * through it would silently do nothing from the second attempt onwards, which
   * is a retry loop that cannot succeed. This method takes no `sourceEventId`
   * because it creates nothing that could collide.
   */
  pushToFamilyOwner(input: {
    familyId: string;
    title: string;
    body: string;
  }): Promise<PushFanoutOutcome>;

  /** Sprint 6 — Alert Center's read side. Type-scoped to
   * 'RUNTIME_ALERT' only — a user's other notification types (if any
   * exist later) are a different concern. */
  listForUser(userId: string): Promise<IRuntimeAlertRecord[]>;
}
