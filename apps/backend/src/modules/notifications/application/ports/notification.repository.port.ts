export interface INotificationRecord {
  id: string;
  childId: string | null;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: Date | null;
  createdAt: Date;
}

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

export interface INotificationRepository {
  listForUser(userId: string, unreadOnly: boolean): Promise<INotificationRecord[]>;
  markAsRead(notificationId: string, userId: string): Promise<boolean>;
  markAllAsRead(userId: string): Promise<number>;
  countUnread(userId: string): Promise<number>;
  /** Sprint 16.1 Phase 3 (Smart Notification Integration) — CLOSES A
   * REAL GAP: feeds NotificationFatigueGuard's real recent-history
   * input, which nothing previously supplied from real data.
   *
   * `sourceEventId` is the CAUSAL KEY the row was written under, and
   * `NotificationContextAssembler` needs it so DUPLICATE_PENALTY can ask «is
   * this the same CAUSE?» rather than «is this the same TYPE?» — two questions
   * that give different answers whenever one type carries more than one cause,
   * which `DAILY_GOAL_COMPLETED` (hydration / activity) and
   * `REWARD_GRANTED_CHILD` (three causes) both do.
   *
   * OPTIONAL on the returned row, so no existing test double has to invent a
   * key to keep compiling: an absent one reads as «identity unknown» and the
   * scorer falls back to the type comparison it used before this field.
   *
   * `until` — HISTORY IS WHAT ALREADY HAPPENED, AND THE WINDOW HAS A CEILING.
   *
   * This read was bounded BELOW only, so a `notifications` row stamped AFTER
   * the instant being evaluated counted as history — and every rule downstream
   * measures AGE, so `now - createdAt` came out NEGATIVE and the row read as
   * «two seconds ago» in the daily count, the hourly count and the duplicate
   * window alike. That is not hypothetical: it happens whenever the caller's
   * instant is not the wall clock — a replayed decision, a back-dated import, a
   * deferral released at its scheduled instant, a replica running behind the
   * database that wrote the row. `evaluateFatigue` and
   * `SmartNotificationIntegrationService.fetchHistory` already state and apply
   * exactly this bound; this is the same rule, pushed into the query so the
   * rows never leave PostgreSQL.
   *
   * OPTIONAL, and its ABSENCE MEANS «no ceiling» rather than «now»: defaulting
   * to `new Date()` would put a clock inside a repository whose whole contract
   * is that the CALLER names the instant, and it would be silently wrong for
   * every replayed decision. `NotificationContextAssembler` passes it AND
   * re-applies the bound in memory, because a port with more than one
   * implementation must not assume its contract was honoured. */
  findRecentForChild(
    childId: string,
    since: Date,
    until?: Date,
  ): Promise<Array<{ type: string; priority: string; createdAt: Date; sourceEventId?: string | null }>>;
}
