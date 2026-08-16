import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { COUNTRY_CODES, type CountryCode, type KpiId } from '../api/types';
import { useKpis } from '../api/useGrowthQueries';
import { pickKpi } from '../api/adapters';
import { COUNTRY_CURRENCY, countryWithCurrencyLabel, formatRatio } from '../lib/format';
import { KpiCard } from '../components/KpiCard';
import { ProvenanceLegend } from '../components/ProvenanceBadge';
import { AsyncBoundary, RefetchingOverlay } from '../components/AsyncState';
import { GrowthPageHeader } from '../components/FilterBar';
import { STATUS } from '../lib/vizTokens';
import { useVizMode } from '../lib/useVizMode';

/**
 * Unit economics.
 *
 * What it answers: "does a paying family pay for the cost of acquiring
 * them, and how long does that take."
 *
 * Two rules are visible in the layout itself:
 *
 *  1. Every ratio is computed inside ONE currency. The backend throws rather
 *     than divide a Saudi LTV by an Egyptian CAC, and this page never puts
 *     the two markets in the same row — they are two columns that never
 *     meet, because "Saudi LTV over Egyptian CAC" is a meaningless number
 *     that looks extremely convincing.
 *  2. LTV, LTV:CAC and payback are structurally FORECAST — all three
 *     multiply a measured number by an assumed gross margin (Egypt 59.6%,
 *     Saudi Arabia 76.5%). They arrive with `provenance: FORECAST` and the
 *     KPI card renders them italic amber with a badge, never as ACTUAL.
 */

const MEASURED: readonly KpiId[] = ['CAC', 'ARPU', 'ARPPU', 'MRR', 'ARR', 'CHURN_RATE'];
const MODELLED: readonly KpiId[] = ['LTV', 'LTV_CAC_RATIO', 'PAYBACK_MONTHS'];

const HEALTHY_LTV_CAC = 3;

export function UnitEconomicsPage() {
  const { t } = useTranslation();

  return (
    <div>
      <GrowthPageHeader title={t('growth.unitEconomics.title')} subtitle={t('growth.unitEconomics.subtitle')} />

      <div className="mb-5">
        <ProvenanceLegend />
      </div>

      <p className="mb-6 rounded-card border border-sand-200 bg-sand-50 px-4 py-3 text-xs text-ink-soft">
        {t('growth.unitEconomics.sameCurrencyRule')}
      </p>

      <div className="grid gap-6 xl:grid-cols-2">
        {COUNTRY_CODES.map((country) => (
          <MarketEconomics key={country} country={country} />
        ))}
      </div>
    </div>
  );
}

function MarketEconomics({ country }: { country: CountryCode }) {
  const { t, locale } = useTranslation();
  const mode = useVizMode();
  const kpis = useKpis(country);
  const currency = COUNTRY_CURRENCY[country];
  const contextLabel = countryWithCurrencyLabel(t(`growth.country.${country}`), currency);

  const ltvCac = pickKpi(kpis.data, 'LTV_CAC_RATIO')?.value ?? null;

  return (
    <section className="rounded-card border border-sand-200 bg-sand-50/40 p-5">
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h3 className="font-display text-lg text-ink">{t(`growth.country.${country}`)}</h3>
        <span className="rounded-card bg-guardian-900 px-2.5 py-1 text-xs font-medium text-sand-50" dir="ltr">
          {currency}
        </span>
      </header>

      <AsyncBoundary isLoading={kpis.isLoading} error={kpis.error} onRetry={() => void kpis.refetch()}>
        <RefetchingOverlay isFetching={kpis.isFetching}>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            {MEASURED.map((id) => (
              <KpiCard key={id} kpi={pickKpi(kpis.data, id)} countryScope={country} contextLabel={contextLabel} compact />
            ))}
          </div>

          {/* The modelled block is visually fenced off from the measured
              one: a dashed amber border says "everything inside this box
              rests on an assumption" before a single number is read. */}
          <div className="rounded-card border-2 border-dashed border-amber-500/70 bg-amber-100/25 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              {MODELLED.map((id) => (
                <KpiCard key={id} kpi={pickKpi(kpis.data, id)} countryScope={country} compact />
              ))}
            </div>

            {/* A meter, not a pie: one ratio against a reference limit. The
                unfilled track is a lighter step of the same ramp so the
                state reads across the whole bar. */}
            {ltvCac !== null && (
              <div className="mt-4">
                <div className="flex items-baseline justify-between text-xs text-ink-soft">
                  <span>{t('growth.kpi.LTV_CAC_RATIO')}</span>
                  <span>{t('growth.unitEconomics.healthyRatio')}</span>
                </div>
                <div
                  className="mt-1.5 h-2 w-full overflow-hidden rounded-full"
                  style={{ backgroundColor: `${STATUS.good[mode]}22` }}
                  role="meter"
                  aria-valuenow={ltvCac}
                  aria-valuemin={0}
                  aria-valuemax={HEALTHY_LTV_CAC}
                  aria-label={t('growth.kpi.LTV_CAC_RATIO')}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (ltvCac / HEALTHY_LTV_CAC) * 100)}%`,
                      backgroundColor: ltvCac >= HEALTHY_LTV_CAC ? STATUS.good[mode] : STATUS.warning[mode],
                    }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-ink-soft">
                  {formatRatio(locale, ltvCac)} / {formatRatio(locale, HEALTHY_LTV_CAC)}
                </p>
              </div>
            )}
          </div>
        </RefetchingOverlay>
      </AsyncBoundary>
    </section>
  );
}
