import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { ALWAYS_FORECAST_KPIS, type CountryScope, type KpiValue } from '../api/types';
import { formatKpi, NO_DATA } from '../lib/format';
import { PROVENANCE } from '../lib/vizTokens';
import { ProvenanceBadge } from './ProvenanceBadge';

/**
 * The stat tile — the form the dataviz skill picks for "a single current
 * value". Not a one-bar bar chart, not a gauge: the number IS the chart.
 *
 * Three things this component refuses to do:
 *
 *  1. Render `null` as `0`. It renders an em dash and the words "no data
 *     yet", because the contract's rule 2 is that a null retention figure
 *     means the cohort is younger than the horizon, not that everybody left.
 *  2. Render money without its market. `countryScope` is a required prop and
 *     `formatMoneyMinor` throws if it is absent or is the platform scope —
 *     so a MONEY_MINOR tile physically cannot appear on a screen that does
 *     not say which country it belongs to.
 *  3. Paint an assumption like a measurement. Provenance drives the value's
 *     own typography (FORECAST is italic amber) as well as a badge.
 *
 * Figures use the default proportional numerals — `tabular-nums` is for
 * columns that align vertically, and makes a large standalone number look
 * loose.
 */

interface KpiCardProps {
  kpi: KpiValue | undefined;
  /** Which market this tile's number belongs to. Required, by design. */
  countryScope: CountryScope;
  /** Rendered beside the label, e.g. "مصر · EGP". */
  contextLabel?: string;
  /** Promotes the tile to the view's hero figure. Exactly one per view. */
  hero?: boolean;
  compact?: boolean;
}

export function KpiCard({ kpi, countryScope, contextLabel, hero = false, compact = false }: KpiCardProps) {
  const { t, locale } = useTranslation();

  if (!kpi) {
    return (
      <article className="rounded-card border border-dashed border-sand-200 bg-sand-50/50 p-4">
        <p className="text-xs text-ink-soft">{t('growth.state.noData')}</p>
        <p className="mt-1 text-2xl text-ink-soft">{NO_DATA}</p>
      </article>
    );
  }

  const treatment = PROVENANCE[kpi.provenance];
  const isStructurallyForecast = ALWAYS_FORECAST_KPIS.includes(kpi.kpi);
  const hasValue = kpi.value !== null;

  const formatted = formatKpi(kpi.kind, kpi.value, kpi.currencyCode, {
    locale,
    countryScope,
    compact,
  });

  return (
    <article className="rounded-card border border-sand-200 bg-white p-4 shadow-quiet">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-xs font-medium text-ink-soft">{t(`growth.kpi.${kpi.kpi}`)}</h4>
          {contextLabel && <p className="mt-0.5 text-[11px] text-ink-soft/80">{contextLabel}</p>}
        </div>
        <ProvenanceBadge provenance={kpi.provenance} hint />
      </header>

      <p
        className={`mt-2 font-body font-semibold ${hero ? 'text-5xl' : 'text-2xl'} ${
          hasValue ? treatment.valueTextClass : 'text-ink-soft'
        }`}
        // Proportional figures deliberately: tabular-nums is for columns.
        dir="auto"
      >
        {formatted}
      </p>

      {!hasValue && <p className="mt-1 text-xs text-ink-soft">{t('growth.state.emptyHint')}</p>}

      {isStructurallyForecast && (
        <p className="mt-2 text-[11px] text-amber-700">{t('growth.provenance.alwaysForecast')}</p>
      )}
    </article>
  );
}
