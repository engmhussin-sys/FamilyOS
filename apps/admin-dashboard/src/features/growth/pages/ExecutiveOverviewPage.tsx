import { useMemo, useState } from 'react';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { COUNTRY_CODES, type CountryCode, type KpiId } from '../api/types';
import { useDaily, useKpis } from '../api/useGrowthQueries';
import { composeExecutiveCounts, fetchRefunds, pickKpi, subscriptionPlanMixGap } from '../api/adapters';
import { COUNTRY_CURRENCY, countryWithCurrencyLabel, formatCount, formatMoneyMinor } from '../lib/format';
import { rangeFor, type RangePreset } from '../lib/range';
import { KpiCard } from '../components/KpiCard';
import { ProvenanceLegend } from '../components/ProvenanceBadge';
import { AlertsPanel } from '../components/AlertsPanel';
import {
  AsyncBoundary,
  ComposedFromNote,
  FigureGridSkeleton,
  GapBlock,
  KpiGridSkeleton,
  RefetchingOverlay,
} from '../../../shared/components/AsyncState';
import { PlatformTotalsPanel } from '../components/PlatformTotalsPanel';
import { PilotPanel } from '../components/PilotPanel';
import { GrowthPageHeader } from '../components/FilterBar';
import { RANGE_PRESETS } from '../lib/range';

/**
 * The executive overview.
 *
 * What it answers: "how are the two markets doing, right now, each on its
 * own terms." Deliberately NOT "how is the business doing in one number" —
 * the contract returns no money at `countryCode='**'` and this screen does
 * not manufacture one either.
 *
 * Layout is two columns, one per market, and they are structurally
 * independent all the way down: separate queries, separate currencies,
 * separate KPI cards. There is no row anywhere on this page that sums an
 * EGP figure with a SAR one, and the only cross-market element is the
 * alerts panel, which counts incidents rather than money.
 *
 * Most important first: alerts, then the activation/conversion pair the
 * product lives on, then volume, then money. Detail is one click away on
 * the funnel / unit-economics / acquisition views rather than crammed here.
 */

/** Ordered by what an operator checks first, not by the catalogue's order. */
const HEADLINE_KPIS: readonly KpiId[] = ['ACTIVATION_RATE', 'CONVERSION_RATE', 'TRIAL_CONVERSION_RATE', 'CHURN_RATE'];
const VOLUME_KPIS: readonly KpiId[] = ['DAU', 'WAU', 'MAU', 'STICKINESS'];
const MONEY_KPIS: readonly KpiId[] = ['MRR', 'ARR', 'ARPU', 'ARPPU'];

export function ExecutiveOverviewPage() {
  const { t } = useTranslation();
  const [range, setRange] = useState<RangePreset>('last30');
  const window = useMemo(() => rangeFor(range), [range]);

  return (
    <div>
      <GrowthPageHeader title={t('growth.overview.title')} subtitle={t('growth.overview.subtitle')} />

      {/* Alerts sit above everything. Burying an operator alert under four
          KPI rows is how a churn spike gets noticed a week late. */}
      <div className="mb-6">
        <AlertsPanel />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink-soft">{t('growth.filter.range')}</span>
        {RANGE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-pressed={range === preset}
            onClick={() => setRange(preset)}
            className={`rounded-card px-3 py-1.5 text-xs font-medium transition-colors ${
              range === preset ? 'bg-guardian-900 text-sand-50' : 'bg-sand-100 text-ink-soft hover:bg-sand-200'
            }`}
          >
            {t(`growth.filter.${preset}`)}
          </button>
        ))}
      </div>

      <div className="mb-6">
        <ProvenanceLegend />
      </div>

      <p className="mb-5 rounded-card border border-sand-200 bg-sand-50 px-4 py-3 text-xs text-ink-soft">
        {t('growth.overview.currencyNote')}
      </p>

      {/* Platform-wide first and clearly framed as such, then the two
          markets side by side. The order is scope-descending, so nothing on
          this page is ever read at the wrong scope. */}
      <div className="mb-6">
        <PlatformTotalsPanel />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        {COUNTRY_CODES.map((country) => (
          <CountryColumn key={country} country={country} from={window.from} to={window.to} />
        ))}
      </div>

      <div className="mt-6">
        <PilotPanel />
      </div>
    </div>
  );
}

/**
 * One market's entire column. Every money value inside it is formatted with
 * `countryScope={country}` — the formatter throws without it, which is what
 * makes "never silently mix currencies" a mechanical guarantee rather than
 * a review convention.
 */
