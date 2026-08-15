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
}

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

  /** Sprint 6 — Alert Center's read side. Type-scoped to
   * 'RUNTIME_ALERT' only — a user's other notification types (if any
   * exist later) are a different concern. */
  listForUser(userId: string): Promise<IRuntimeAlertRecord[]>;
}
