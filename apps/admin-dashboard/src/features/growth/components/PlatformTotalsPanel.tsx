import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { usePlatformMetrics } from '../api/useGrowthQueries';
import { activeParentsGap, activeChildrenGap, familiesByCountryGap } from '../api/adapters';
import { formatCount } from '../lib/format';
import { AsyncBoundary, ComposedFromNote, FigureGridSkeleton, GapBlock, RefetchingOverlay } from './AsyncState';

/**
 * PLATFORM TOTALS — `GET /analytics/dashboard-metrics`
 * (`analytics.controller.ts:107`, behind the same `InternalAdminGuard`).
 *
 * It sits ABOVE the two country columns and outside them, in its own frame,
 * because it is genuinely a different scope: the endpoint takes no country
 * parameter and the service counts every `family` and `device` row there is.
 * Placed inside a market column it would be read as that market's number,
 * which it is not — so the scope is stated in the panel's own heading, in a
 * band across the top, and once more under the figures.
 *
 * Two things it deliberately does NOT show:
 *   - `trialConversionRate`, which this endpoint converts from null to 0
 *     before sending. The per-country `TRIAL_CONVERSION_RATE` KPI on
 *     `/admin/growth/kpis` reports the same quantity honestly as `null`, and
 *     that is the one the columns below render.
 *   - a per-country split of any kind. See `familiesByCountryGap`.
 *
 * No money appears here, and none can: a platform-wide currency figure would
 * have to add EGP to SAR.
 */
export function PlatformTotalsPanel() {
  const { t, locale } = useTranslation();
  const metrics = usePlatformMetrics();
  const perCountry = familiesByCountryGap();
  const parents = activeParentsGap();
  const children = activeChildrenGap();

  const figures = metrics.data
    ? [
        { label: t('growth.platform.registeredFamilies'), value: metrics.data.totalFamilies },
        { label: t('growth.platform.activeFamilies'), value: metrics.data.activeFamiliesLast7Days },
        { label: t('growth.platform.devices'), value: metrics.data.totalDevices },
        { label: t('growth.platform.activeDevices'), value: metrics.data.activeDevicesLast7Days },
        { label: t('growth.platform.supportRequests'), value: metrics.data.supportRequestCountLast7Days },
      ]
    : [];

  return (
    <section
      aria-labelledby="platform-totals"
      className="rounded-card border border-sand-200 bg-white p-5 shadow-quiet"
    >
      <header className="mb-3">
        <h3 id="platform-totals" className="font-display text-lg text-ink">
          {t('growth.platform.title')}
        </h3>
        <p className="mt-1 text-sm text-ink-soft">{t('growth.platform.subtitle')}</p>
      </header>

      {/* Scope, stated before the numbers rather than under them. */}
      <p className="mb-4 rounded-card border border-guardian-700/30 bg-sage-100/60 px-4 py-2.5 text-xs text-guardian-900">
        {t('growth.platform.scopeWarning')}
      </p>

      <AsyncBoundary
        isLoading={metrics.isLoading}
        error={metrics.error}
        onRetry={() => void metrics.refetch()}
        skeleton={<FigureGridSkeleton count={5} columns={3} />}
      >
        <RefetchingOverlay isFetching={metrics.isFetching}>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {figures.map((figure) => (
              <div key={figure.label} className="rounded-card border border-sand-200 bg-sand-50/60 px-3 py-2.5">
                <dt className="text-xs text-ink-soft">{figure.label}</dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">
                  {formatCount(locale, figure.value)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-ink-soft">{t('growth.platform.activeDefinition')}</p>
          <ComposedFromNote endpoints={['GET /analytics/dashboard-metrics']} />
        </RefetchingOverlay>
      </AsyncBoundary>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <GapBlock gap={perCountry.gap} />
        <GapBlock gap={parents.gap} />
        <GapBlock gap={children.gap} />
      </div>
    </section>
  );
}
