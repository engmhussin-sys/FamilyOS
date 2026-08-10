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
   * input, which nothing previously supplied from real data. */
  findRecentForChild(childId: string, since: Date): Promise<Array<{ type: string; priority: string; createdAt: Date }>>;
}
