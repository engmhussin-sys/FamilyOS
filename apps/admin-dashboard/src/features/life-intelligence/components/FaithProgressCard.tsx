import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lifeIntelligenceApi, faithPracticesQueryKey, FaithPractice } from '../api/lifeIntelligenceApi';
import { childrenApi, CHILDREN_QUERY_KEY } from '../../children/api/childrenApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

function ChildFaithPanel({ childId, childName }: { childId: string; childName: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: practices, isLoading } = useQuery<FaithPractice[]>({
    queryKey: faithPracticesQueryKey(childId),
    queryFn: () => lifeIntelligenceApi.getFaithPractices(childId),
  });

  const handleLog = async (practiceId: string) => {
    try {
      await lifeIntelligenceApi.logFaithPractice(childId, practiceId);
      await queryClient.invalidateQueries({ queryKey: faithPracticesQueryKey(childId) });
    } catch {
      // Best-effort single action — same pattern as HabitTrackerCard.
    }
  };

  return (
    <div className="rounded-card border border-sand-200 p-3">
      <p className="text-sm font-medium text-ink">{childName}</p>

      {isLoading && <p className="mt-2 text-sm text-ink-soft">{t('common.loading')}</p>}
      {practices && practices.length === 0 && <p className="mt-2 text-sm text-ink-soft">{t('faithProgress.empty')}</p>}

      {practices && practices.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {practices.map((practice) => (
            <li key={practice.id} className="flex items-center justify-between rounded-card bg-sand-50 px-3 py-2">
              <p className="text-sm text-ink">{practice.title}</p>
              <Button variant="ghost" onClick={() => handleLog(practice.id)}>
                {t('faithProgress.logToday')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FaithProgressCard() {
  const { t } = useTranslation();
  const { data: children } = useQuery({ queryKey: CHILDREN_QUERY_KEY, queryFn: childrenApi.list });

  if (!children || children.length === 0) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('faithProgress.title')}</h2>
      <div className="mt-3 flex flex-col gap-3">
        {children.map((child) => (
          <ChildFaithPanel key={child.id} childId={child.id} childName={child.firstName} />
        ))}
      </div>
    </Card>
  );
}
