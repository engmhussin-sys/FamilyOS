import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  notificationsApi,
  NOTIFICATIONS_QUERY_KEY,
  UNREAD_COUNT_QUERY_KEY,
} from '../api/notificationsApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
// A2: the shared error block. This card stays ABSENT when there is
// genuinely nothing to show — that discipline is deliberate and kept —
// but absence must not also be what a failed request looks like.
import { ErrorBlock } from '../../../shared/components/AsyncState';

export function NotificationCenterCard() {
  const queryClient = useQueryClient();
  const { t, locale } = useTranslation();
  const { data: notifications, isLoading, error, refetch } = useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: () => notificationsApi.list(),
  });

  if (error) {
    return (
      <Card>
        <h2 className="font-display text-lg text-ink">{t('notifications.title')}</h2>
        <div className="mt-3">
          <ErrorBlock error={error} onRetry={() => void refetch()} />
        </div>
      </Card>
    );
  }
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
          {t('notifications.title')}{' '}
          {unreadCount > 0 && `(${t('notifications.unreadCount', { count: unreadCount })})`}
        </h2>
        {unreadCount > 0 && (
          <Button variant="ghost" onClick={handleMarkAllAsRead}>
            {t('notifications.markAllRead')}
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
                  {new Date(notification.createdAt).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-US')}
                </p>
              </div>
              {notification.readAt === null && (
                <Button variant="ghost" onClick={() => handleMarkAsRead(notification.id)}>
                  {t('notifications.markRead')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
