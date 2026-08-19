import { useMemo, useState } from 'react';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import type { CountryScope } from '../api/types';
import { useDaily } from '../api/useGrowthQueries';
import { activeChildrenGap, fetchProductAiMetrics, safetyEventsGap } from '../api/adapters';
import { formatCount } from '../lib/format';
import { rangeFor, type RangePreset } from '../lib/range';
import { businessDateLabel } from '../lib/range';
import { AsyncBoundary, ChartSkeleton, GapBlock, RefetchingOverlay } from '../../../shared/components/AsyncState';
import { NotificationsPanel } from '../components/NotificationsPanel';
import { FilterBar, GrowthPageHeader } from '../components/FilterBar';
import { ChartFrame, VizTable } from '../components/viz/ChartFrame';
import { TrendChart } from '../components/viz/TrendChart';
import { CATEGORICAL } from '../lib/vizTokens';
import { useVizMode } from '../lib/useVizMode';

/**
 * Product & AI.
 *
 * What it answers: "is the child-side product actually being used" — as
 * AGGREGATES ONLY.
 *
 * CONTEXT §3.8 governs this page more than any other: this is children's
 * data, and a commercial dashboard shows counts, never a child's activity.
 * There is deliberately no drill-down anywhere here — no child list, no
 * family list, no "click a bar to see who". The absence is the design, not
 * an unfinished feature, and the surest way to keep it is that nothing in
 * this file ever fetches a per-child row.
 *
 * The two real series available today are `activations` (a child completed
 * their first meaningful goal and was rewarded for it — a REWARD_GRANTED
 * fact, not a self-reported one) and `childrenAdded`. Everything else the
 * brief asks for is a declared gap.
 */
export function ProductAiPage() {
  const { t, locale, isRtl } = useTranslation();
  const mode = useVizMode();
  const [country, setCountry] = useState<CountryScope>('EG');
  const [range, setRange] = useState<RangePreset>('last30');
  const window = useMemo(() => rangeFor(range), [range]);

  const daily = useDaily(country, window);
  const rows = daily.data ?? [];
  const productMetrics = fetchProductAiMetrics();
  const safety = safetyEventsGap();
  const activeChildren = activeChildrenGap();

  const series = [
    {
      id: 'activations',
      // A COUNT of activations, not the activation RATE — the KPI label
      // would have put a percentage's name on a whole number.
      label: t('growth.product.activations'),
      color: CATEGORICAL[0][mode],
      points: rows.map((row) => ({ x: businessDateLabel(row.businessDate), y: row.activations })),
    },
    {
      id: 'childrenAdded',
      // `childrenAdded` is a FLOW — children added on that day. Labelling it
      // "active children" (as this series once was) would turn a daily
      // addition count into a stock the product does not measure.
      label: t('growth.product.childrenAdded'),
      color: CATEGORICAL[1][mode],
      points: rows.map((row) => ({ x: businessDateLabel(row.businessDate), y: row.childrenAdded })),
    },
  ];

  return (
    <div>
      <GrowthPageHeader title={t('growth.product.title')} subtitle={t('growth.product.subtitle')} />
      <FilterBar country={country} onCountryChange={setCountry} range={range} onRangeChange={setRange} />

      <p className="mb-5 rounded-card border border-guardian-700/30 bg-sage-100/60 px-4 py-3 text-xs text-guardian-900">
        {t('growth.product.aggregateOnly')}
      </p>

      <AsyncBoundary
        isLoading={daily.isLoading}
        error={daily.error}
        isEmpty={rows.length === 0}
        onRetry={() => void daily.refetch()}
        skeleton={<ChartSkeleton />}
      >
        <RefetchingOverlay isFetching={daily.isFetching}>
          <ChartFrame
            mode={mode}
            title={t('growth.product.title')}
            subtitle={t('growth.funnel.activationHint')}
            legend={series.map((s) => ({ label: s.label, color: s.color, fillStyle: 'solid' }))}
            table={
              <VizTable
                headers={[t('growth.filter.range'), ...series.map((s) => s.label)]}
              >
                {rows.map((row) => (
                  <tr key={row.businessDate} className="border-b border-sand-100">
                    <td className="px-3 py-2" dir="ltr">
                      {businessDateLabel(row.businessDate)}
                    </td>
                    <td className="px-3 py-2">{formatCount(locale, row.activations)}</td>
                    <td className="px-3 py-2">{formatCount(locale, row.childrenAdded)}</td>
                  </tr>
                ))}
              </VizTable>
            }
          >
            {() => (
              <TrendChart
                series={series}
                mode={mode}
                formatValue={(v) => formatCount(locale, v)}
                ariaLabel={t('growth.product.title')}
                isRtl={isRtl}
              />
            )}
          </ChartFrame>
        </RefetchingOverlay>
      </AsyncBoundary>

      {/* Notifications ARE measured, per market, and they are the one
          product-side series with a real endpoint today. They sit above the
          gaps so the page leads with what is true. */}
      <div className="mt-6">
        <NotificationsPanel country={country} range={window} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <GapBlock gap={productMetrics.gap} />
        <GapBlock gap={safety.gap} />
        <GapBlock gap={activeChildren.gap} />
      </div>
    </div>
  );
}
