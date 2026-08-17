import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { resolveTimeZone } from '../../../common/time/family-date';
import { runAsSystemAsync } from '../../../common/tenancy/system-context';
import { runWithTenant } from '../../../common/tenancy/tenant-context';
import { closableBusinessDate, nextRunAfterFailure, nextRunAfterSuccess } from '../domain/job-schedule';
import {
  JOB_FAILURE_ALERT_THRESHOLD,
  SCHEDULER_DEFAULTS,
  type JobDefinition,
  type JobOutcome,
  type JobTrigger,
} from '../domain/job.types';
import {
  SQL_CLAIM_JOB,
  SQL_CLAIM_RUN,
  SQL_FINISH_JOB_FAILURE,
  SQL_FINISH_JOB_SUCCESS,
  SQL_FINISH_RUN_FAILURE,
  SQL_FINISH_RUN_SUCCESS,
  SQL_LIST_ACTIVE_FAMILIES_PAGE,
  SQL_TRY_JOB_LOCK,
} from '../infrastructure/scheduler.sql';
import { JobRegistry } from './job-registry.service';

/** What one `runJob()` call did, returned so tests assert on numbers not logs. */
export interface JobExecutionReport {
  readonly job: string;
  /** False when the lease was held by another replica or the job was not due. */
  readonly claimed: boolean;
  /** How many run rows were executed (1 for PLATFORM, 0..N for FAMILY). */
  readonly executed: number;
  /** How many were skipped because the database said they had already succeeded. */
  readonly skipped: number;
  readonly failed: number;
  readonly affectedRows: number;
  readonly durationMs: number;
  /**
   * How many families this sweep ENUMERATED (0 for PLATFORM). `executed +
   * skipped + failed` for a FAMILY job, and the number a future silent
   * truncation would make smaller than the household count.
   */
  readonly familiesSeen: number;
  /** How many pages the keyset cursor walked. 0 for PLATFORM, >= 1 otherwise. */
  readonly pages: number;
  /**
   * TRUE means the sweep stopped before the table was exhausted, i.e. it hit
   * `maxFamilyPagesPerRun`. It is never a success: `runJob` turns it into a
   * FAILED registry row with a stated reason, because a partial fan-out that
   * reports green is the defect this field exists to make impossible.
   */
  readonly truncated: boolean;
  /**
   * The first error text from an executed run, propagated so
   * `scheduled_jobs.last_error` carries the REAL message rather than a summary.
   * «1 family run(s) failed» tells an operator nothing they could act on;
   * «TypeError: Cannot read properties of null» tells them everything.
   */
  readonly lastError?: string;
}

const EMPTY_REPORT = (job: string): JobExecutionReport => ({
  job,
  claimed: false,
  executed: 0,
  skipped: 0,
  failed: 0,
  affectedRows: 0,
  durationMs: 0,
  familiesSeen: 0,
  pages: 0,
  truncated: false,
});

/**
 * PHASE C P4 — THE ENGINE. Claim, execute, record, release.
 *
 * The five properties the brief requires, and WHERE each one actually lives,
 * because "the service is idempotent" is not a claim anybody can check:
 *
 *   DETERMINISTIC   `now` is a parameter of `runJob`, never read inside a job
 *                   body. Same instant + same rows => same outcome.
 *   IDEMPOTENT      `job_runs (job_name, family_id, business_date)` UNIQUE,
 *                   claimed by `SQL_CLAIM_RUN`'s `ON CONFLICT ... WHERE
 *                   status <> 'SUCCEEDED'`. Every job body is ALSO
 *                   independently idempotent; see each one's docstring.
 *   NO DUPLICATE    `pg_try_advisory_xact_lock` serialises the claim;
 *   ACROSS REPLICAS the conditional UPDATE on `scheduled_jobs.locked_at` is
 *                   the lease that protects the execution. `SQL_CLAIM_JOB`
 *                   explains which of the two carries the guarantee.
 *   RETRY+BACKOFF   `nextRunAfterFailure` doubles from 60s to a 1h cap;
 *                   `consecutive_failures` and `last_error` are the visible
 *                   state, and `JOB_FAILURE_ALERT_THRESHOLD` is what an alert
 *                   reads.
 *   OBSERVABLE      `job_runs` — started/finished/failed, duration,
 *                   affected rows, per-target counts. A table, not a log line.
 *   TIMEZONE        `closableBusinessDate(now, family.timezone, localHour)`.
 *                   Never UTC, never the container's clock.
 */
