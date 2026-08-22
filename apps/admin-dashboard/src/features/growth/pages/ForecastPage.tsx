import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import {
  COUNTRY_CODES,
  TARGET_METRICS,
  type CountryCode,
  type ForecastAssumptions,
  type ForecastScenarioName,
  type QuarterlyRow,
  type TargetMetric,
} from '../api/types';
import { useForecast, useQuarterly } from '../api/useGrowthQueries';
import { saveForecastScenario } from '../api/growthApi';
import { COUNTRY_CURRENCY, formatCount, formatMoneyMinor, formatRate, NO_DATA } from '../lib/format';
import { useVizMode } from '../lib/useVizMode';
import { PROVENANCE, CHROME } from '../lib/vizTokens';
import { QuarterlyChart } from '../components/viz/QuarterlyChart';
import { ChartFrame, VizTable, type LegendEntry } from '../components/viz/ChartFrame';
import { ScenarioSwitcher } from '../components/ScenarioSwitcher';
import { AssumptionsEditor } from '../components/AssumptionsEditor';
import { ProvenanceBadge } from '../components/ProvenanceBadge';
import { AsyncBoundary, ChartSkeleton, FigureGridSkeleton, RefetchingOverlay } from '../../../shared/components/AsyncState';
import { GrowthPageHeader } from '../components/FilterBar';

/**
 * Quarterly forecasting.
 *
 * What it answers: "what did we commit to, what did we actually do, and
 * what does the model say happens next" — as three answers, never one.
 *
 * The 28 rows the backend returns (4 quarters × 7 metrics) each carry
 * target AND actual AND forecast, and the contract is explicit that there
 * is no `value` field and never will be. This page therefore never picks
 * one silently: the chart draws all three with different geometry, and the
 * table prints all three in labelled columns with their provenance badges.
 */

/** A metric's units decide its formatter — the metric name alone would
 * have `REVENUE_MINOR` and `USERS` sharing a format. */
function metricFormatter(
  metric: TargetMetric,
  country: CountryCode,
  locale: 'ar' | 'en',
): (value: number | null) => string {
  const currency = COUNTRY_CURRENCY[country];
  switch (metric) {
    case 'REVENUE_MINOR':
    case 'CAC_MINOR':
    case 'MRR_MINOR':
      // Money always with its market — `country` is passed, so a figure
      // here cannot be rendered outside the context it belongs to.
      return (value) => formatMoneyMinor(locale, value, currency, country, { compact: true });
    case 'CHURN_RATE':
      return (value) => formatRate(locale, value);
    default:
      return (value) => formatCount(locale, value);
  }
}

export function ForecastPage() {
  const { t, locale, isRtl } = useTranslation();
  const mode = useVizMode();
  const queryClient = useQueryClient();

  const [country, setCountry] = useState<CountryCode>('EG');
  const [scenario, setScenario] = useState<ForecastScenarioName>('BASE');
  const [metric, setMetric] = useState<TargetMetric>('PAID_USERS');
  const year = new Date().getUTCFullYear();

  const forecast = useForecast(country);
  const quarterly = useQuarterly(country, year);

  const available = useMemo(
    () => (forecast.data ?? []).map((row) => row.scenario),
    [forecast.data],
  );
  const selected = (forecast.data ?? []).find((row) => row.scenario === scenario);

  const saveScenario = useMutation({
    mutationFn: (assumptions: ForecastAssumptions) =>
      saveForecastScenario({
        scenario,
        countryCode: country,
        currencyCode: COUNTRY_CURRENCY[country],
        assumptions,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['growth', 'forecast', country] }),
  });

  const rows = (quarterly.data ?? [])
    .filter((row) => row.metric === metric)
    .sort((a, b) => a.quarter - b.quarter);

  const format = metricFormatter(metric, country, locale);

  const legend: LegendEntry[] = [
    {
      label: t('growth.provenance.actual'),
      color: PROVENANCE.ACTUAL.color?.[mode] ?? null,
      fillStyle: 'solid',
      glyph: PROVENANCE.ACTUAL.glyph,
      hint: t('growth.provenance.actualHint'),
    },
    {
      label: t('growth.provenance.target'),
      color: CHROME.inkSecondary[mode],
      fillStyle: 'outline-solid',
      glyph: PROVENANCE.TARGET.glyph,
      hint: t('growth.provenance.targetHint'),
    },
    {
      label: t('growth.provenance.forecast'),
      color: PROVENANCE.FORECAST.color?.[mode] ?? null,
      fillStyle: 'hatched',
      glyph: PROVENANCE.FORECAST.glyph,
      hint: t('growth.provenance.forecastHint'),
    },
  ];

  return (
    <div>
      <GrowthPageHeader title={t('growth.forecast.title')} subtitle={t('growth.forecast.subtitle')} />

      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-card border border-sand-200 bg-white px-4 py-3 shadow-quiet">
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">{t('growth.filter.country')}</legend>
          <span className="text-xs font-medium text-ink-soft">{t('growth.filter.country')}</span>
          {COUNTRY_CODES.map((code) => (
            <button
              key={code}
              type="button"
              aria-pressed={country === code}
              onClick={() => setCountry(code)}
              className={`rounded-card px-3 py-1.5 text-xs font-medium ${
                country === code ? 'bg-guardian-900 text-sand-50' : 'bg-sand-100 text-ink-soft hover:bg-sand-200'
              }`}
            >
              {t(`growth.country.${code}`)} · {COUNTRY_CURRENCY[code]}
            </button>
          ))}
        </fieldset>

        <ScenarioSwitcher scenario={scenario} onChange={setScenario} available={available} />
      </div>

      <AsyncBoundary
        isLoading={forecast.isLoading}
        error={forecast.error}
        onRetry={() => void forecast.refetch()}
        skeleton={<FigureGridSkeleton count={3} columns={3} />}
      >
        {selected ? (
          <RefetchingOverlay isFetching={forecast.isFetching}>
            <AssumptionsEditor
              assumptions={selected.assumptions}
              isSaving={saveScenario.isPending}
              onSave={(assumptions) => saveScenario.mutate(assumptions)}
            />
            <ScenarioSummary
              endingPaid={selected.endingPaid}
              endingMrrMinor={selected.endingMrrMinor}
              totalSpendMinor={selected.totalSpendMinor}
              country={country}
            />
          </RefetchingOverlay>
        ) : (
          <p className="rounded-card border border-dashed border-sand-200 bg-sand-50/60 p-6 text-sm text-ink-soft">
            {t('growth.state.empty')} — {t(`growth.forecast.${scenario}`)}
          </p>
        )}
      </AsyncBoundary>

      <div className="my-6 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink-soft">{t('growth.forecast.quarter')}</span>
        {TARGET_METRICS.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={metric === name}
            onClick={() => setMetric(name)}
            className={`rounded-card px-3 py-1.5 text-xs font-medium ${
              metric === name ? 'bg-guardian-900 text-sand-50' : 'bg-sand-100 text-ink-soft hover:bg-sand-200'
            }`}
          >
            {t(`growth.forecast.metric.${name}`)}
          </button>
        ))}
      </div>

      <AsyncBoundary
        isLoading={quarterly.isLoading}
        error={quarterly.error}
        isEmpty={rows.length === 0}
        onRetry={() => void quarterly.refetch()}
        skeleton={<ChartSkeleton height={260} />}
      >
        <ChartFrame
          mode={mode}
          title={`${t(`growth.forecast.metric.${metric}`)} · ${t(`growth.country.${country}`)} · ${year}`}
          subtitle={t('growth.forecast.subtitle')}
          legend={legend}
          footnote={t('growth.forecast.modelNote')}
          table={<QuarterlyTable rows={rows} format={format} />}
        >
          {(patterns) => (
            <QuarterlyChart rows={rows} mode={mode} patterns={patterns} formatValue={format} isRtl={isRtl} />
          )}
        </ChartFrame>
      </AsyncBoundary>
    </div>
  );
}

