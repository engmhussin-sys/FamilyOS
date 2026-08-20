import { useMemo, useState } from 'react';

import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { GrowthPageHeader } from '../../growth/components/FilterBar';
import {
  AsyncBoundary,
  FigureGridSkeleton,
  RefetchingOverlay,
} from '../../../shared/components/AsyncState';
import { formatCount } from '../../growth/lib/format';
import { RANGE_PRESETS, rangeFor, type RangePreset } from '../../growth/lib/range';
import { useDecisionBreakdown } from '../api/useDecisionBreakdown';
import type { DecisionAudience } from '../api/decisionBreakdownApi';
import { DecisionBreakdownTable } from '../components/DecisionBreakdownTable';

/**
 * THE NOTIFICATION DECISION LOG, FOR AN OPERATOR.
 *
 * WHAT IT ANSWERS, and the list is short on purpose: over a window, how many
 * notifications the engine SENT, DEFERRED and SUPPRESSED, how many the
 * pipeline actually DELIVERED, how many died with a delivery error — and
 * WHERE each of those numbers is: which audience, which notification type,
 * which source, which decision provider, which day, which cause.
 *
 * WHAT IT IS NOT. Not an analytics platform, not a query builder, and not a
 * drill-through. There is no row-level view and there cannot be one: the
 * endpoint behind this page returns counts and closed-vocabulary names, and a
 * platform operator has no business reading one household's notifications.
 * The absence of a "click a bar to see who" is the design, exactly as
 * `ProductAiPage` states for children's data.
 *
 * WHY THE COUNTRY FILTER IS NOT HERE even though the route accepts one: this
 * page answers «is the notification pipeline healthy», which is a property of
 * the deployment, not of a market. The per-market view of the same ledger
 * already exists as `NotificationsPanel` on `/growth/product`, scoped by that
 * page's own country chip, and two country selectors for one table is how two
 * screens end up disagreeing about what "Egypt" meant.
 */

const AUDIENCES: ReadonlyArray<DecisionAudience | 'ALL'> = ['ALL', 'PARENT', 'CHILD'];

