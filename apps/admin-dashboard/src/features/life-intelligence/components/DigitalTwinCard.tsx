import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { lifeIntelligenceApi, digitalTwinQueryKey, ExplainableSubScore, DigitalTwin } from '../api/lifeIntelligenceApi';
import { childrenApi, CHILDREN_QUERY_KEY } from '../../children/api/childrenApi';
import { Card } from '../../../shared/components/Card';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';

type SubScoreKey = 'health' | 'learning' | 'faith' | 'habits' | 'social' | 'behavior' | 'safety';

const SUB_SCORE_ORDER: Array<{ key: SubScoreKey; labelKey: string }> = [
  { key: 'health', labelKey: 'digitalTwin.health' },
  { key: 'learning', labelKey: 'digitalTwin.learning' },
  { key: 'faith', labelKey: 'digitalTwin.faith' },
  { key: 'habits', labelKey: 'digitalTwin.habits' },
  { key: 'social', labelKey: 'digitalTwin.social' },
  { key: 'behavior', labelKey: 'digitalTwin.behavior' },
  { key: 'safety', labelKey: 'digitalTwin.safety' },
];

function SubScoreRow({ label, subScore }: { label: string; subScore: ExplainableSubScore | null }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-sand-200 py-2 last:border-0">
      <button
        type="button"
        onClick={() => subScore && setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-right"
        disabled={!subScore}
      >
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="flex items-center gap-2">
          {subScore ? (
            <>
              <span className="text-sm font-semibold text-ink">{subScore.score}</span>
              <span className="text-xs text-ink-soft">
                {t(`digitalTwin.confidence.${subScore.confidence.toLowerCase()}`)}
              </span>
            </>
          ) : (
            <span className="text-xs text-ink-soft">{t('digitalTwin.notYetAvailable')}</span>
          )}
        </span>
      </button>

      {expanded && subScore && (
        <ul className="mt-2 list-disc ps-4 text-xs text-ink-soft">
          {Object.entries(subScore.inputs).map(([key, value]) => (
            <li key={key}>
              {key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ChildDigitalTwinPanel({ childId, childName }: { childId: string; childName: string }) {
  const { t } = useTranslation();
  const { data: twin, isLoading } = useQuery<DigitalTwin>({
    queryKey: digitalTwinQueryKey(childId),
    queryFn: () => lifeIntelligenceApi.getDigitalTwin(childId),
  });

  return (
    <div className="rounded-card border border-sand-200 p-3">
      <p className="text-sm font-medium text-ink">{childName}</p>

      {isLoading && <p className="mt-2 text-sm text-ink-soft">{t('common.loading')}</p>}

      {twin && (
        <>
          <div className="my-3 rounded-card bg-sand-50 p-3 text-center">
            <p className="text-xs text-ink-soft">{t('digitalTwin.growthScore')}</p>
            {twin.growthScore ? (
              <>
                <p className="text-3xl font-semibold text-ink">{twin.growthScore.score}</p>
                <p className="text-xs text-ink-soft">
                  {t('digitalTwin.basedOnSubScores', {
                    count: twin.growthScore.inputs.contributingSubScores as number,
                    total: twin.growthScore.inputs.totalPossibleSubScores as number,
                  })}
                </p>
              </>
            ) : (
              <p className="text-sm text-ink-soft">{t('digitalTwin.notYetAvailable')}</p>
            )}
          </div>

          {SUB_SCORE_ORDER.map(({ key, labelKey }) => (
            <SubScoreRow key={key} label={t(labelKey)} subScore={twin[key]} />
          ))}
        </>
      )}
    </div>
  );
}

export function DigitalTwinCard() {
  const { t } = useTranslation();
  const { data: children } = useQuery({ queryKey: CHILDREN_QUERY_KEY, queryFn: childrenApi.list });

  if (!children || children.length === 0) return null;

  return (
    <Card>
      <h2 className="font-display text-lg text-ink">{t('digitalTwin.title')}</h2>
      {/* Explicit, permanent framing — never just a number. Architecture
          1.0 §6.2's own instruction: "not for ranking children." */}
      <p className="mb-3 mt-1 text-xs text-ink-soft">{t('digitalTwin.notARankingTool')}</p>

      <div className="flex flex-col gap-3">
        {children.map((child) => (
          <ChildDigitalTwinPanel key={child.id} childId={child.id} childName={child.firstName} />
        ))}
      </div>
    </Card>
  );
}
