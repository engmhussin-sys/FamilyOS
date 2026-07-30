export const RUNTIME_ALERT_REPOSITORY = Symbol('RUNTIME_ALERT_REPOSITORY');

export interface ICreateRuntimeAlertInput {
  familyId: string;
  childId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
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
   * model (Phase 1 schema) — no new table for Runtime Alerts. */
  createForFamilyOwner(input: ICreateRuntimeAlertInput): Promise<void>;

  /** Sprint 6 — Alert Center's read side. Type-scoped to
   * 'RUNTIME_ALERT' only — a user's other notification types (if any
   * exist later) are a different concern. */
  listForUser(userId: string): Promise<IRuntimeAlertRecord[]>;
}
