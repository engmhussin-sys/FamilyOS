import { useQuery } from '@tanstack/react-query';
import { lifeIntelligenceApi, learningProgressQueryKey, LearningProgressSummary } from '../api/lifeIntelligenceApi';
import { childrenApi, CHILDREN_QUERY_KEY } from '../../children/api/childrenApi';
import { Card } from '../../../shared/components/Card';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
// A2: shared four-state boundary — this panel had no error branch, so a
// failed fetch was indistinguishable from "nothing recorded yet".
import { AsyncBoundary } from '../../../shared/components/AsyncState';

/**
 * CLOSES A REAL GAP: mirrors the Parent App's own LearningProgressScreen
 * fix — LearningEngineService (Goals/Sessions/Assessments/Progress/
 * Streak) had zero Admin Dashboard representation, independently
 * missing here since this is a separate app from the already-fixed
 * Flutter Parent App. Same per-child panel pattern as HealthTrendCard.
 */
function ChildLearningPanel({ childId, childName }: { childId: string; childName: string }) {
  const { t } = useTranslation();
  const { data: progress, isLoading, error, refetch } = useQuery<LearningProgressSummary>({
    queryKey: learningProgressQueryKey(childId),
    queryFn: () => lifeIntelligenceApi.getLearningProgress(childId),
  });

  return (
    <div className="rounded-card border border-sand-200 p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-ink">{childName}</p>
        {progress && progress.streakDays > 0 && (
          <span className="text-xs font-semibold text-sage-600">{t('learningProgress.streakDays', { count: progress.streakDays })}</span>
        )}
      </div>

      <AsyncBoundary
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        isEmpty={!isLoading && !error && !progress}
      >
        {progress && (
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-ink-soft">
          <div>
            <dt>{t('learningProgress.sessions')}</dt>
            <dd className="font-medium text-ink">{progress.totalSessions}</dd>
          </div>
          <div>
            <dt>{t('learningProgress.minutes')}</dt>
            <dd className="font-medium text-ink">{progress.totalMinutes}</dd>
          </div>
          <div className="col-span-2">
            <dt>{t('learningProgress.avgScore')}</dt>
            <dd className="font-medium text-ink">
              {progress.averageAssessmentScore !== null ? `${progress.averageAssessmentScore.toFixed(0)}%` : t('learningProgress.notYetAvailable')}
            </dd>
          </div>
        </dl>
        )}
      </AsyncBoundary>
    </div>
  );
}

export function LearningProgressCard() {
  const { t } = useTranslation();
  const { data: children } = useQuery({ queryKey: CHILDREN_QUERY_KEY, queryFn: childrenApi.list });

  if (!children || children.length === 0) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('learningProgress.title')}</h2>
      <div className="mt-3 flex flex-col gap-3">
        {children.map((child) => (
          <ChildLearningPanel key={child.id} childId={child.id} childName={child.firstName} />
        ))}
      </div>
    </Card>
  );
}
