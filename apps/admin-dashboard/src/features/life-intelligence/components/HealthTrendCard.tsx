import { useQuery } from '@tanstack/react-query';
import { lifeIntelligenceApi, healthScoreQueryKey, HealthScoreBreakdown } from '../api/lifeIntelligenceApi';
import { childrenApi, CHILDREN_QUERY_KEY } from '../../children/api/childrenApi';
import { Card } from '../../../shared/components/Card';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

function ChildHealthPanel({ childId, childName }: { childId: string; childName: string }) {
  const { t } = useTranslation();
  const { data: health, isLoading } = useQuery<HealthScoreBreakdown>({
    queryKey: healthScoreQueryKey(childId),
    queryFn: () => lifeIntelligenceApi.getHealthScore(childId),
  });

  return (
    <div className="rounded-card border border-sand-200 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-ink">{childName}</p>
        {health && <span className="text-lg font-semibold text-ink">{health.score}</span>}
      </div>

      {isLoading && <p className="mt-2 text-sm text-ink-soft">{t('common.loading')}</p>}

      {health && (
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-ink-soft">
          <div>
            <dt>{t('healthTrend.hydration')}</dt>
            <dd className="font-medium text-ink">{health.breakdown.hydration.actualMl} / {health.breakdown.hydration.targetMl} ml</dd>
          </div>
          <div>
            <dt>{t('healthTrend.activity')}</dt>
            <dd className="font-medium text-ink">{health.breakdown.activity.totalMinutes} {t('healthTrend.minutes')}</dd>
          </div>
          <div>
            <dt>{t('healthTrend.sleep')}</dt>
            <dd className="font-medium text-ink">
              {health.breakdown.sleepHours !== null ? `${health.breakdown.sleepHours.toFixed(1)} ${t('healthTrend.hours')}` : t('healthTrend.notLogged')}
            </dd>
          </div>
          <div>
            <dt>{t('healthTrend.meals')}</dt>
            <dd className="font-medium text-ink">{health.breakdown.nutritionLogsCount}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

export function HealthTrendCard() {
  const { t } = useTranslation();
  const { data: children } = useQuery({ queryKey: CHILDREN_QUERY_KEY, queryFn: childrenApi.list });

  if (!children || children.length === 0) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('healthTrend.title')}</h2>
      <div className="mt-3 flex flex-col gap-3">
        {children.map((child) => (
          <ChildHealthPanel key={child.id} childId={child.id} childName={child.firstName} />
        ))}
      </div>
    </Card>
  );
}
