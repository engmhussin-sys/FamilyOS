import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pendingApprovalsApi, PENDING_APPROVALS_QUERY_KEY } from '../api/pendingApprovalsApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

/**
 * CLOSES A CRITICAL REAL GAP: mirrors the Parent App's own
 * PendingApprovalsScreen (Flutter) fix exactly — this Admin
 * Dashboard is a separate app and had zero way for a parent to
 * discover AI-drafted messages awaiting approval before this. Same
 * backend endpoint, same "approve/reject" actions, same
 * "absent entirely when empty" discipline as NotificationCenterCard.
 */
export function PendingApprovalsCard() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { data: pending, isLoading } = useQuery({
    queryKey: PENDING_APPROVALS_QUERY_KEY,
    queryFn: () => pendingApprovalsApi.list(),
  });

  if (isLoading) return null;
  if (!pending || pending.length === 0) return null;

  async function handleApprove(childId: string, messageId: string) {
    await pendingApprovalsApi.approve(childId, messageId);
    await queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
  }

  async function handleReject(childId: string, messageId: string) {
    await pendingApprovalsApi.reject(childId, messageId);
    await queryClient.invalidateQueries({ queryKey: PENDING_APPROVALS_QUERY_KEY });
  }

  return (
    <Card className="border-amber-200 bg-amber-50">
      <h2 className="font-display text-lg text-ink">
        {t('pendingApprovals.title')} ({pending.length})
      </h2>
      <div className="mt-3 flex flex-col gap-2">
        {pending.map((message) => (
          <div key={message.id} className="rounded-card bg-white px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-ink-soft">{message.childName}</p>
                <p className="text-sm font-medium text-ink">{message.title}</p>
                <p className="text-xs text-ink-soft">{message.body}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" onClick={() => handleReject(message.childId, message.id)}>
                  {t('pendingApprovals.reject')}
                </Button>
                <Button onClick={() => handleApprove(message.childId, message.id)}>
                  {t('pendingApprovals.approve')}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
