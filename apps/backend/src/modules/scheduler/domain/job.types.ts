import type { BusinessDate } from '../../../common/time/family-date';

/**
 * PHASE C P4 (PA-B-031) — the vocabulary of a scheduled job.
 *
 * Everything here is data or a pure type. The engine that acts on it lives in
 * `job-runner.service.ts`; the SQL it acts through lives in `scheduler.sql.ts`.
 * That separation is what makes the determinism requirement testable: the
 * decision "is this family due?" is a pure function of (now, timezone,
 * localHour, last business date) and is proven as such in
 * `test/scheduler/job-schedule.spec.ts` without a database, a clock fake or a
 * network.
 */

/** PLATFORM covers every tenant in one execution; FAMILY fans out to one per household. */
export type JobScope = 'PLATFORM' | 'FAMILY';

/** The three states a run can be in. There is no fourth, and no "unknown". */
export type JobRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/** Why the run happened — an audit question the history must be able to answer. */
export type JobTrigger = 'SCHEDULE' | 'MANUAL';

/**
 * What a job body returns. `affectedRows` is the headline number an operator
 * scans; `details` is the per-target breakdown.
 *
 * `details` IS COUNTS AND ONLY COUNTS. `{ notifications: 412, child_messages: 9 }`
 * is the contract. A retention job that logs WHAT it deleted has copied the
 * data it was asked to destroy into a table with a longer retention period than
 * the one it just enforced — which is the exact failure this whole step exists
 * to prevent, committed by the code meant to prevent it.
 */
export interface JobOutcome {
  readonly affectedRows: number;
  readonly details: Readonly<Record<string, number>>;
}

export const EMPTY_OUTCOME: JobOutcome = { affectedRows: 0, details: {} };

/** The context a job body receives. Deliberately tiny and fully explicit. */
export interface PlatformJobContext {
  readonly scope: 'PLATFORM';
  /** Server clock, passed in rather than read inside, so a test can fix it. */
  readonly now: Date;
}

export interface FamilyJobContext {
  readonly scope: 'FAMILY';
  readonly familyId: string;
  /** The family's IANA zone, already resolved. */
  readonly timeZone: string;
  /** The business date this run CLOSES — always the day that has just ended. */
  readonly businessDate: BusinessDate;
  readonly now: Date;
}

export type JobContext = PlatformJobContext | FamilyJobContext;

/**
 * A registered job. `handler` is the only executable member; everything else is
 * description, and the description is what the operational surface renders.
 */
export interface PlatformJobDefinition {
  readonly name: string;
  readonly scope: 'PLATFORM';
  /** Arabic-facing one-liner for the admin surface. */
  readonly description: string;
  readonly handler: (ctx: PlatformJobContext) => Promise<JobOutcome>;
}

export interface FamilyJobDefinition {
  readonly name: string;
  readonly scope: 'FAMILY';
  readonly description: string;
  readonly handler: (ctx: FamilyJobContext) => Promise<JobOutcome>;
}

export type JobDefinition = PlatformJobDefinition | FamilyJobDefinition;

/** The registry row as the scheduler reads it. */
export interface ScheduledJobRow {
  readonly name: string;
  readonly scope: JobScope;
  readonly cadenceSeconds: number;
  readonly localHour: number | null;
  readonly enabled: boolean;
  readonly nextRunAt: Date;
  readonly lastStartedAt: Date | null;
  readonly lastFinishedAt: Date | null;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
  readonly lastDurationMs: number | null;
  readonly lastAffectedRows: number | null;
  readonly consecutiveFailures: number;
  readonly lockedBy: string | null;
  readonly lockedAt: Date | null;
}

/** A history row as the operational surface renders it. */
export interface JobRunRecord {
  readonly id: string;
  readonly jobName: string;
  readonly familyId: string | null;
  readonly businessDate: string | null;
  readonly status: JobRunStatus;
  readonly attempt: number;
  readonly trigger: JobTrigger;
  readonly workerId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly affectedRows: number;
  readonly details: Readonly<Record<string, number>> | null;
  readonly error: string | null;
}

export const SCHEDULER_DEFAULTS = {
  /**
   * How often the poller wakes. NOT a job's cadence — this is only the
   * resolution at which `next_run_at <= now()` is noticed. 30s means a job due
   * at 02:00:00 starts by 02:00:30 in the worst case, which is well inside the
   * tolerance of everything registered.
   */
  tickIntervalMs: 30_000,
  /**
   * A lease older than this belongs to a dead worker and may be stolen. Chosen
   * to be comfortably longer than the slowest job (the retention sweep over a
   * large database) and comfortably shorter than the shortest cadence (300s
   * for the dead-letter alert), so a crashed replica cannot wedge a job for a
   * whole cadence and a slow-but-alive replica cannot have its work stolen
   * underneath it.
   */
  leaseSeconds: 600,
  /**
   * A FAMILY sweep processes at most this many households per tick. Bounded on
   * purpose: an unbounded fan-out over 60,000 families inside one tick would
   * hold the lease past its own expiry and be stolen mid-flight. The remainder
   * is picked up by the next tick, and the `job_runs` unique key makes that
   * resumption free — an already-rolled-over family is skipped by the
   * database, not by a cursor the scheduler would have to persist.
   */
  familyBatchSize: 200,
  /**
   * Retry-with-backoff. `nextRunAt = now + min(cadence, base * 2^failures)`,
   * capped. A job that fails does not spin, and a job that has failed many
   * times does not stop being retried — it just stops being retried often.
   */
  retryBaseSeconds: 60,
  retryMaxSeconds: 3_600,
  /** The default family-local hour a business day is closed at. */
  defaultRolloverLocalHour: 2,
  /** How many history rows the operational surface returns by default. */
  historyPageSize: 50,
} as const;

/**
 * The FAILURE THRESHOLD an alert pages on. Three consecutive failures is a
 * broken job rather than a transient one; below that the backoff is doing its
 * job and paging a human would be noise.
 */
export const JOB_FAILURE_ALERT_THRESHOLD = 3;