export function NotificationDecisionsPage() {
  const { t, locale } = useTranslation();
  const [range, setRange] = useState<RangePreset>('last30');
  const [audience, setAudience] = useState<DecisionAudience | 'ALL'>('ALL');
  const window = useMemo(() => rangeFor(range), [range]);

  const query = useDecisionBreakdown(window, audience);
  const report = query.data;

  return (
    <div>
      <GrowthPageHeader
        title={t('notifications.decisions.title')}
        subtitle={t('notifications.decisions.subtitle')}
      />

      {/* One filter row above everything it scopes — `FilterBar`'s rule,
          rebuilt here with the two controls this page has rather than
          borrowing a bar whose country chip this page deliberately omits. */}
      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-card border border-sand-200 bg-white px-4 py-3 shadow-quiet">
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">{t('growth.filter.range')}</legend>
          <span className="text-xs font-medium text-ink-soft">{t('growth.filter.range')}</span>
          {RANGE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={range === preset}
              onClick={() => setRange(preset)}
              className={`rounded-card px-3 py-1.5 text-xs font-medium transition-colors ${
                range === preset
                  ? 'bg-guardian-900 text-sand-50'
                  : 'bg-sand-100 text-ink-soft hover:bg-sand-200'
              }`}
            >
              {t(`growth.filter.${preset}`)}
            </button>
          ))}
        </fieldset>

        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">{t('notifications.decisions.filter.audience')}</legend>
          <span className="text-xs font-medium text-ink-soft">
            {t('notifications.decisions.filter.audience')}
          </span>
          {AUDIENCES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={audience === option}
              onClick={() => setAudience(option)}
              className={`rounded-card px-3 py-1.5 text-xs font-medium transition-colors ${
                audience === option
                  ? 'bg-guardian-900 text-sand-50'
                  : 'bg-sand-100 text-ink-soft hover:bg-sand-200'
              }`}
            >
              {t(`notifications.decisions.audience.${option}`)}
            </button>
          ))}
        </fieldset>
      </div>

      <p className="mb-5 rounded-card border border-guardian-700/30 bg-sage-100/60 px-4 py-3 text-xs text-guardian-900">
        {t('notifications.decisions.aggregateOnly')}
      </p>

      <AsyncBoundary
        isLoading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        // The whole window empty is EMPTY, not a row of zeros. `AsyncBoundary`
        // renders `EmptyBlock`, whose Arabic already says "this is not a
        // zero" — which is the sentence this page most needs.
        isEmpty={report !== undefined && report.totals.total === 0}
        emptyHint={t('notifications.decisions.emptyHint')}
        skeleton={<FigureGridSkeleton count={6} columns={3} />}
      >
        {report && (
          <RefetchingOverlay isFetching={query.isFetching}>
            {/* The window the SERVER resolved, not the one this page asked
                for. Both dates are absent from the request by default and the
                route fills them in; printing our own request would label the
                numbers with a period they may not be from. */}
            <p className="mb-4 text-xs text-ink-soft">
              {t('notifications.decisions.window')}:{' '}
              <span dir="ltr" className="font-mono">
                {report.fromBusinessDate} → {report.toBusinessDate}
              </span>
            </p>

            <dl className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Figure
                label={t('notifications.decisions.column.total')}
                value={formatCount(locale, report.totals.total)}
              />
              <Figure
                label={t('notifications.decisions.column.sent')}
                value={formatCount(locale, report.totals.decidedSend)}
                hint={t('notifications.decisions.engineHint')}
              />
              <Figure
                label={t('notifications.decisions.column.deferred')}
                value={formatCount(locale, report.totals.decidedDefer)}
                hint={t('notifications.decisions.engineHint')}
              />
              <Figure
                label={t('notifications.decisions.column.suppressed')}
                value={formatCount(locale, report.totals.decidedSuppress)}
                hint={t('notifications.decisions.engineHint')}
              />
              <Figure
                label={t('notifications.decisions.column.delivered')}
                value={formatCount(locale, report.totals.delivered)}
                hint={t('notifications.decisions.pipelineHint')}
              />
              <Figure
                label={t('notifications.decisions.column.errors')}
                value={formatCount(locale, report.totals.deliveryErrors)}
                hint={t('notifications.decisions.pipelineHint')}
                alert={report.totals.deliveryErrors > 0}
              />
            </dl>

            <div className="grid gap-4 xl:grid-cols-2">
              <DecisionBreakdownTable
                title={t('notifications.decisions.byAudience')}
                hint={t('notifications.decisions.byAudienceHint')}
                bucketHeader={t('notifications.decisions.filter.audience')}
                buckets={report.byAudience}
              />
              <DecisionBreakdownTable
                title={t('notifications.decisions.bySource')}
                hint={t('notifications.decisions.bySourceHint')}
                bucketHeader={t('notifications.decisions.sourceHeader')}
                buckets={report.bySource}
              />
              <DecisionBreakdownTable
                title={t('notifications.decisions.byProvenance')}
                hint={t('notifications.decisions.byProvenanceHint')}
                bucketHeader={t('notifications.decisions.provenanceHeader')}
                buckets={report.byProvenance}
              />
              <DecisionBreakdownTable
                title={t('notifications.decisions.byDate')}
                hint={t('notifications.decisions.byDateHint')}
                bucketHeader={t('notifications.decisions.dateHeader')}
                buckets={report.byDate}
              />
              <DecisionBreakdownTable
                title={t('notifications.decisions.byType')}
                hint={t('notifications.decisions.byTypeHint', { limit: report.limits.topLimit })}
                bucketHeader={t('notifications.decisions.typeHeader')}
                buckets={report.byNotificationType}
                truncated={report.limits.typesTruncated}
                truncationReason={t('notifications.decisions.remainderWhy', {
                  limit: report.limits.topLimit,
                })}
              />
              <DecisionBreakdownTable
                title={t('notifications.decisions.topCauses')}
                hint={t('notifications.decisions.topCausesHint', { limit: report.limits.topLimit })}
                bucketHeader={t('notifications.decisions.causeHeader')}
                buckets={report.topCauses}
                truncated={report.limits.causesTruncated}
                truncationReason={t('notifications.decisions.remainderWhy', {
                  limit: report.limits.topLimit,
                })}
              />
            </div>

            <p className="mt-5 text-xs text-ink-soft">
              {t('notifications.decisions.source')}:{' '}
              <code className="font-mono" dir="ltr">
                GET /system/notifications/decision-breakdown
              </code>
            </p>
          </RefetchingOverlay>
        )}
      </AsyncBoundary>
    </div>
  );
}

/** The same stat tile `NotificationsPanel` uses, so the two notification
 * surfaces in this dashboard read as one. */
function Figure({
  label,
  value,
  hint,
  alert = false,
}: {
  label: string;
  value: string;
  hint?: string;
  alert?: boolean;
}) {
  return (
    <div
      className={`rounded-card border px-3 py-2.5 ${
        alert ? 'border-brick-500/40 bg-brick-100/50' : 'border-sand-200 bg-sand-50/60'
      }`}
    >
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd
        className={`mt-1 text-xl font-semibold tabular-nums ${alert ? 'text-brick-600' : 'text-ink'}`}
      >
        {value}
      </dd>
      {hint && <p className="mt-1 text-[11px] leading-snug text-ink-soft">{hint}</p>}
    </div>
  );
}
