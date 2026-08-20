import { useQuery } from '@tanstack/react-query';
import { lifeIntelligenceApi, coachingQueryKey, CoachingRecommendation } from '../api/lifeIntelligenceApi';
import { childrenApi, CHILDREN_QUERY_KEY } from '../../children/api/childrenApi';
import { Card } from '../../../shared/components/Card';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
// A2: shared four-state boundary — this panel had no error branch.
import { AsyncBoundary } from '../../../shared/components/AsyncState';

const TRACK_LABEL_KEY: Record<CoachingRecommendation['track'], string> = {
  PARENT: 'coaching.track.parent',
  CHILD: 'coaching.track.child',
  FAMILY: 'coaching.track.family',
};

function ChildCoachingPanel({ childId, childName }: { childId: string; childName: string }) {
  const { t } = useTranslation();
  const { data: recommendations, isLoading, error, refetch } = useQuery<CoachingRecommendation[]>({
    queryKey: coachingQueryKey(childId),
    queryFn: () => lifeIntelligenceApi.getCoachingRecommendations(childId),
  });

  return (
    <div className="rounded-card border border-sand-200 p-3">
      <p className="text-sm font-medium text-ink">{childName}</p>

      <AsyncBoundary
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        isEmpty={recommendations?.length === 0}
        emptyHint={t('coaching.empty')}
      >
        {recommendations && recommendations.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {recommendations.map((rec, i) => (
            <li key={i} className="rounded-card bg-sand-50 p-3">
              <span className="rounded-full bg-white px-2 py-0.5 text-xs text-ink-soft">{t(TRACK_LABEL_KEY[rec.track])}</span>
              <p className="mt-1 text-sm font-medium text-ink">{rec.title}</p>
              <p className="text-xs text-ink-soft">{rec.body}</p>
            </li>
          ))}
        </ul>
        )}
      </AsyncBoundary>
    </div>
  );
}

export function CoachingRecommendationsCard() {
  const { t } = useTranslation();
  const { data: children } = useQuery({ queryKey: CHILDREN_QUERY_KEY, queryFn: childrenApi.list });

  if (!children || children.length === 0) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('coaching.title')}</h2>
      <div className="mt-3 flex flex-col gap-3">
        {children.map((child) => (
          <ChildCoachingPanel key={child.id} childId={child.id} childName={child.firstName} />
        ))}
      </div>
    </Card>
  );
}
