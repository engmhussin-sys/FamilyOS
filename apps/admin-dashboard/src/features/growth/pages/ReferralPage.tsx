import { useMemo, useState } from 'react';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import type { CountryScope } from '../api/types';
import { useDaily } from '../api/useGrowthQueries';
import { composeReferralSummary, GAPS } from '../api/adapters';
import { formatCount, NO_DATA } from '../lib/format';
import { rangeFor, type RangePreset } from '../lib/range';
import { AsyncBoundary, ComposedFromNote, GapBlock, RefetchingOverlay } from '../components/AsyncState';
import { FilterBar, GrowthPageHeader } from '../components/FilterBar';
import { TrendChart } from '../components/viz/TrendChart';
import { ChartFrame, VizTable } from '../components/viz/ChartFrame';
import { CATEGORICAL } from '../lib/vizTokens';
import { useVizMode } from '../lib/useVizMode';
import { businessDateLabel } from '../lib/range';

/**
 * Referral.
 *
 * What it answers: "is the referral loop producing paying families, and is
 * it being abused."
 *
 * Only one of those two is answerable today. `growth_daily_metrics` exposes
 * `referralsQualified` — a conversion that survived a verified payment AND
 * the refund window — and nothing else. Codes issued, invitations sent,
 * rewards granted and the fraud-rejection breakdown have no admin endpoint,
 * and this page says so rather than filling the cards with zeros.
 *
 * `/referral/me` is deliberately NOT read here. It is a parent surface
 * returning one family's own counters; using it as a platform figure would
 * be wrong arithmetic and a privacy regression in the same call.
 */
export function ReferralPage() {
  const { t, locale, isRtl } = useTranslation();
  const mode = useVizMode();
  const [country, setCountry] = useState<CountryScope>('EG');
  const [range, setRange] = useState<RangePreset>('last30');
  const window = useMemo(() => rangeFor(range), [range]);

  const daily = useDaily(country, window);
  const rows = daily.data ?? [];
  const summary = composeReferralSummary(rows);

  const series = [
    {
      id: 'referralsQualified',
      label: t('growth.referral.qualified'),
      color: CATEGORICAL[0][mode],
      points: rows.map((row) => ({ x: businessDateLabel(row.businessDate), y: row.referralsQualified })),
    },
  ];

  return (
    <div>
      <GrowthPageHeader title={t('growth.referral.title')} subtitle={t('growth.referral.subtitle')} />
      <FilterBar country={country} onCountryChange={setCountry} range={range} onRangeChange={setRange} />

      <p className="mb-5 rounded-card border border-sand-200 bg-sand-50 px-4 py-3 text-xs text-ink-soft">
        {t('growth.referral.privacyNote')}
      </p>

      <AsyncBoundary
        isLoading={daily.isLoading}
        error={daily.error}
        isEmpty={rows.length === 0}
        onRetry={() => void daily.refetch()}
      >
        <RefetchingOverlay isFetching={daily.isFetching}>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <SummaryTile label={t('growth.referral.qualified')} value={formatCount(locale, summary.data.qualified)} />
            {/* Structurally null: the type says so, so these can never
                accidentally show a number. */}
            <SummaryTile label={t('growth.referral.codesIssued')} value={NO_DATA} muted />
            <SummaryTile label={t('growth.referral.rewardsGranted')} value={NO_DATA} muted />
          </div>
          <ComposedFromNote endpoints={summary.composedFrom} />

          <div className="mt-6">
            <ChartFrame
              mode={mode}
              title={t('growth.referral.qualified')}
              subtitle={t('growth.referral.subtitle')}
              table={
                <VizTable headers={[t('growth.filter.range'), t('growth.referral.qualified')]}>
                  {rows.map((row) => (
                    <tr key={row.businessDate} className="border-b border-sand-100">
                      <td className="px-3 py-2" dir="ltr">
                        {businessDateLabel(row.businessDate)}
                      </td>
                      <td className="px-3 py-2">{formatCount(locale, row.referralsQualified)}</td>
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
                  ariaLabel={t('growth.referral.qualified')}
                  isRtl={isRtl}
                />
              )}
            </ChartFrame>
          </div>
        </RefetchingOverlay>
      </AsyncBoundary>

      <div className="mt-6">
        <GapBlock gap={GAPS.referralAdminSummary} />
      </div>
    </div>
  );
}

function SummaryTile({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div
      className={`rounded-card border p-4 ${
        muted ? 'border-dashed border-sand-200 bg-sand-50/50' : 'border-sand-200 bg-white shadow-quiet'
      }`}
    >
      <p className="text-xs text-ink-soft">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${muted ? 'text-ink-soft' : 'text-ink'}`}>{value}</p>
    </div>
  );
}
