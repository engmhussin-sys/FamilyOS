import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useTranslation } from '../../../shared/i18n/LocaleProvider';
import { AsyncBoundary } from '../../../shared/components/AsyncState';
import { DataTable, type DataTableColumn } from '../../../shared/components/DataTable';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';
import { Button } from '../../../shared/components/Button';
import { jobsApi, type JobSummary, type JobRunRecord } from '../api/platformRuntimeApi';

/**
 * ===========================================================================
 * THE SCHEDULER, VISIBLE AT LAST.
 * ===========================================================================
 *
 * Five operator routes have existed behind `InternalAdminGuard` since Phase C,
 * fully audited, and nothing has ever called them. «Did the retention sweep run
 * last night» was answerable only by reading a container's logs, and this
 * project's own history records that the honest answer, for a while, was «no,
 * and it never has».
 *
 * ── THE THREE FACTS THIS SCREEN EXISTS TO SHOW ─────────────────────────
 *
 *   `registered: false` — a `scheduled_jobs` row that NO CODE ANSWERS TO. Such
 *   a job can never run and will never fail; it is simply absent, forever, and
 *   nothing else in this system says so. It is rendered as an alert rather than
 *   a column value for exactly that reason.
 *
 *   `alerting` — three consecutive failures. The backend computes the
 *   threshold; this page does not re-derive it, because two definitions of
 *   "broken" is one definition too many.
 *
 *   `lastError` — the REAL message, not a summary. «1 family run(s) failed»
 *   tells an operator nothing they can act on.
 *
 * ── WHY THERE IS NO "REASON" FIELD ON THESE TWO ACTIONS ────────────────
 *
 * `POST /system/jobs/:name/run` and `/enabled` accept no reason, and the audit
 * rows they write (`scheduler.job.manual_run`, `scheduler.job.enabled_changed`)
 * carry the outcome rather than a justification. A reason box here would
 * collect a sentence and drop it on the floor, which is worse than not asking:
 * it would read, in a review, as though the reason had been recorded.
 *
 * ── WHY THE RESULT IS SHOWN VERBATIM ───────────────────────────────────
 *
 * A manual run returns `claimed`, `executed`, `skipped`, `failed`,
 * `affectedRows`. `claimed: false` means another replica held the lease and
 * NOTHING HAPPENED; `skipped` means the database said the work was already
 * done. Rendering either as "success" would be a lie about whether the sweep
 * an operator just forced actually swept.
 */
