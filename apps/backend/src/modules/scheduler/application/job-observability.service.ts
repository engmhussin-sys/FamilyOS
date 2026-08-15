import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runAsSystemAsync } from '../../../common/tenancy/system-context';
import {
  JOB_FAILURE_ALERT_THRESHOLD,
  SCHEDULER_DEFAULTS,
  type JobRunRecord,
  type JobRunStatus,
  type JobTrigger,
  type ScheduledJobRow,
} from '../domain/job.types';
import {
  SQL_FAILED_RUN_SUMMARY,
  SQL_LIST_JOBS,
  SQL_LIST_RUNS,
  SQL_SET_JOB_ENABLED,
} from '../infrastructure/scheduler.sql';
import { JobRegistry } from './job-registry.service';

/** One row of the "list jobs" view: registry state plus what the code says. */
export interface JobSummary extends ScheduledJobRow {
  /** Arabic one-liner from the code-side definition. */
  readonly description: string;
  /** False when a `scheduled_jobs` row exists that no registered code answers to. */
  readonly registered: boolean;
  /** True once `consecutive_failures` crosses the alert threshold. */
  readonly alerting: boolean;
  /** True while a replica holds the lease. */
  readonly running: boolean;
}

export interface FailedJobSummaryRow {
  readonly jobName: string;
  readonly failedCount: number;
  readonly familyCount: number;
  readonly oldestAgeSeconds: number;
}

/**
 * PHASE C P4 — THE READ SIDE OF THE SCHEDULER.
 *
 * Separated from `JobRunner` on purpose. The runner takes leases and deletes
 * rows; this class does neither and never will, so the operational surface can
 * be reasoned about as read-only apart from the two explicit mutations it
 * exposes (trigger a run, enable/disable a job) which live on the runner and
 * on `setEnabled` respectively.
 *
 * EVERY READ IS CROSS-TENANT AND EVERY ONE SAYS SO. A job's health is a
 * platform condition — the same argument PHASE-C-P0 made for the dead-letter
 * gauge — so these run under `runAsSystem('ADMIN_CONSOLE', ...)` behind
 * `InternalAdminGuard`. The one place a tenant filter IS available
 * (`listRuns({ familyId })`) exists so an operator investigating one
 * household's rollover does not have to read every other household's, which is
 * a smaller blast radius, not a larger one.
 */
