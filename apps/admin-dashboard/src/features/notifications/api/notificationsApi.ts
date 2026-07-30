import { httpClient } from '../../../shared/lib/httpClient';

export interface NotificationRecord {
  id: string;
  childId: string | null;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export const NOTIFICATIONS_QUERY_KEY = ['notifications'] as const;
export const UNREAD_COUNT_QUERY_KEY = ['notifications-unread-count'] as const;

export const notificationsApi = {
  list(unreadOnly = false): Promise<NotificationRecord[]> {
    return httpClient<NotificationRecord[]>(`/notifications?unreadOnly=${unreadOnly}`);
  },

  unreadCount(): Promise<number> {
    return httpClient<number>('/notifications/unread-count');
  },

  markAsRead(id: string): Promise<boolean> {
    return httpClient<boolean>(`/notifications/${id}/read`, { method: 'PATCH' });
  },

  markAllAsRead(): Promise<number> {
    return httpClient<number>('/notifications/read-all', { method: 'POST' });
  },
};
