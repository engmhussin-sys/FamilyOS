import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { lifeIntelligenceApi, timelineQueryKey, TimelineEvent } from '../api/lifeIntelligenceApi';
import { childrenApi, CHILDREN_QUERY_KEY } from '../../children/api/childrenApi';
import { Card } from '../../../shared/components/Card';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
// A2: shared four-state boundary — this panel had no error branch, so a
// failed fetch was indistinguishable from "nothing recorded yet".
import { AsyncBoundary } from '../../../shared/components/AsyncState';

const CATEGORIES: TimelineEvent['category'][] = ['HEALTH', 'LEARNING', 'FAITH', 'REWARDS', 'SAFETY', 'HABITS', 'FAMILY'];

const CATEGORY_DOT_COLOR: Record<TimelineEvent['category'], string> = {
  HEALTH: 'bg-emerald-500',
  LEARNING: 'bg-sky-500',
  FAITH: 'bg-teal-600',
  REWARDS: 'bg-amber-500',
  SAFETY: 'bg-brick-500',
  HABITS: 'bg-violet-500',
  FAMILY: 'bg-sage-500',
};

function ChildTimelinePanel({ childId, childName }: { childId: string; childName: string }) {
  const { t, locale } = useTranslation();
  const [category, setCategory] = useState<TimelineEvent['category'] | undefined>(undefined);

  const { data: events, isLoading, error, refetch } = useQuery<TimelineEvent[]>({
    queryKey: timelineQueryKey(childId, category),
    queryFn: () => lifeIntelligenceApi.getTimeline(childId, category),
  });

  return (
    <div className="rounded-card border border-sand-200 p-3">
      <p className="text-sm font-medium text-ink">{childName}</p>

      <div className="mt-2 flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => setCategory(undefined)}
          className={`rounded-full px-2 py-0.5 text-xs ${!category ? 'bg-ink text-white' : 'bg-sand-100 text-ink-soft'}`}
        >
          {t('lifeTimeline.all')}
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={`rounded-full px-2 py-0.5 text-xs ${category === c ? 'bg-ink text-white' : 'bg-sand-100 text-ink-soft'}`}
          >
            {t(`lifeTimeline.category.${c.toLowerCase()}`)}
          </button>
        ))}
      </div>

      <AsyncBoundary
        isLoading={isLoading}
        error={error}
        onRetry={() => void refetch()}
        isEmpty={events?.length === 0}
        emptyHint={t('lifeTimeline.empty')}
      >
        {events && events.length > 0 && (
        <ol className="mt-3 flex flex-col gap-3 border-s-2 border-sand-200 ps-4">
          {events.map((event) => (
            <li key={event.id} className="relative">
              <span
                className={`absolute -right-[21px] top-1 h-2.5 w-2.5 rounded-full ${CATEGORY_DOT_COLOR[event.category]}`}
                aria-hidden
              />
              <p className="text-sm font-medium text-ink">{event.title}</p>
              <p className="text-xs text-ink-soft">{new Date(event.occurredAt).toLocaleDateString(locale)}</p>
            </li>
          ))}
        </ol>
        )}
      </AsyncBoundary>
    </div>
  );
}

export function LifeTimelineCard() {
  const { t } = useTranslation();
  const { data: children } = useQuery({ queryKey: CHILDREN_QUERY_KEY, queryFn: childrenApi.list });

  if (!children || children.length === 0) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('lifeTimeline.title')}</h2>
      <div className="mt-3 flex flex-col gap-3">
        {children.map((child) => (
          <ChildTimelinePanel key={child.id} childId={child.id} childName={child.firstName} />
        ))}
      </div>
    </Card>
  );
}