@Injectable()
export class JobRunner {
  private readonly logger = new Logger(JobRunner.name);
  /** Same shape as `OutboxRelay.workerId`, so both leases read alike in the DB. */
  readonly workerId = `sched-${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: JobRegistry,
  ) {}

  /**
   * Run one named job, if this replica can claim it.
   *
   * `trigger` is `MANUAL` when an operator pressed the button, and that is the
   * ONLY thing that sets `ignoreSchedule` — a manual run bypasses `next_run_at`
   * (that is what the button is for) but NOT the lease and NOT the once-per-day
   * uniqueness. An operator who presses «Run now» twice gets one run, and an
   * operator who presses it while another replica is mid-run gets told the job
   * is busy rather than racing it.
   */
  async runJob(
    name: string,
    options: { now?: Date; trigger?: JobTrigger } = {},
  ): Promise<JobExecutionReport> {
    const definition = this.registry.get(name);
    if (!definition) throw new UnknownJobError(name);

    const now = options.now ?? new Date();
    const trigger: JobTrigger = options.trigger ?? 'SCHEDULE';
    const startedAt = Date.now();

    const claim = await this.claim(name, trigger === 'MANUAL');
    if (!claim) return EMPTY_REPORT(name);

    let report: JobExecutionReport;
    let failure: Error | null = null;
    try {
      report =
        definition.scope === 'PLATFORM'
          ? await this.executePlatform(definition, now, trigger)
          : await this.executeFamilies(definition, now, trigger, claim.localHour);
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      report = { ...EMPTY_REPORT(name), claimed: true, failed: 1 };
    }

    const durationMs = Date.now() - startedAt;
    // A FAMILY sweep in which some families failed is itself a FAILURE. Anything
    // else would let a job whose every fan-out run threw report green forever.
    //
    // A TRUNCATED sweep is a failure for the same reason and one more: it did
    // not do the work it was asked to do, and the ONLY thing distinguishing it
    // from a healthy run is this flag. Reporting it green is precisely the
    // silent-truncation bug in a new place.
    const jobFailed = failure !== null || report.failed > 0 || report.truncated;
    const reasons: string[] = [];
    if (failure) reasons.push(failure.message);
    if (report.truncated) {
      reasons.push(
        `family sweep TRUNCATED after ${report.pages} page(s) / ${report.familiesSeen} families — maxFamilyPagesPerRun reached, some households were NOT processed`,
      );
    }
    if (report.failed > 0) {
      reasons.push(`${report.failed} run(s) failed — first: ${report.lastError ?? 'unknown'}`);
    }
    await this.release(name, {
      failed: jobFailed,
      error: reasons.length > 0 ? reasons.join(' · ') : null,
      durationMs,
      affectedRows: report.affectedRows,
      cadenceSeconds: claim.cadenceSeconds,
      consecutiveFailures: claim.consecutiveFailures,
      now,
    });

    return { ...report, claimed: true, durationMs };
  }

  /** The registered job names, for the start-up log line and the ops surface. */
  jobNames(): readonly string[] {
    return this.registry.names();
  }

  /** Every job that the registry knows about and the registry row says is due. */
  async runDueJobs(now: Date = new Date()): Promise<JobExecutionReport[]> {
    const reports: JobExecutionReport[] = [];
    for (const name of this.registry.names()) {
      reports.push(await this.runJob(name, { now }));
    }
    return reports;
  }

  // -- the lease ------------------------------------------------------------

  /**
   * THE CLAIM. Advisory lock and conditional UPDATE, in ONE transaction so the
   * advisory lock covers the UPDATE and is released by the COMMIT — there is no
   * unlock call to forget and no way for a crash to leak the lock.
   */
  private async claim(
    name: string,
    ignoreSchedule: boolean,
  ): Promise<{ cadenceSeconds: number; localHour: number | null; consecutiveFailures: number } | null> {
    return runAsSystemAsync(
      'SCHEDULED_JOB',
      'Scheduler claims a lease on a scheduled_jobs row; the registry is platform configuration with no tenant, and the claim must be visible to every replica.',
      async () => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const prisma = this.prisma as any;
        return prisma.$transaction(async (tx: TransactionLike) => {
          const locked = await tx.$queryRawUnsafe<Array<{ acquired: boolean }>>(
            SQL_TRY_JOB_LOCK,
            name,
          );
          if (!locked[0]?.acquired) return null;

          const rows = await tx.$queryRawUnsafe<
            Array<{ cadence_seconds: number; local_hour: number | null; consecutive_failures: number }>
          >(SQL_CLAIM_JOB, this.workerId, SCHEDULER_DEFAULTS.leaseSeconds, name, ignoreSchedule);

          const row = rows[0];
          if (!row) return null;
          return {
            cadenceSeconds: Number(row.cadence_seconds),
            localHour: row.local_hour === null ? null : Number(row.local_hour),
            consecutiveFailures: Number(row.consecutive_failures),
          };
        });
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },
    );
  }

  private async release(
    name: string,
    result: {
      failed: boolean;
      error: string | null;
      durationMs: number;
      affectedRows: number;
      cadenceSeconds: number;
      consecutiveFailures: number;
      now: Date;
    },
  ): Promise<void> {
    await runAsSystemAsync(
      'SCHEDULED_JOB',
      'Scheduler releases a scheduled_jobs lease and records the run outcome; the registry is platform configuration with no tenant.',
      async () => {
        if (result.failed) {
          const failures = result.consecutiveFailures + 1;
          const nextRunAt = nextRunAfterFailure(result.now, failures);
          await this.prismaRaw().$executeRawUnsafe(
            SQL_FINISH_JOB_FAILURE,
            name,
            result.error ?? 'unknown failure',
            result.durationMs,
            nextRunAt,
          );
          const level = failures >= JOB_FAILURE_ALERT_THRESHOLD ? 'error' : 'warn';
          this.logger[level](
            `scheduler.job_failed job=${name} consecutiveFailures=${failures} nextRunAt=${nextRunAt.toISOString()} error="${(result.error ?? '').slice(0, 200)}"`,
          );
        } else {
          await this.prismaRaw().$executeRawUnsafe(
            SQL_FINISH_JOB_SUCCESS,
            name,
            result.durationMs,
            result.affectedRows,
            nextRunAfterSuccess(result.now, result.cadenceSeconds),
          );
        }
      },
    );
  }

  // -- execution ------------------------------------------------------------

  /** One run row, no family, no business date. */
  private async executePlatform(
    definition: JobDefinition,
    now: Date,
    trigger: JobTrigger,
  ): Promise<JobExecutionReport> {
    if (definition.scope !== 'PLATFORM') throw new Error('executePlatform called with a FAMILY job');

    const run = await this.claimRun(definition.name, null, null, trigger);
    if (!run) return { ...EMPTY_REPORT(definition.name), skipped: 1 };

    const runStartedAt = Date.now();
    try {
      const outcome = await definition.handler({ scope: 'PLATFORM', now });
      await this.finishRunSuccess(run.id, outcome, Date.now() - runStartedAt);
      return {
        ...EMPTY_REPORT(definition.name),
        executed: 1,
        affectedRows: outcome.affectedRows,
      };
    } catch (err) {
      await this.finishRunFailure(run.id, err, Date.now() - runStartedAt);
      return { ...EMPTY_REPORT(definition.name), failed: 1, lastError: errorText(err) };
    }
  }

  /**
   * THE FAN-OUT — and the place the timezone requirement is actually satisfied.
   *
   * For each family: resolve ITS zone, ask `closableBusinessDate` which day it
   * has finished, and try to claim a run for that (family, day). Two families
   * in two zones therefore claim DIFFERENT business dates at the same instant,
   * which is the same statement as "they roll over at different instants" seen
   * from the other side.
   *
   * EVERY FAMILY, PAGED — the fix for the defect this method used to carry.
   * It issued ONE `LIMIT 200 OFFSET 0` enumeration and stopped, so household
   * 201 and beyond were never reached, in an order determined by uuid, with no
   * error and no log and no metric. The next tick did not "pick up the
   * remainder": it re-read the same first 200, found them done, and skipped
   * them. This now walks a KEYSET cursor (`WHERE id > $lastId ORDER BY id`)
   * until the table is exhausted. See `SQL_LIST_ACTIVE_FAMILIES_PAGE` for why
   * keyset and not OFFSET.
   *
   * MEMORY IS BOUNDED to one page — `familyBatchSize` rows — however many
   * households exist. Nothing accumulates across pages except six integers.
   *
   * RESUMABLE, AND THE CURSOR DOES NOT FIGHT THE CLAIM. The cursor decides
   * WHICH families this pass looks at; `job_runs (job_name, family_id,
   * business_date)` decides which of them still need work. So a sweep that dies
   * half-way and re-runs restarts the cursor at the beginning, re-enumerates
   * the families it already finished, and every one of them is refused by
   * `SQL_CLAIM_RUN`'s unique key — counted as `skipped`, one round trip each,
   * no second execution of any job body. There is no cursor to persist because
   * the database already knows who is done; the cursor is per-pass state only,
   * and it is what guarantees the pass REACHES everyone rather than what
   * guarantees each of them runs once.
   *
   * ONE FAMILY'S FAILURE DOES NOT STOP THE SWEEP. It is recorded on that
   * family's run row and counted; the loop continues to the next family and the
   * next page. The alternative — abort the sweep — would let one household with
   * corrupt data stop every other household's rollover indefinitely, which is
   * the worst possible coupling between tenants.
   */
  private async executeFamilies(
    definition: JobDefinition,
    now: Date,
    trigger: JobTrigger,
    localHour: number | null,
  ): Promise<JobExecutionReport> {
    if (definition.scope !== 'FAMILY') throw new Error('executeFamilies called with a PLATFORM job');
    const hour = localHour ?? SCHEDULER_DEFAULTS.defaultRolloverLocalHour;
    const pageSize = SCHEDULER_DEFAULTS.familyBatchSize;

    let executed = 0;
    let skipped = 0;
    let failed = 0;
    let affectedRows = 0;
    let familiesSeen = 0;
    let pages = 0;
    let truncated = false;
    let lastError: string | undefined;

    /** The keyset cursor — the id of the last family of the previous page. */
    let lastId: string | null = null;

    for (;;) {
      const page: Array<{ id: string; timezone: string }> = await runAsSystemAsync(
        'SCHEDULED_JOB',
        'Scheduler enumerates one page of the families a family-scoped job must fan out to; each family is then executed inside its own runWithTenant scope.',
        async () =>
          this.prismaRaw().$queryRawUnsafe<Array<{ id: string; timezone: string }>>(
            SQL_LIST_ACTIVE_FAMILIES_PAGE,
            pageSize,
            lastId,
          ),
      );
      if (page.length === 0) break;
      pages += 1;

      for (const family of page) {
        familiesSeen += 1;
        const timeZone = resolveTimeZone(family.timezone);
        const businessDate = closableBusinessDate(now, timeZone, hour);

        const run = await this.claimRun(definition.name, family.id, businessDate, trigger);
        if (!run) {
          skipped += 1;
          continue;
        }

        const runStartedAt = Date.now();
        try {
          // THE TENANT RE-ENTRY. Everything the job body does happens inside
          // this, exactly as in `OutboxRelay.dispatch`. It is entered and left
          // ONCE PER FAMILY, inside the page loop rather than around it, so a
          // page cannot carry one household's context into the next
          // household's handler.
          const outcome = await runWithTenant(
            {
              familyId: family.id,
              actorType: 'SYSTEM',
              actorId: `scheduler:${definition.name}`,
            },
            () => definition.handler({ scope: 'FAMILY', familyId: family.id, timeZone, businessDate, now }),
          );
          await this.finishRunSuccess(run.id, outcome, Date.now() - runStartedAt);
          executed += 1;
          affectedRows += outcome.affectedRows;
        } catch (err) {
          await this.finishRunFailure(run.id, err, Date.now() - runStartedAt);
          failed += 1;
          lastError ??= errorText(err);
        }
      }

      // A SHORT PAGE IS THE END OF THE TABLE. Seeking again would cost a round
      // trip to learn the same thing.
      if (page.length < pageSize) break;
      lastId = page[page.length - 1].id;

      if (pages >= SCHEDULER_DEFAULTS.maxFamilyPagesPerRun) {
        truncated = true;
        break;
      }
    }

    // THE LINE THAT MAKES A FUTURE TRUNCATION VISIBLE. It states what was
    // actually enumerated rather than what was intended, so «pages=1
    // families=200» against a 560-household database reads as the bug it would
    // be. Counts only — no family id, nothing a log aggregator turns into a
    // profile.
    const summary =
      `scheduler.family_sweep job=${definition.name} pages=${pages} families=${familiesSeen} ` +
      `executed=${executed} skipped=${skipped} failed=${failed} truncated=${truncated}`;
    if (truncated) {
      this.logger.error(
        `${summary} — STOPPED AT maxFamilyPagesPerRun=${SCHEDULER_DEFAULTS.maxFamilyPagesPerRun}; households past the cursor were NOT processed`,
      );
    } else {
      this.logger.log(summary);
    }

    return {
      ...EMPTY_REPORT(definition.name),
      executed,
      skipped,
      failed,
      affectedRows,
      familiesSeen,
      pages,
      truncated,
      lastError,
    };
  }

  // -- run rows -------------------------------------------------------------

  /**
   * `null` means «the database says this has already succeeded» — the
   * idempotency guarantee, expressed as the absence of a returned row rather
   * than as a boolean somebody could forget to check.
   *
   * Runs under SystemContext because the INSERT may carry a NULL family (a
   * platform run), which the tenant extension would otherwise stamp with a
   * tenant that does not apply. The FAMILY id is passed explicitly and comes
   * from the server-side enumeration, never from a client.
   */
  private async claimRun(
    jobName: string,
    familyId: string | null,
    businessDate: string | null,
    trigger: JobTrigger,
  ): Promise<{ id: string; attempt: number } | null> {
    const rows = await runAsSystemAsync(
      'SCHEDULED_JOB',
      'Scheduler claims a job_runs row; family_id is NULL for platform-wide runs and server-derived for family runs, and the once-per-business-day unique key is what makes the claim idempotent.',
      async () =>
        this.prismaRaw().$queryRawUnsafe<Array<{ id: string; family_id: string | null; attempt: number }>>(
          SQL_CLAIM_RUN,
          jobName,
          familyId,
          businessDate,
          this.workerId,
          trigger,
          SCHEDULER_DEFAULTS.leaseSeconds,
        ),
    );
    const row = rows[0];
    return row ? { id: row.id, attempt: Number(row.attempt) } : null;
  }

  private async finishRunSuccess(runId: string, outcome: JobOutcome, durationMs: number): Promise<void> {
    await runAsSystemAsync(
      'SCHEDULED_JOB',
      'Scheduler records a successful job_runs row with its affected-row counts; the row may belong to a family the scheduler is not scoped to.',
      async () => {
        await this.prismaRaw().$executeRawUnsafe(
          SQL_FINISH_RUN_SUCCESS,
          runId,
          durationMs,
          outcome.affectedRows,
          JSON.stringify(outcome.details),
        );
      },
    );
  }

  private async finishRunFailure(runId: string, err: unknown, durationMs: number): Promise<void> {
    const message = errorText(err);
    await runAsSystemAsync(
      'SCHEDULED_JOB',
      'Scheduler records a failed job_runs row; the row may belong to a family the scheduler is not scoped to.',
      async () => {
        await this.prismaRaw().$executeRawUnsafe(SQL_FINISH_RUN_FAILURE, runId, durationMs, message);
      },
    );
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  /** Same structural cast, same reason, as `OutboxRelay.prismaRaw()`. */
  private prismaRaw(): {
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
    $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T>;
  } {
    return this.prisma as any;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** One rendering of an error, used by both the run row and the registry row. */
function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * The one method of the interactive-transaction client this file needs. Declared
 * structurally for the same reason `OutboxRelay` declares `DomainEventRow`
 * structurally: this code must work against both the extended production client
 * and the WASM-engine client the tenancy proof suites build, and naming a
 * generated type would bind it to one of them.
 */
interface TransactionLike {
  $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T>;
}

/** A named error so the controller can answer 404 rather than 500. */
export class UnknownJobError extends Error {
  constructor(name: string) {
    super(`Unknown scheduled job: ${name}`);
    this.name = 'UnknownJobError';
  }
}
