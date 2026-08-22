import { useQuery } from '@tanstack/react-query';

import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { AsyncBoundary, GapBlock } from '../../../shared/components/AsyncState';
import { DataTable } from '../../../shared/components/DataTable';
import { deliveriesApi } from '../api/platformRuntimeApi';

/**
 * ===========================================================================
 * WHAT COULD NOT BE DELIVERED — and the far larger thing this gauge cannot see.
 * ===========================================================================
 *
 * `GET /system/notifications/deliveries` has existed behind the operator key
 * for a while and nothing has ever called it. It answers one question honestly:
 * how many notifications are queued, how many died permanently, and of which
 * types.
 *
 * ── WHAT IT SHOWS, AND WHY IT SHOWS SO LITTLE ──────────────────────────
 *
 * Counts and type names. No title, no body, no child id, no family id. That is
 * the backend's deliberate shape, argued in its own controller: «which
 * household» is not needed to triage «FCM credentials are rotated», and putting
 * it here would make a platform dashboard a place children's notification text
 * is readable. This client cannot widen that and should not want to.
 *
 * ── THE HONEST CAVEAT, WHICH IS THE MOST IMPORTANT THING ON THE PAGE ───
 *
 * These numbers cover the DEFERRED path only — notifications held by quiet
 * hours and released by `notification-delivery-sweep`. The IMMEDIATE path
 * computes its push outcome and discards it; the backend says so in its own
 * words at `prisma-runtime-alert.repository.ts` («THE PUSH CHANNEL IS COMPUTED
 * HERE AND DISCARDED HERE»). So a `dead: 0` on this screen does NOT mean every
 * notification arrived. It means no DEFERRED notification exhausted its
 * attempts. Rendering that number without the caveat would be the most
 * misleading green figure in this dashboard, which is exactly why the caveat is
 * rendered above it rather than in a footnote.
 *
 * The per-notification surface — retry one, cancel one, inspect one — does not
 * exist on the backend at all. It is declared here as a GAP rather than
 * approximated with a client-side join, because there is no key to join on:
 * `notification_decisions` stores no notification id, only `sourceEventId`.
 */

/** Declared, not implied. The endpoint that would close this is written out. */
const PER_NOTIFICATION_GAP = {
  proposedEndpoint: 'GET /system/notifications/deliveries/:id · POST .../retry · POST .../cancel',
  reasonKey: 'deliveries.gapReason',
};

const IMMEDIATE_PATH_GAP = {
  proposedEndpoint: 'notification_deliveries row for the immediate push path',
  reasonKey: 'deliveries.immediateGapReason',
};

export function DeliveriesPage() {
  const { t } = useTranslation();

  const backlog = useQuery({ queryKey: ['platform-deliveries'], queryFn: deliveriesApi.backlog });

  return (
    <section>
      <header>
        <h1>{t('deliveries.title')}</h1>
        <p>{t('deliveries.intro')}</p>
      </header>

      {/* ABOVE the numbers, on purpose. A caveat under a green zero is a caveat
          nobody reads. */}
      <p role="note" className="mt-4 rounded-card border border-amber-500/60 bg-amber-100/40 p-4 text-sm">
        {t('deliveries.scopeCaveat')}
      </p>

      <AsyncBoundary
        isLoading={backlog.isLoading}
        error={backlog.isError ? (backlog.error as Error) : null}
        onRetry={() => backlog.refetch()}
      >
        <section className="mt-6">
          <h2>{t('deliveries.gauges')}</h2>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-card border border-sand-200 bg-white p-4">
              <dt className="text-sm text-ink-soft">{t('deliveries.pending')}</dt>
              <dd className="mt-1 text-2xl tabular-nums">{backlog.data?.pending ?? 0}</dd>
            </div>
            <div className="rounded-card border border-sand-200 bg-white p-4">
              <dt className="text-sm text-ink-soft">{t('deliveries.dead')}</dt>
              <dd className="mt-1 text-2xl tabular-nums">{backlog.data?.dead ?? 0}</dd>
            </div>
            <div className="rounded-card border border-sand-200 bg-white p-4">
              <dt className="text-sm text-ink-soft">{t('deliveries.oldestPendingHours')}</dt>
              <dd className="mt-1 text-2xl tabular-nums">
                {backlog.data ? Math.floor(backlog.data.oldestPendingAgeSeconds / 3600) : 0}
              </dd>
            </div>
          </dl>
        </section>

        <section className="mt-8">
          <h2>{t('deliveries.deadByType')}</h2>
          <AsyncBoundary
            isLoading={false}
            error={null}
            isEmpty={(backlog.data?.deadByType.length ?? 0) === 0}
            emptyHint={t('deliveries.noDead')}
          >
            <DataTable
              caption={t('deliveries.deadByType')}
              columns={[
                { key: 'type', header: t('deliveries.type'), cell: (row) => row.type, ltr: true },
                { key: 'count', header: t('deliveries.count'), cell: (row) => row.count, numeric: true },
              ]}
              rows={backlog.data?.deadByType ?? []}
              rowKey={(row) => row.type}
            />
          </AsyncBoundary>
        </section>
      </AsyncBoundary>

      <section className="mt-8">
        <h2>{t('deliveries.notMeasured')}</h2>
        <div className="grid gap-3">
          <GapBlock gap={IMMEDIATE_PATH_GAP} />
          <GapBlock gap={PER_NOTIFICATION_GAP} />
        </div>
      </section>
    </section>
  );
}
