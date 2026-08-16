import { useMemo, useState } from 'react';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { PLATFORM_SCOPE, type CountryScope } from '../api/types';
import { useCatalogue, useFunnel, useKpis } from '../api/useGrowthQueries';
import { pickKpi } from '../api/adapters';
import { rangeFor, type RangePreset } from '../lib/range';
import { formatCount, formatHours, formatRate, NO_DATA } from '../lib/format';
import { FUNNEL_SOURCE, CATEGORICAL, STATUS } from '../lib/vizTokens';
import { useVizMode } from '../lib/useVizMode';
import { FunnelChart } from '../components/viz/FunnelChart';
import { ChartFrame, VizTable, type LegendEntry } from '../components/viz/ChartFrame';
import { AsyncBoundary, RefetchingOverlay } from '../components/AsyncState';
import { FilterBar, GrowthPageHeader } from '../components/FilterBar';
import { KpiCard } from '../components/KpiCard';

/**
 * The funnel view.
 *
 * What it answers: "where do families stop, and how badly." Step conversion
 * and the absolute drop-off are printed on the same row as the bar, because
 * a percentage without a count hides whether a 40% drop is forty families
 * or forty thousand.
 *
 * The activation step is highlighted rather than merely listed — it is the
 * only step that predicts the rest, and the product's whole thesis rests on
 * a CHILD (not a parent) having completed something real and been rewarded
 * for it. Time-to-value sits beside it as its companion measure.
 *
 * `monotonicityViolations` are surfaced, never suppressed: a later step
 * outnumbering an earlier one is a diagnosable state, usually a missing ad
 * platform import, and zeroing the difference makes bad data look clean.
 */
export function FunnelPage() {
  const { t, locale, isRtl } = useTranslation();
  const mode = useVizMode();
  const [country, setCountry] = useState<CountryScope>('EG');
  const [range, setRange] = useState<RangePreset>('last30');
  const window = useMemo(() => rangeFor(range), [range]);

  const funnel = useFunnel(country, window);
  const kpis = useKpis(country);
  const catalogue = useCatalogue();

  const activationEventStep = 'FIRST_GOAL' as const;
  const steps = funnel.data?.steps ?? [];

  const legend: LegendEntry[] = (['DOMAIN_TABLE', 'ANALYTICS_EVENT', 'EXTERNAL_REPORTED'] as const).map((source) => ({
    label: t(FUNNEL_SOURCE[source].labelKey),
    color: CATEGORICAL[0][mode],
    fillStyle: FUNNEL_SOURCE[source].fillStyle,
    glyph: FUNNEL_SOURCE[source].glyph,
    hint: t(`growth.source.${source === 'DOMAIN_TABLE' ? 'domainTable' : source === 'ANALYTICS_EVENT' ? 'analyticsEvent' : 'externalReported'}Hint`),
  }));

  return (
    <div>
      <GrowthPageHeader title={t('growth.funnel.title')} subtitle={t('growth.funnel.subtitle')} />
      <FilterBar country={country} onCountryChange={setCountry} range={range} onRangeChange={setRange} />

      {/* Activation gets its own band, above the funnel — the metric the
          product lives or dies on does not get to be step seven of eleven. */}
      <section className="mb-6 rounded-card border-2 p-5" style={{ borderColor: STATUS.good[mode] }}>
        <h3 className="font-display text-base text-ink">{t('growth.funnel.activationTitle')}</h3>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('growth.funnel.activationHint')}</p>
        <p className="mt-1 font-mono text-xs text-ink-soft" dir="ltr">
          {catalogue.data?.activation.eventName ?? t('growth.funnel.activationEvent')}
          {catalogue.data?.activation.ruleVersion ? ` · ${catalogue.data.activation.ruleVersion}` : ''}
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <KpiCard kpi={pickKpi(kpis.data, 'ACTIVATION_RATE')} countryScope={country} hero />
          <KpiCard kpi={pickKpi(kpis.data, 'TIME_TO_VALUE_HOURS')} countryScope={country} />
          <div className="rounded-card border border-sand-200 bg-white p-4">
            <h4 className="text-xs font-medium text-ink-soft">{t('growth.funnel.timeToValue')}</h4>
            <p className="mt-1 text-xs text-ink-soft">{t('growth.funnel.timeToValueHint')}</p>
            <p className="mt-2 text-sm font-medium text-ink">
              {formatHours(locale, pickKpi(kpis.data, 'TIME_TO_VALUE_HOURS')?.value ?? null)}
            </p>
          </div>
        </div>
      </section>

      <AsyncBoundary
        isLoading={funnel.isLoading}
        error={funnel.error}
        isEmpty={steps.length === 0}
        onRetry={() => void funnel.refetch()}
      >
        <RefetchingOverlay isFetching={funnel.isFetching}>
          <ChartFrame
            mode={mode}
            title={t('growth.funnel.title')}
            subtitle={t('growth.funnel.subtitle')}
            legend={legend}
            footnote={
              country === PLATFORM_SCOPE ? t('growth.overview.noCombinedMoneyHint') : t('growth.funnel.fromMeasurableTop')
            }
            table={
              <VizTable
                headers={[
                  t('growth.funnel.step.INSTALL'),
                  t('growth.state.noData'),
                  t('growth.funnel.stepConversion'),
                  t('growth.funnel.fromMeasurableTop'),
                  t('growth.source.legend'),
                ]}
              >
                {steps.map((step) => (
                  <tr key={step.step} className="border-b border-sand-100">
                    <td className="px-3 py-2">{t(`growth.funnel.step.${step.step}`)}</td>
                    <td className="px-3 py-2">{formatCount(locale, step.count)}</td>
                    <td className="px-3 py-2">{formatRate(locale, step.stepConversion)}</td>
                    <td className="px-3 py-2">{formatRate(locale, step.fromMeasurableTop)}</td>
                    <td className="px-3 py-2 text-xs text-ink-soft">{t(FUNNEL_SOURCE[step.source].labelKey)}</td>
                  </tr>
                ))}
              </VizTable>
            }
          >
            {(patterns) => (
              <FunnelChart
                steps={steps}
                mode={mode}
                patterns={patterns}
                activationStep={activationEventStep}
                isRtl={isRtl}
              />
            )}
          </ChartFrame>
        </RefetchingOverlay>
      </AsyncBoundary>

      {funnel.data && funnel.data.monotonicityViolations.length > 0 && (
        <section className="mt-6 rounded-card border border-amber-500/60 bg-amber-100/40 p-5">
          <h3 className="text-sm font-medium text-amber-600">{t('growth.funnel.monotonicityViolations')}</h3>
          <p className="mt-1 text-xs text-ink-soft">{t('growth.funnel.monotonicityHint')}</p>
          <ul className="mt-3 flex flex-col gap-1 text-xs text-ink-soft">
            {funnel.data.monotonicityViolations.map((violation) => (
              <li key={violation} className="font-mono" dir="ltr">
                {violation}
              </li>
            ))}
          </ul>
        </section>
      )}

      {funnel.data && (
        <p className="mt-4 text-xs text-ink-soft" dir="ltr">
          {funnel.data.reportingTimeZone} · {funnel.data.from.slice(0, 10)} → {funnel.data.to.slice(0, 10)}
          {funnel.data.steps.length === 0 ? ` · ${NO_DATA}` : ''}
        </p>
      )}
    </div>
  );
}
