import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import type { CountryScope } from '../api/types';
import { useNotificationAnalytics } from '../api/useGrowthQueries';
import type { DateRange } from '../lib/range';
import { formatCount, formatRate, NO_DATA } from '../lib/format';
import { AsyncBoundary, ComposedFromNote, FigureGridSkeleton, RefetchingOverlay } from '../../../shared/components/AsyncState';

/**
 * NOTIFICATIONS — `GET /system/notifications/analytics`
 * (`notification-analytics.controller.ts:59`, same `InternalAdminGuard`, and
 * it accepts a `country` filter, so this panel is genuinely per-market).
 *
 * The endpoint returns counts and type names only — no title, no body, no
 * child id, no family id — and this panel asks for nothing else. The
 * `topTypes` list is rendered as counts beside a type NAME, which is a
 * notification kind, not a message.
 *
 * The rule this panel exists to hold: a rate over zero rows is NOT 0%. The
 * backend computes `suppressionRate` and `openRate` as 0 when nothing was
 * written (documented on its own type), so when `total` is 0 this panel
 * renders the rates as NOT MEASURED and says why, rather than reporting a
 * flawless 0% suppression on an empty week.
 */
export function NotificationsPanel({ country, range }: { country: CountryScope; range: DateRange }) {
  const { t, locale } = useTranslation();
  const analytics = useNotificationAnalytics(country, range);
  const report = analytics.data;
  const hasRows = (report?.total ?? 0) > 0;

  return (
    <section
      aria-labelledby="notifications-panel"
      className="rounded-card border border-sand-200 bg-white p-5 shadow-quiet"
    >
      <header className="mb-3">
        <h3 id="notifications-panel" className="font-display text-lg text-ink">
          {t('growth.notifications.title')}
        </h3>
        <p className="mt-1 text-sm text-ink-soft">{t('growth.notifications.subtitle')}</p>
      </header>

      <AsyncBoundary
        isLoading={analytics.isLoading}
        error={analytics.error}
        onRetry={() => void analytics.refetch()}
        skeleton={<FigureGridSkeleton count={6} columns={3} />}
      >
        {report && (
          <RefetchingOverlay isFetching={analytics.isFetching}>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Figure label={t('growth.notifications.delivered')} value={formatCount(locale, report.delivered)} />
              <Figure
                label={t('growth.notifications.suppressed')}
                value={formatCount(locale, report.outcomeSuppressed)}
              />
              <Figure
                label={t('growth.notifications.deliveryFailures')}
                value={formatCount(locale, report.deliveryFailures)}
              />
              <Figure
                label={t('growth.notifications.suppressionRate')}
                value={hasRows ? formatRate(locale, report.suppressionRate) : NO_DATA}
                hint={hasRows ? undefined : t('growth.notifications.rateNeedsRows')}
              />
              <Figure
                label={t('growth.notifications.openRate')}
                value={report.notificationRows > 0 ? formatRate(locale, report.openRate) : NO_DATA}
                hint={report.notificationRows > 0 ? undefined : t('growth.notifications.rateNeedsRows')}
              />
              <Figure
                label={t('growth.notifications.aiRewriteRate')}
                value={hasRows ? formatRate(locale, report.aiRewriteRate) : NO_DATA}
                hint={hasRows ? undefined : t('growth.notifications.rateNeedsRows')}
              />
              {/* Server-side `null` — an honest absence, carried through as
                  one rather than rendered as a confident zero. */}
              <Figure
                label={t('growth.notifications.actionRate')}
                value={report.actionRate === null ? NO_DATA : formatRate(locale, report.actionRate)}
                hint={report.actionRate === null ? t('growth.notifications.actionRateHint') : undefined}
              />
            </dl>
            <ComposedFromNote endpoints={['GET /system/notifications/analytics']} />
          </RefetchingOverlay>
        )}
      </AsyncBoundary>
    </section>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-sand-200 bg-sand-50/60 px-3 py-2.5">
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{value}</dd>
      {hint && <p className="mt-1 text-[11px] leading-snug text-ink-soft">{hint}</p>}
    </div>
  );
}
