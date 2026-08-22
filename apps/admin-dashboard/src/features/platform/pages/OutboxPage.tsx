import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { AsyncBoundary } from '../../../shared/components/AsyncState';
import { DataTable } from '../../../shared/components/DataTable';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';
import { Button } from '../../../shared/components/Button';
import { outboxApi } from '../api/platformRuntimeApi';

/**
 * ===========================================================================
 * THE DELIVERIES THAT DIED, AND THE ONE BUTTON THAT BRINGS THEM BACK.
 * ===========================================================================
 *
 * The outbox has had a `DEAD` status, a backoff and a `maxAttempts` of 8 since
 * F3, and until now nobody could see or undo any of it. The backend's own
 * comment on this controller records why that was worse than it sounds:
 * `backlog()` counts `PENDING` and `FAILED` only, so a message reaching `DEAD`
 * makes the backlog gauge go DOWN — the single alert that existed got QUIETER
 * as the incident got worse.
 *
 * ── WHY BOTH NUMBERS ARE ON THE SAME SCREEN ────────────────────────────
 *
 * «12 dead, 0 pending» and «12 dead, 4,000 pending» are different incidents.
 * The first is a poison message; the second is a relay that has stopped. The
 * backend returns them from one call precisely so an operator cannot read one
 * without the other.
 *
 * ── WHY RECOVERY IS A BUTTON AND NOT A TIMER ───────────────────────────
 *
 * A message that has failed eight times may fail forever. Requeueing it
 * automatically is how a poison message becomes an infinite loop. The judgement
 * «the downstream is healthy now» is a human's.
 *
 * ── WHY IT IS SAFE TO PRESS TWICE, AND WHY THE DIALOG SAYS SO ──────────
 *
 * The recovery SQL filters on `status = 'DEAD'`, so a second press moves zero
 * rows; the redelivery collides on `domain_events (family_id, idempotency_key)`
 * and on `notifications (family_id, source_event_id, user_id)`. It cannot
 * produce a second reward, event or notification — proven in
 * `test/events/reward-delivery-recovery.e2e.spec.ts`. An operator staring at a
 * production button deserves to be told that, not to have to trust it.
 */
