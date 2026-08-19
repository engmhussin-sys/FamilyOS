import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lifeIntelligenceApi, habitsQueryKey, missedHabitsQueryKey, Habit, MissedHabit } from '../api/lifeIntelligenceApi';
import { childrenApi, CHILDREN_QUERY_KEY } from '../../children/api/childrenApi';
import { Card } from '../../../shared/components/Card';
import { Button } from '../../../shared/components/Button';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
// A2: shared four-state boundary. This panel had no error branch, so a
// failed habits fetch rendered «لا توجد عادات بعد» — a wrong statement.
import { AsyncBoundary } from '../../../shared/components/AsyncState';

function ChildHabitPanel({ childId, childName }: { childId: string; childName: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: habits, isLoading, error, refetch } = useQuery<Habit[]>({
    queryKey: habitsQueryKey(childId),
    queryFn: () => lifeIntelligenceApi.getHabits(childId),
  });

  // CLOSES A REAL GAP: this endpoint (built Sprint 16) had zero
  // frontend consumer anywhere until now. Used strictly as a
  // Coaching SIGNAL, never a punishment display.
  const { data: missed } = useQuery<MissedHabit[]>({
    queryKey: missedHabitsQueryKey(childId),
    queryFn: () => lifeIntelligenceApi.getMissedHabits(childId, 7),
  });

  const handleComplete = async (habitId: string) => {
    try {
      await lifeIntelligenceApi.completeHabit(childId, habitId);
      await queryClient.invalidateQueries({ queryKey: habitsQueryKey(childId) });
    } catch {
      // The habit list simply won't reflect the completion — the
      // parent can retry the tap; no separate error UI for a single
      // best-effort action, matching this dashboard's existing
      // low-ceremony pattern for similar quick actions elsewhere.
    }
  };

  return (
    <div className="rounded-card border border-sand-200 p-3">
      <p className="text-sm font-medium text-ink">{childName}</p>

      <AsyncBoundary
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        isEmpty={habits?.length === 0}
        emptyHint={t('habitTracker.empty')}
      >
        {habits && habits.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {habits.map((habit) => (
            <li key={habit.id} className="flex items-center justify-between rounded-card bg-sand-50 px-3 py-2">
              <div>
                <p className="text-sm text-ink">{habit.title}</p>
                <p className="text-xs text-ink-soft">{habit.category}{habit.isShared ? ` \u00b7 ${t('habitTracker.shared')}` : ''}</p>
              </div>
              <Button variant="ghost" onClick={() => handleComplete(habit.id)}>
                {t('habitTracker.markDone')}
              </Button>
            </li>
          ))}
        </ul>
        )}
      </AsyncBoundary>

      {missed && missed.length > 0 && (
        <div className="mt-3 rounded-card bg-amber-50 px-3 py-2">
          <p className="text-xs font-semibold text-ink-soft">{t('habitTracker.missedSignal', { count: missed.length })}</p>
        </div>
      )}
    </div>
  );
}

export function HabitTrackerCard() {
  const { t } = useTranslation();
  const { data: children } = useQuery({ queryKey: CHILDREN_QUERY_KEY, queryFn: childrenApi.list });

  if (!children || children.length === 0) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('habitTracker.title')}</h2>
      <div className="mt-3 flex flex-col gap-3">
        {children.map((child) => (
          <ChildHabitPanel key={child.id} childId={child.id} childName={child.firstName} />
        ))}
      </div>
    </Card>
  );
}
