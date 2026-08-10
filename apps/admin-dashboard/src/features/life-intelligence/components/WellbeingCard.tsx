import { useQuery } from '@tanstack/react-query';
import { lifeIntelligenceApi, wellbeingQueryKey, WellbeingSnapshot } from '../api/lifeIntelligenceApi';
import { childrenApi, CHILDREN_QUERY_KEY } from '../../children/api/childrenApi';
import { Card } from '../../../shared/components/Card';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

/** Edge-First Intelligence Architecture — mirrors the Parent App's own
 * WellbeingScreen exactly (averages over a window, never raw events;
 * the backend never receives raw events to begin with). Closes a real
 * gap: the mobile Parent App had this feature, the web Dashboard did not. */
function ChildWellbeingPanel({ childId, childName }: { childId: string; childName: string }) {
  const { t } = useTranslation();
  const { data: snapshot, isLoading } = useQuery<WellbeingSnapshot | null>({
    queryKey: wellbeingQueryKey(childId),
    queryFn: () => lifeIntelligenceApi.getWellbeingSnapshot(childId),
  });

  return (
    <div className="rounded-card border border-sand-200 p-3">
      <p className="text-sm font-medium text-ink">{childName}</p>

      {isLoading && <p className="mt-2 text-sm text-ink-soft">{t('common.loading')}</p>}
      {!isLoading && !snapshot && <p className="mt-2 text-sm text-ink-soft">{t('wellbeing.noData')}</p>}

      {snapshot && (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-ink-soft">
            <div>
              <dt>{t('wellbeing.avgScreenTime')}</dt>
              <dd className="font-medium text-ink">{snapshot.averageDailyScreenMinutes} {t('wellbeing.minutesPerDay')}</dd>
            </div>
            <div>
              <dt>{t('wellbeing.avgPickups')}</dt>
              <dd className="font-medium text-ink">{snapshot.averagePickups}</dd>
            </div>
            <div>
              <dt>{t('wellbeing.nightUsage')}</dt>
              <dd className="font-medium text-ink">{snapshot.averageNightUsageMinutes} {t('wellbeing.minutesPerDay')}</dd>
            </div>
            <div>
              <dt>{t('wellbeing.blockedAttempts')}</dt>
              <dd className="font-medium text-ink">{snapshot.totalBlockedAttempts}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-ink-soft">
            {t('wellbeing.windowNote', { days: snapshot.windowDays, daysWithData: snapshot.daysWithData })}
          </p>
        </>
      )}
    </div>
  );
}

export function WellbeingCard() {
  const { t } = useTranslation();
  const { data: children } = useQuery({ queryKey: CHILDREN_QUERY_KEY, queryFn: childrenApi.list });

  if (!children || children.length === 0) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('wellbeing.title')}</h2>
      <div className="mt-3 flex flex-col gap-3">
        {children.map((child) => (
          <ChildWellbeingPanel key={child.id} childId={child.id} childName={child.firstName} />
        ))}
      </div>
    </Card>
  );
}
