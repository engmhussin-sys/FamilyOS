import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { COUNTRY_CODES, type KpiId } from '../api/types';
import { useKpis } from '../api/useGrowthQueries';
import { fetchCohortRetention, pickKpi } from '../api/adapters';
import { formatRate } from '../lib/format';
import { useVizMode } from '../lib/useVizMode';
import { RetentionGrid, type RetentionRow } from '../components/viz/RetentionGrid';
import { ChartFrame, VizTable } from '../components/viz/ChartFrame';
import { AsyncBoundary, GapBlock } from '../components/AsyncState';
import { GrowthPageHeader } from '../components/FilterBar';

/**
 * Retention.
 *
 * What it answers: "does a family that arrives on day 0 still exist on day
 * 1, 7, 30, 90 — and does the answer differ between the two markets."
 *
 * The horizons are ordinal (D1 < D7 < D30 < D90), so the colour job is
 * sequential: one teal hue, light→dark, from the validated ordinal ramp.
 * The value is written inside every cell, so nothing is encoded by colour
 * alone.
 *
 * The behaviour that matters most: a `null` cell is drawn with NO fill and
 * an em dash. `RETENTION_D90` on a 45-day-old cohort is `null` by contract,
 * and a dashboard that paints it at the pale end of the ramp has invented a
 * catastrophic retention number out of a cohort that is simply too young.
 */

const HORIZONS: readonly KpiId[] = ['RETENTION_D1', 'RETENTION_D7', 'RETENTION_D30', 'RETENTION_D90'];

export function RetentionPage() {
  const { t, locale } = useTranslation();
  const mode = useVizMode();
  const cohorts = fetchCohortRetention();

  const eg = useKpis('EG');
  const sa = useKpis('SA');
  const snapshots = { EG: eg, SA: sa };

  const rows: RetentionRow[] = COUNTRY_CODES.map((country) => ({
    label: t(`growth.country.${country}`),
    sublabel: snapshots[country].data?.businessDate,
    cells: HORIZONS.map((kpi) => ({
      label: t(`growth.kpi.${kpi}`),
      value: pickKpi(snapshots[country].data, kpi)?.value ?? null,
    })),
  }));

  const isLoading = eg.isLoading || sa.isLoading;
  const error = eg.error ?? sa.error;

  return (
    <div>
      <GrowthPageHeader title={t('growth.retention.title')} subtitle={t('growth.retention.subtitle')} />

      <AsyncBoundary
        isLoading={isLoading}
        error={error}
        onRetry={() => {
          void eg.refetch();
          void sa.refetch();
        }}
      >
        <ChartFrame
          mode={mode}
          title={t('growth.retention.byCountry')}
          subtitle={t('growth.retention.shortCohortNote')}
          table={
            <VizTable headers={[t('growth.filter.country'), ...HORIZONS.map((kpi) => t(`growth.kpi.${kpi}`))]}>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-sand-100">
                  <td className="px-3 py-2">{row.label}</td>
                  {row.cells.map((cell) => (
                    <td key={cell.label} className="px-3 py-2">
                      {formatRate(locale, cell.value)}
                    </td>
                  ))}
                </tr>
              ))}
            </VizTable>
          }
        >
          {() => (
            <RetentionGrid
              rows={rows}
              columnLabels={HORIZONS.map((kpi) => t(`growth.kpi.${kpi}`))}
              mode={mode}
              formatValue={(value) => formatRate(locale, value)}
              ariaLabel={t('growth.retention.byCountry')}
            />
          )}
        </ChartFrame>
      </AsyncBoundary>

      <section className="mt-6">
        <h3 className="mb-3 font-display text-base text-ink">{t('growth.retention.byCohort')}</h3>
        <GapBlock gap={cohorts.gap} />
      </section>
    </div>
  );
}
