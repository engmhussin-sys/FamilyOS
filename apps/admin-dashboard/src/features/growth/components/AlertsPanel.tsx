import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { Button } from '../../../shared/components/Button';
import { acknowledgeAlert, fetchAlerts } from '../api/growthApi';
import type { GrowthAlert } from '../api/types';
import { SEVERITY_STATUS, STATUS } from '../lib/vizTokens';
import { useVizMode } from '../lib/useVizMode';
import { AsyncBoundary } from '../../../shared/components/AsyncState';
import { formatRate } from '../lib/format';

/**
 * Alerts, at the top of the executive view rather than on a page of their
 * own that nobody opens. The backend's eight conditions are the only ones
 * rendered — none is synthesised here.
 *
 * `message` arrives already written in Arabic by the server, with the
 * numbers already in it, so it is shown verbatim: re-deriving the sentence
 * on the client would be a second implementation of the alert's meaning.
 *
 * A status colour never carries the severity alone — every row ships an
 * icon glyph and the severity word beside it.
 */

const SEVERITY_GLYPH: Record<GrowthAlert['severity'], string> = {
  INFO: 'ℹ',
  WARNING: '▲',
  CRITICAL: '■',
};

export function AlertsPanel() {
  const { t, locale } = useTranslation();
  const mode = useVizMode();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['growth', 'alerts', 'unacknowledged'],
    queryFn: () => fetchAlerts(false, 50),
  });

  const acknowledge = useMutation({
    mutationFn: (id: string) => acknowledgeAlert(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['growth', 'alerts'] }),
  });

  const alerts = query.data ?? [];
  const criticalCount = alerts.filter((a) => a.severity === 'CRITICAL').length;

  return (
    <section aria-labelledby="growth-alerts-heading" className="rounded-card border border-sand-200 bg-white p-5 shadow-quiet">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h3 id="growth-alerts-heading" className="font-display text-base text-ink">
          {t('growth.alerts.title')}
        </h3>
        {criticalCount > 0 && (
          <span
            className="rounded-card px-2.5 py-1 text-xs font-medium"
            style={{ backgroundColor: `${STATUS.critical[mode]}1F`, color: STATUS.critical.light }}
          >
            {SEVERITY_GLYPH.CRITICAL} {t('growth.alerts.criticalCount', { count: criticalCount })}
          </span>
        )}
      </header>

      <AsyncBoundary
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={alerts.length === 0}
        emptyHint={t('growth.alerts.none')}
        onRetry={() => void query.refetch()}
      >
        <ul className="flex flex-col gap-2">
          {alerts.map((alert) => {
            const status = STATUS[SEVERITY_STATUS[alert.severity]];
            return (
              <li
                key={alert.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-card border border-sand-200 p-3"
                style={{ borderInlineStartWidth: 4, borderInlineStartColor: status[mode] }}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs">
                    <span aria-hidden="true" style={{ color: status.light }}>
                      {SEVERITY_GLYPH[alert.severity]}
                    </span>
                    <span className="font-medium text-ink">{t(`growth.alerts.type.${alert.alertType}`)}</span>
                    <span className="text-ink-soft">{t(`growth.alerts.severity.${alert.severity}`)}</span>
                    <span className="text-ink-soft">
                      {t('growth.alerts.scope')}: {alert.scopeKey}
                    </span>
                    <span className="text-ink-soft" dir="ltr">
                      {alert.businessDate}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-ink">{alert.message}</p>
                  <p className="mt-1 text-[11px] text-ink-soft">
                    {t('growth.alerts.observed')}: {formatRate(locale, alert.observedValue)} ·{' '}
                    {t('growth.alerts.threshold')}: {formatRate(locale, alert.thresholdValue)}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  isLoading={acknowledge.isPending && acknowledge.variables === alert.id}
                  onClick={() => acknowledge.mutate(alert.id)}
                >
                  {t('growth.alerts.acknowledge')}
                </Button>
              </li>
            );
          })}
        </ul>
      </AsyncBoundary>
    </section>
  );
}
