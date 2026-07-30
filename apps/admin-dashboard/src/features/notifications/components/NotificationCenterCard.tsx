import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  notificationsApi,
  NOTIFICATIONS_QUERY_KEY,
  UNREAD_COUNT_QUERY_KEY,
} from '../api/notificationsApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';

export function NotificationCenterCard() {
  const queryClient = useQueryClient();
  const { data: notifications, isLoading } = useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: () => notificationsApi.list(),
  });

  if (isLoading) return null;
  if (!notifications || notifications.length === 0) return null;

  const unreadCount = notifications.filter((n) => n.readAt === null).length;

  async function handleMarkAsRead(id: string) {
    await notificationsApi.markAsRead(id);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_QUERY_KEY }),
    ]);
  }

  async function handleMarkAllAsRead() {
    await notificationsApi.markAllAsRead();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_QUERY_KEY }),
    ]);
  }

  return (
    <Card className={unreadCount > 0 ? 'border-brick-200 bg-brick-50' : ''}>
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg text-ink">
          الإشعارات {unreadCount > 0 && `(${unreadCount} غير مقروء)`}
        </h2>
        {unreadCount > 0 && (
          <Button variant="ghost" onClick={handleMarkAllAsRead}>
            تعليم الكل كمقروء
          </Button>
        )}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {notifications.slice(0, 10).map((notification) => (
          <div
            key={notification.id}
            className={`rounded-card px-3 py-2 ${
              notification.readAt === null ? 'bg-white' : 'bg-sand-50 opacity-70'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-ink">{notification.title}</p>
                <p className="text-xs text-ink-soft">{notification.body}</p>
                <p className="mt-1 text-xs text-ink-soft">
                  {new Date(notification.createdAt).toLocaleString('ar-EG')}
                </p>
              </div>
              {notification.readAt === null && (
                <Button variant="ghost" onClick={() => handleMarkAsRead(notification.id)}>
                  تعليم كمقروء
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