export function OutboxPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [pendingEventType, setPendingEventType] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const report = useQuery({ queryKey: ['platform-outbox'], queryFn: outboxApi.deadLetters });

  const recover = useMutation({
    mutationFn: (eventType?: string) => outboxApi.recover({ eventType }),
    onSuccess: (result) => {
      setPendingEventType(null);
      setOutcome(
        t('outbox.recovered', { recovered: String(result.recovered), remaining: String(result.remaining) }),
      );
      queryClient.invalidateQueries({ queryKey: ['platform-outbox'] });
    },
    onError: (error: Error) => {
      setPendingEventType(null);
      setOutcome(error.message);
    },
  });

  const dead = report.data?.deadLetters;
  const backlog = report.data?.backlog;

  return (
    <section>
      <header>
        <h1>{t('outbox.title')}</h1>
        <p>{t('outbox.intro')}</p>
      </header>

      {outcome ? (
        <p role="status" className="mt-4 rounded-card border border-sand-200 bg-white p-3 text-sm">
          {outcome}
        </p>
      ) : null}

      <AsyncBoundary
        isLoading={report.isLoading}
        error={report.isError ? (report.error as Error) : null}
        onRetry={() => report.refetch()}
      >
        <section className="mt-6">
          <h2>{t('outbox.gauges')}</h2>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-card border border-sand-200 bg-white p-4">
              <dt className="text-sm text-ink-soft">{t('outbox.dead')}</dt>
              <dd className="mt-1 text-2xl tabular-nums">{dead?.total ?? 0}</dd>
            </div>
            <div className="rounded-card border border-sand-200 bg-white p-4">
              <dt className="text-sm text-ink-soft">{t('outbox.pending')}</dt>
              <dd className="mt-1 text-2xl tabular-nums">{backlog?.pendingCount ?? 0}</dd>
            </div>
            <div className="rounded-card border border-sand-200 bg-white p-4">
              <dt className="text-sm text-ink-soft">{t('outbox.oldestPendingHours')}</dt>
              <dd className="mt-1 text-2xl tabular-nums">
                {backlog ? Math.floor(backlog.ageSeconds / 3600) : 0}
              </dd>
            </div>
          </dl>
          {/* The reading, not just the numbers. Two identical dead counts mean
              two different incidents depending on the pending count beside them. */}
          <p className="mt-2 text-sm text-ink-soft">
            {(dead?.total ?? 0) === 0
              ? t('outbox.readingHealthy')
              : (backlog?.pendingCount ?? 0) > 0
                ? t('outbox.readingRelayStalled')
                : t('outbox.readingPoison')}
          </p>
        </section>

        <section className="mt-8">
          <h2>{t('outbox.byType')}</h2>
          <AsyncBoundary
            isLoading={false}
            error={null}
            isEmpty={(dead?.byEventType.length ?? 0) === 0}
            emptyHint={t('outbox.noDead')}
          >
            <DataTable
              caption={t('outbox.byType')}
              columns={[
                { key: 'eventType', header: t('outbox.eventType'), cell: (row) => row.eventType, ltr: true },
                { key: 'count', header: t('outbox.count'), cell: (row) => row.count, numeric: true },
                { key: 'familyCount', header: t('outbox.familyCount'), cell: (row) => row.familyCount, numeric: true },
                {
                  key: 'oldest',
                  header: t('outbox.oldestAgeHours'),
                  cell: (row) => Math.floor(row.oldestAgeSeconds / 3600),
                  numeric: true,
                },
                {
                  key: 'actions',
                  header: t('outbox.actions'),
                  cell: (row) => (
                    <Button variant="secondary" onClick={() => setPendingEventType(row.eventType)}>
                      {t('outbox.recover')}
                    </Button>
                  ),
                },
              ]}
              rows={dead?.byEventType ?? []}
              rowKey={(row) => row.eventType}
            />
          </AsyncBoundary>
        </section>

        <section className="mt-8">
          <h2>{t('outbox.messages')}</h2>
          <AsyncBoundary
            isLoading={false}
            error={null}
            isEmpty={(dead?.messages.length ?? 0) === 0}
            emptyHint={t('outbox.noDead')}
          >
            <DataTable
              caption={t('outbox.messages')}
              columns={[
                { key: 'eventType', header: t('outbox.eventType'), cell: (row) => row.eventType, ltr: true },
                {
                  key: 'domainEventId',
                  header: t('outbox.domainEventId'),
                  cell: (row) => row.domainEventId,
                  ltr: true,
                },
                { key: 'attemptCount', header: t('outbox.attempts'), cell: (row) => row.attemptCount, numeric: true },
                {
                  key: 'createdAt',
                  header: t('outbox.createdAt'),
                  cell: (row) => new Date(row.createdAt).toLocaleString(),
                  ltr: true,
                },
                // The real provider message. A summary here would be the
                // difference between "delivery failed" and a cause.
                { key: 'lastError', header: t('outbox.lastError'), cell: (row) => row.lastError ?? '—', ltr: true },
              ]}
              rows={dead?.messages ?? []}
              rowKey={(row) => row.id}
            />
          </AsyncBoundary>
        </section>
      </AsyncBoundary>

      <ConfirmDialog
        open={pendingEventType !== null}
        title={t('outbox.confirmTitle')}
        body={
          <>
            <p dir="ltr" className="font-mono text-xs">
              {pendingEventType}
            </p>
            <p className="mt-2">{t('outbox.confirmBody')}</p>
            <p className="mt-2">{t('outbox.confirmIdempotent')}</p>
          </>
        }
        confirmLabel={t('outbox.recover')}
        isPending={recover.isPending}
        onCancel={() => setPendingEventType(null)}
        onConfirm={() => recover.mutate(pendingEventType ?? undefined)}
      />
    </section>
  );
}