/**
 * The table twin. Three labelled columns, each with its provenance badge in
 * the header — so the distinction survives even for a reader who only ever
 * uses the table view, and for a printed copy with no colour at all.
 */
export function QuarterlyTable({
  rows,
  format,
}: {
  rows: QuarterlyRow[];
  format: (value: number | null) => string;
}) {
  const { t, locale } = useTranslation();

  return (
    <VizTable
      headers={[
        t('growth.forecast.quarter'),
        t('growth.provenance.actual'),
        t('growth.provenance.target'),
        t('growth.provenance.forecast'),
        t('growth.forecast.attainment'),
      ]}
    >
      {rows.map((row) => (
        <tr key={`${row.metric}-${row.quarter}`} className="border-b border-sand-100">
          <td className="px-3 py-2">Q{row.quarter}</td>
          <td className={`px-3 py-2 ${PROVENANCE.ACTUAL.valueTextClass}`}>
            <span className="flex items-center gap-2">
              <ProvenanceBadge provenance="ACTUAL" />
              {format(row.actual)}
            </span>
          </td>
          <td className={`px-3 py-2 ${PROVENANCE.TARGET.valueTextClass}`}>
            <span className="flex items-center gap-2">
              <ProvenanceBadge provenance="TARGET" />
              {row.target === null ? t('growth.forecast.noTarget') : format(row.target)}
            </span>
          </td>
          <td className={`px-3 py-2 ${PROVENANCE.FORECAST.valueTextClass}`}>
            <span className="flex items-center gap-2">
              <ProvenanceBadge provenance="FORECAST" />
              {format(row.forecast)}
            </span>
          </td>
          <td className="px-3 py-2">{row.attainment === null ? NO_DATA : formatRate(locale, row.attainment)}</td>
        </tr>
      ))}
    </VizTable>
  );
}

function ScenarioSummary({
  endingPaid,
  endingMrrMinor,
  totalSpendMinor,
  country,
}: {
  endingPaid: number;
  endingMrrMinor: number;
  totalSpendMinor: number;
  country: CountryCode;
}) {
  const { t, locale } = useTranslation();
  const currency = COUNTRY_CURRENCY[country];

  // Everything in this block is FORECAST by construction — it is the model's
  // own output — so all three carry the forecast treatment, not just a
  // footnote at the bottom of the card.
  const items = [
    { label: t('growth.forecast.metric.PAID_USERS'), value: formatCount(locale, endingPaid) },
    {
      label: t('growth.forecast.metric.MRR_MINOR'),
      value: formatMoneyMinor(locale, endingMrrMinor, currency, country, { compact: true }),
    },
    {
      label: t('growth.acquisition.spend'),
      value: formatMoneyMinor(locale, totalSpendMinor, currency, country, { compact: true }),
    },
  ];

  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="rounded-card border border-dashed border-amber-500/60 bg-amber-100/30 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-soft">{item.label}</span>
            <ProvenanceBadge provenance="FORECAST" hint />
          </div>
          <p className={`mt-1 text-2xl font-semibold ${PROVENANCE.FORECAST.valueTextClass}`}>{item.value}</p>
        </div>
      ))}
    </div>
  );
}