export function JobsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [pendingRun, setPendingRun] = useState<JobSummary | null>(null);
  const [pendingToggle, setPendingToggle] = useState<JobSummary | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const jobs = useQuery({ queryKey: ['platform-jobs'], queryFn: jobsApi.list });
  const runs = useQuery({ queryKey: ['platform-job-runs'], queryFn: () => jobsApi.runs({ limit: 50 }) });
  const failures = useQuery({ queryKey: ['platform-job-failures'], queryFn: () => jobsApi.failures(24) });

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ['platform-jobs'] });
    queryClient.invalidateQueries({ queryKey: ['platform-job-runs'] });
    queryClient.invalidateQueries({ queryKey: ['platform-job-failures'] });
  };

  const run = useMutation({
    mutationFn: (name: string) => jobsApi.run(name),
    onSuccess: (report) => {
      setPendingRun(null);
      // Every branch of the report is spelled out, because three of them mean
      // "nothing happened" and only one means "the sweep ran".
      setOutcome(
        !report.claimed
          ? t('jobs.resultNotClaimed')
          : report.truncated
            ? t('jobs.resultTruncated')
            : report.failed > 0
              ? `${t('jobs.resultFailed')} — ${report.lastError ?? ''}`
              : t('jobs.resultRan', {
                  executed: String(report.executed),
                  skipped: String(report.skipped),
                  rows: String(report.affectedRows),
                }),
      );
      refreshAll();
    },
    onError: (error: Error) => {
      setPendingRun(null);
      setOutcome(error.message);
    },
  });

  const toggle = useMutation({
    mutationFn: (job: JobSummary) => jobsApi.setEnabled(job.name, !job.enabled),
    onSuccess: (result) => {
      setPendingToggle(null);
      setOutcome(result.enabled ? t('jobs.resultEnabled') : t('jobs.resultDisabled'));
      refreshAll();
    },
    onError: (error: Error) => {
      setPendingToggle(null);
      setOutcome(error.message);
    },
  });

  const jobColumns: DataTableColumn<JobSummary>[] = [
    { key: 'name', header: t('jobs.name'), cell: (job) => job.name, ltr: true },
    { key: 'description', header: t('jobs.description'), cell: (job) => job.description },
    { key: 'scope', header: t('jobs.scope'), cell: (job) => job.scope, ltr: true },
    {
      key: 'state',
      header: t('jobs.state'),
      cell: (job) => (
        <>
          {/* `registered: false` outranks every other state on the row: a job
              with no handler cannot run, so "enabled" about it is meaningless. */}
          {!job.registered ? <span role="alert">{t('jobs.notRegistered')}</span> : null}
          {!job.enabled ? <span>{t('jobs.disabled')}</span> : null}
          {job.alerting ? <span role="alert">{t('jobs.alerting')}</span> : null}
          {job.running ? <span>{t('jobs.running')}</span> : null}
          {job.registered && job.enabled && !job.alerting && !job.running ? t('jobs.ok') : null}
        </>
      ),
    },
    {
      key: 'lastRun',
      header: t('jobs.lastRun'),
      cell: (job) =>
        // `null` is rendered as "never ran", never as a blank cell: a blank
        // reads as a formatting problem, and "never ran" is the finding.
        job.lastFinishedAt ? new Date(job.lastFinishedAt).toLocaleString() : t('jobs.never'),
      ltr: true,
    },
    { key: 'lastStatus', header: t('jobs.lastStatus'), cell: (job) => job.lastStatus ?? '—', ltr: true },
    { key: 'nextRun', header: t('jobs.nextRun'), cell: (job) => new Date(job.nextRunAt).toLocaleString(), ltr: true },
    { key: 'failures', header: t('jobs.consecutiveFailures'), cell: (job) => job.consecutiveFailures, numeric: true },
    {
      key: 'lastError',
      header: t('jobs.lastError'),
      cell: (job) => job.lastError ?? '—',
      ltr: true,
    },
    {
      key: 'actions',
      header: t('jobs.actions'),
      cell: (job) => (
        <span className="flex gap-2">
          <Button variant="secondary" onClick={() => setPendingRun(job)} disabled={!job.registered}>
            {t('jobs.runNow')}
          </Button>
          <Button variant="ghost" onClick={() => setPendingToggle(job)}>
            {job.enabled ? t('jobs.disable') : t('jobs.enable')}
          </Button>
        </span>
      ),
    },
  ];

  const runColumns: DataTableColumn<JobRunRecord>[] = [
    { key: 'jobName', header: t('jobs.name'), cell: (r) => r.jobName, ltr: true },
    { key: 'status', header: t('jobs.status'), cell: (r) => r.status, ltr: true },
    { key: 'trigger', header: t('jobs.trigger'), cell: (r) => r.trigger, ltr: true },
    { key: 'startedAt', header: t('jobs.startedAt'), cell: (r) => new Date(r.startedAt).toLocaleString(), ltr: true },
    { key: 'durationMs', header: t('jobs.duration'), cell: (r) => r.durationMs ?? '—', numeric: true },
    { key: 'affectedRows', header: t('jobs.affectedRows'), cell: (r) => r.affectedRows, numeric: true },
    {
      key: 'details',
      // Counts and only counts — the backend refuses to record WHAT it deleted,
      // because a retention job that logs its victims has copied the data it
      // was asked to destroy into a table with a longer retention.
      header: t('jobs.details'),
      cell: (r) =>
        r.details
          ? Object.entries(r.details)
              .map(([key, value]) => `${key}: ${value}`)
              .join(' · ')
          : '—',
      ltr: true,
    },
    { key: 'error', header: t('jobs.error'), cell: (r) => r.error ?? '—', ltr: true },
  ];

  return (
    <section>
      <header>
        <h1>{t('jobs.title')}</h1>
        <p>{t('jobs.intro')}</p>
      </header>

      {outcome ? (
        <p role="status" className="mt-4 rounded-card border border-sand-200 bg-white p-3 text-sm">
          {outcome}
        </p>
      ) : null}

      <section className="mt-6">
        <h2>{t('jobs.registry')}</h2>
        <AsyncBoundary
          isLoading={jobs.isLoading}
          error={jobs.isError ? (jobs.error as Error) : null}
          isEmpty={!jobs.isLoading && !jobs.isError && (jobs.data?.jobs.length ?? 0) === 0}
          emptyHint={t('jobs.noJobs')}
          onRetry={() => jobs.refetch()}
        >
          <p className="mb-3 text-sm text-ink-soft">
            {t('jobs.summary', {
              total: String(jobs.data?.jobs.length ?? 0),
              alerting: String(jobs.data?.alerting ?? 0),
              disabled: String(jobs.data?.disabled ?? 0),
            })}
          </p>
          <DataTable
            caption={t('jobs.registry')}
            columns={jobColumns}
            rows={jobs.data?.jobs ?? []}
            rowKey={(job) => job.name}
            rowClassName={(job) => (job.alerting || !job.registered ? 'bg-brick-100/40' : undefined)}
          />
        </AsyncBoundary>
      </section>

      <section className="mt-8">
        <h2>{t('jobs.failuresTitle')}</h2>
        <AsyncBoundary
          isLoading={failures.isLoading}
          error={failures.isError ? (failures.error as Error) : null}
          isEmpty={!failures.isLoading && !failures.isError && (failures.data?.failures.length ?? 0) === 0}
          emptyHint={t('jobs.noFailures')}
          onRetry={() => failures.refetch()}
        >
          <DataTable
            caption={t('jobs.failuresTitle')}
            columns={[
              { key: 'jobName', header: t('jobs.name'), cell: (row) => row.jobName, ltr: true },
              { key: 'failedCount', header: t('jobs.failedCount'), cell: (row) => row.failedCount, numeric: true },
              { key: 'familyCount', header: t('jobs.familyCount'), cell: (row) => row.familyCount, numeric: true },
              {
                key: 'oldest',
                header: t('jobs.oldestAgeHours'),
                cell: (row) => Math.floor(row.oldestAgeSeconds / 3600),
                numeric: true,
              },
            ]}
            rows={failures.data?.failures ?? []}
            rowKey={(row) => row.jobName}
          />
        </AsyncBoundary>
      </section>

      <section className="mt-8">
        <h2>{t('jobs.historyTitle')}</h2>
        <AsyncBoundary
          isLoading={runs.isLoading}
          error={runs.isError ? (runs.error as Error) : null}
          isEmpty={!runs.isLoading && !runs.isError && (runs.data?.runs.length ?? 0) === 0}
          emptyHint={t('jobs.noRuns')}
          onRetry={() => runs.refetch()}
        >
          <DataTable
            caption={t('jobs.historyTitle')}
            columns={runColumns}
            rows={runs.data?.runs ?? []}
            rowKey={(r) => r.id}
            rowClassName={(r) => (r.status === 'FAILED' ? 'bg-brick-100/40' : undefined)}
          />
        </AsyncBoundary>
      </section>

      <ConfirmDialog
        open={pendingRun !== null}
        title={t('jobs.confirmRunTitle')}
        // The blast radius, written out. One of these jobs deletes rows across
        // every household; "are you sure?" would not have said so.
        body={
          <>
            <p dir="ltr" className="font-mono text-xs">
              {pendingRun?.name}
            </p>
            <p className="mt-2">{pendingRun?.description}</p>
            <p className="mt-2">{t('jobs.confirmRunBody')}</p>
          </>
        }
        confirmLabel={t('jobs.runNow')}
        isPending={run.isPending}
        onCancel={() => setPendingRun(null)}
        onConfirm={() => pendingRun && run.mutate(pendingRun.name)}
      />

      <ConfirmDialog
        open={pendingToggle !== null}
        destructive={pendingToggle?.enabled === true}
        title={pendingToggle?.enabled ? t('jobs.confirmDisableTitle') : t('jobs.confirmEnableTitle')}
        body={
          <>
            <p dir="ltr" className="font-mono text-xs">
              {pendingToggle?.name}
            </p>
            <p className="mt-2">
              {pendingToggle?.enabled ? t('jobs.confirmDisableBody') : t('jobs.confirmEnableBody')}
            </p>
          </>
        }
        confirmLabel={pendingToggle?.enabled ? t('jobs.disable') : t('jobs.enable')}
        isPending={toggle.isPending}
        onCancel={() => setPendingToggle(null)}
        onConfirm={() => pendingToggle && toggle.mutate(pendingToggle)}
      />
    </section>
  );
}
