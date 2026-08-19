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
   * scorer falls back to the type comparison it used before this field. */
  findRecentForChild(
    childId: string,
    since: Date,
  ): Promise<Array<{ type: string; priority: string; createdAt: Date; sourceEventId?: string | null }>>;
}