function CountryColumn({ country, from, to }: { country: CountryCode; from: string; to: string }) {
  const { t, locale } = useTranslation();
  const kpis = useKpis(country);
  const daily = useDaily(country, { from, to });

  const counts = composeExecutiveCounts(daily.data ?? []);
  const refunds = fetchRefunds();
  const planMix = subscriptionPlanMixGap();
  const currency = COUNTRY_CURRENCY[country];
  const contextLabel = countryWithCurrencyLabel(t(`growth.country.${country}`), currency);

  return (
    <section
      aria-labelledby={`overview-${country}`}
      className="rounded-card border border-sand-200 bg-sand-50/40 p-5"
    >
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h3 id={`overview-${country}`} className="font-display text-lg text-ink">
          {t(`growth.country.${country}`)}
        </h3>
        {/* The currency is stated once, at the top of the column, and every
            figure below inherits that context visually as well as in code. */}
        <span className="rounded-card bg-guardian-900 px-2.5 py-1 text-xs font-medium text-sand-50" dir="ltr">
          {currency}
        </span>
      </header>

      <AsyncBoundary
        isLoading={kpis.isLoading}
        error={kpis.error}
        onRetry={() => void kpis.refetch()}
        skeleton={<KpiGridSkeleton count={6} />}
      >
        <RefetchingOverlay isFetching={kpis.isFetching}>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-soft">
            {t('growth.overview.engagement')}
          </h4>
          <div className="mb-5 grid gap-3 sm:grid-cols-2">
            {HEADLINE_KPIS.map((id) => (
              <KpiCard key={id} kpi={pickKpi(kpis.data, id)} countryScope={country} contextLabel={contextLabel} />
            ))}
          </div>

          <div className="mb-5 grid gap-3 sm:grid-cols-2">
            {VOLUME_KPIS.map((id) => (
              <KpiCard key={id} kpi={pickKpi(kpis.data, id)} countryScope={country} />
            ))}
          </div>

          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-soft">
            {t('growth.overview.money')}
          </h4>
          <div className="mb-5 grid gap-3 sm:grid-cols-2">
            {MONEY_KPIS.map((id) => (
              <KpiCard key={id} kpi={pickKpi(kpis.data, id)} countryScope={country} contextLabel={contextLabel} compact />
            ))}
          </div>
        </RefetchingOverlay>
      </AsyncBoundary>

      <AsyncBoundary
        isLoading={daily.isLoading}
        error={daily.error}
        onRetry={() => void daily.refetch()}
        skeleton={<FigureGridSkeleton count={5} />}
      >
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-soft">
          {t('growth.overview.families')}
        </h4>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          {/* Both labels name their own shape. «مُسجَّلة» over a windowed
              FLOW would have read as the market's total families, and
              «دافعة» over a STOCK read off the latest closed day needs to say
              which day it is a stock of. */}
          <Figure
            label={t('growth.overview.newRegistrations')}
            value={formatCount(locale, counts.data.newRegistrations)}
          />
          <Figure
            label={t('growth.overview.payingFamiliesStock')}
            value={formatCount(locale, counts.data.payingFamilies)}
          />
          <Figure
            label={t('growth.overview.paymentsSucceeded')}
            value={formatCount(locale, counts.data.paymentSuccessCount)}
          />
          <Figure
            label={t('growth.overview.paymentsFailed')}
            value={formatCount(locale, counts.data.paymentFailureCount)}
          />
          <Figure
            label={t('growth.overview.revenue')}
            value={formatMoneyMinor(locale, counts.data.netRevenueMinor, currency, country, { compact: true })}
          />
        </dl>
        <ComposedFromNote endpoints={counts.composedFrom} />

        <h4 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-ink-soft">
          {t('growth.subscriptions.title')}
        </h4>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Figure
            label={t('growth.subscriptions.activePaid')}
            value={formatCount(locale, counts.data.activePaidSubscriptions)}
          />
          <Figure
            label={t('growth.subscriptions.churned')}
            value={formatCount(locale, counts.data.churnedPaidSubscriptions)}
          />
          <Figure
            label={t('growth.subscriptions.trialsStarted')}
            value={formatCount(locale, counts.data.trialsStarted)}
          />
          <Figure
            label={t('growth.subscriptions.trialsConverted')}
            value={formatCount(locale, counts.data.trialsConverted)}
          />
          <Figure
            label={t('growth.subscriptions.newPaidFamilies')}
            value={formatCount(locale, counts.data.newPaidFamilies)}
          />
        </dl>
        <ComposedFromNote endpoints={counts.composedFrom} />
      </AsyncBoundary>

      {/* The three numbers this market cannot answer, named rather than
          zeroed: the free/monthly/annual split, refunds, and children. */}
      <div className="mt-4 flex flex-col gap-3">
        {planMix.kind === 'MISSING' && <GapBlock gap={planMix.gap} />}
        {refunds.kind === 'MISSING' && <GapBlock gap={refunds.gap} />}
      </div>
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-sand-200 bg-white px-3 py-2">
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink">{value}</dd>
    </div>
  );
}