@Injectable()
export class JobObservability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
  ) {}

  /** Every registered job with its last outcome and its next scheduled run. */
  async listJobs(): Promise<JobSummary[]> {
    const rows = await this.read<RawJobRow[]>(
      'Admin console lists every scheduled job with its lease and last outcome; scheduled_jobs is platform configuration with no tenant.',
      SQL_LIST_JOBS,
    );

    return rows.map((row) => {
      const definition = this.registry.get(row.name);
      const consecutiveFailures = Number(row.consecutive_failures);
      return {
        name: row.name,
        scope: row.scope === 'FAMILY' ? 'FAMILY' : 'PLATFORM',
        cadenceSeconds: Number(row.cadence_seconds),
        localHour: row.local_hour === null ? null : Number(row.local_hour),
        enabled: row.enabled,
        nextRunAt: new Date(row.next_run_at),
        lastStartedAt: row.last_started_at ? new Date(row.last_started_at) : null,
        lastFinishedAt: row.last_finished_at ? new Date(row.last_finished_at) : null,
        lastStatus: row.last_status,
        lastError: row.last_error,
        lastDurationMs: row.last_duration_ms === null ? null : Number(row.last_duration_ms),
        lastAffectedRows: row.last_affected_rows === null ? null : Number(row.last_affected_rows),
        consecutiveFailures,
        lockedBy: row.locked_by,
        lockedAt: row.locked_at ? new Date(row.locked_at) : null,
        // `registered: false` is the one condition this view exists to surface
        // that nothing else can: a row in the database that no code answers to
        // will never run and will never fail, so it is invisible everywhere
        // else. That is the shape a job deleted-in-code-but-not-in-migration
        // takes.
        description: definition?.description ?? '(غير مسجَّل في الكود — صفٌّ في القاعدة بلا مُنفِّذ)',
        registered: definition !== undefined,
        alerting: consecutiveFailures >= JOB_FAILURE_ALERT_THRESHOLD,
        running: row.locked_by !== null,
      };
    });
  }

  /**
   * Run history, newest first. Every filter is optional and every one narrows
   * — there is no combination of arguments that widens the result beyond "the
   * newest `limit` runs".
   */
  async listRuns(
    filter: { jobName?: string; familyId?: string; status?: JobRunStatus; limit?: number } = {},
  ): Promise<JobRunRecord[]> {
    const rows = await this.read<RawRunRow[]>(
      'Admin console reads job_runs history; a run may belong to any family or to none, which is exactly why it is cross-tenant and behind InternalAdminGuard.',
      SQL_LIST_RUNS,
      filter.jobName ?? null,
      filter.familyId ?? null,
      filter.status ?? null,
      Math.min(filter.limit ?? SCHEDULER_DEFAULTS.historyPageSize, 500),
    );

    return rows.map((row) => ({
      id: row.id,
      jobName: row.job_name,
      familyId: row.family_id,
      // `@db.Date` is read back as a day, never re-projected through a
      // timezone — the same convention `findDistinctCompletionDates` documents.
      businessDate: row.business_date ? new Date(row.business_date).toISOString().slice(0, 10) : null,
      status: row.status as JobRunStatus,
      attempt: Number(row.attempt),
      trigger: row.trigger as JobTrigger,
      workerId: row.worker_id,
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      affectedRows: Number(row.affected_rows),
      details: (row.details as Record<string, number> | null) ?? null,
      error: row.error,
    }));
  }

  /**
   * The failure gauge an alert pages on, over a bounded window.
   *
   * A WINDOW AND NOT "ALL TIME", deliberately: a job that failed once last
   * March is not an incident, and a gauge that can never return to zero is a
   * gauge that gets muted — after which the next real failure is invisible.
   */
  async failures(windowHours = 24): Promise<FailedJobSummaryRow[]> {
    const rows = await this.read<RawFailureRow[]>(
      'Admin console reads the failed-run gauge across every job and tenant; a failing scheduled job is a platform-level condition.',
      SQL_FAILED_RUN_SUMMARY,
      windowHours,
    );
    return rows.map((row) => ({
      jobName: row.job_name,
      failedCount: Number(row.failed_count),
      familyCount: Number(row.family_count),
      oldestAgeSeconds: Number(row.oldest_age_seconds),
    }));
  }

  /**
   * The kill switch. A job that is misbehaving in production must be stoppable
   * without a deploy — otherwise the only available remedy is scaling the
   * whole service to zero, which stops the API too.
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await runAsSystemAsync(
      'ADMIN_CONSOLE',
      'Operator enables or disables a scheduled job; scheduled_jobs is platform configuration with no tenant, behind InternalAdminGuard.',
      async () => {
        await this.prismaRaw().$executeRawUnsafe(SQL_SET_JOB_ENABLED, name, enabled);
      },
    );
  }

  private read<T>(justification: string, sql: string, ...params: unknown[]): Promise<T> {
    return runAsSystemAsync('ADMIN_CONSOLE', justification, async () =>
      this.prismaRaw().$queryRawUnsafe<T>(sql, ...params),
    );
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private prismaRaw(): {
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
    $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T>;
  } {
    return this.prisma as any;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

interface RawJobRow {
  name: string;
  scope: string;
  cadence_seconds: number;
  local_hour: number | null;
  enabled: boolean;
  next_run_at: Date | string;
  last_started_at: Date | string | null;
  last_finished_at: Date | string | null;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  last_affected_rows: number | null;
  consecutive_failures: number;
  locked_by: string | null;
  locked_at: Date | string | null;
}

interface RawRunRow {
  id: string;
  job_name: string;
  family_id: string | null;
  business_date: Date | string | null;
  status: string;
  attempt: number;
  trigger: string;
  worker_id: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  duration_ms: number | null;
  affected_rows: number;
  details: unknown;
  error: string | null;
}

interface RawFailureRow {
  job_name: string;
  failed_count: number;
  family_count: number;
  oldest_age_seconds: number;
}
