import { adminGet, adminPost, adminQuery as query } from '../../../shared/lib/adminHttp';

/**
 * ===========================================================================
 * THE TWELVE OPERATOR ROUTES THAT WERE BUILT, GUARDED, AUDITED — AND INVISIBLE.
 * ===========================================================================
 *
 * Every endpoint in this file already existed behind `InternalAdminGuard`
 * before a line of it was written. Nothing here adds a backend capability; it
 * adds the only thing that was missing, which is a caller. Discovery counted
 * twelve such routes, and these are the four surfaces they belong to:
 *
 *   GET  /system/jobs · /system/jobs/runs · /system/jobs/failures
 *   POST /system/jobs/:name/run · /system/jobs/:name/enabled
 *     modules/scheduler/presentation/controllers/scheduler-operations.controller.ts
 *   GET  /system/outbox/dead-letters   POST /system/outbox/dead-letters/recover
 *     modules/events/presentation/controllers/outbox-operations.controller.ts
 *   GET  /system/notifications/deliveries
 *     modules/notifications/presentation/controllers/notification-operations.controller.ts
 *   GET  /ai-core/usage-summary
 *     modules/ai-core/presentation/controllers/ai-platform.controller.ts
 *
 * EVERY TYPE BELOW IS TRANSCRIBED FROM THE BACKEND'S OWN TYPE, not from a
 * screenshot of a response. Where the backend says a field may be `null`, this
 * file says so too — `lastError: string | null` is the difference between «the
 * job has never failed» and «the job failed and we lost the message».
 */

/* ══════════════════════════════ SCHEDULER ══════════════════════════════ */

/** Mirrors `ScheduledJobRow` & `JobSummary` — modules/scheduler/domain/job.types.ts */
export interface JobSummary {
  name: string;
  scope: 'PLATFORM' | 'FAMILY';
  cadenceSeconds: number;
  localHour: number | null;
  enabled: boolean;
  nextRunAt: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastAffectedRows: number | null;
  consecutiveFailures: number;
  lockedBy: string | null;
  lockedAt: string | null;
  /** Arabic one-liner written beside the handler in code. */
  description: string;
  /**
   * FALSE means a `scheduled_jobs` row exists that no code answers to. This is
   * the single most important flag on the screen: such a job can never run, and
   * before this view nothing anywhere said so.
   */
  registered: boolean;
  /** True once consecutive failures cross the backend's alert threshold (3). */
  alerting: boolean;
  /** True while a replica holds the lease. */
  running: boolean;
}

export interface JobsReport {
  jobs: JobSummary[];
  /** Computed by the backend so every consumer agrees what "alerting" means. */
  alerting: number;
  disabled: number;
}

/** Mirrors `JobRunRecord`. `details` is counts and only counts, by design. */
export interface JobRunRecord {
  id: string;
  jobName: string;
  familyId: string | null;
  businessDate: string | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  attempt: number;
  trigger: 'SCHEDULE' | 'MANUAL';
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  affectedRows: number;
  details: Record<string, number> | null;
  error: string | null;
}

export interface FailedJobRow {
  jobName: string;
  failedCount: number;
  familyCount: number;
  oldestAgeSeconds: number;
}

/** Mirrors `JobExecutionReport`. */
export interface JobExecutionReport {
  job: string;
  claimed: boolean;
  executed: number;
  skipped: number;
  failed: number;
  affectedRows: number;
  durationMs: number;
  familiesSeen: number;
  pages: number;
  /** Never a success: the backend records a truncated sweep as FAILED. */
  truncated: boolean;
  lastError?: string;
}

export const jobsApi = {
  list: () => adminGet<JobsReport>('/system/jobs'),

  runs: (params: { jobName?: string; status?: string; limit?: number } = {}) =>
    adminGet<{ runs: JobRunRecord[]; count: number }>(
      `/system/jobs/runs${query({ jobName: params.jobName, status: params.status, limit: params.limit ?? 50 })}`,
    ),

  failures: (windowHours = 24) =>
    adminGet<{ windowHours: number; failures: FailedJobRow[]; total: number }>(
      `/system/jobs/failures${query({ windowHours })}`,
    ),

  /**
   * Bypasses `next_run_at` and NOTHING ELSE. The lease still applies, so
   * pressing this during a run answers `claimed: false` instead of racing it,
   * and the run-row unique key still applies, so pressing it twice answers
   * `skipped` instead of double-applying. Both are the point: one of these jobs
   * deletes rows.
   */
  run: (name: string) => adminPost<JobExecutionReport>(`/system/jobs/${encodeURIComponent(name)}/run`, {}),

  setEnabled: (name: string, enabled: boolean) =>
    adminPost<{ name: string; enabled: boolean }>(`/system/jobs/${encodeURIComponent(name)}/enabled`, { enabled }),
};

/* ═══════════════════════════════ OUTBOX ════════════════════════════════ */

export interface DeadLetterSummaryRow {
  eventType: string;
  count: number;
  oldestAgeSeconds: number;
  familyCount: number;
}

export interface DeadLetterMessage {
  id: string;
  familyId: string;
  domainEventId: string;
  eventType: string;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
}

export interface DeadLetterReport {
  total: number;
  byEventType: DeadLetterSummaryRow[];
  messages: DeadLetterMessage[];
}

/**
 * `backlog` comes back alongside the dead letters on purpose: «12 dead and 0
 * pending» and «12 dead and 4,000 pending» are different incidents, and an
 * operator should not need two calls to tell them apart.
 */
export interface OutboxReport {
  deadLetters: DeadLetterReport;
  backlog: { ageSeconds: number; pendingCount: number; familyCount: number };
}

export const outboxApi = {
  deadLetters: () => adminGet<OutboxReport>('/system/outbox/dead-letters'),

  /**
   * Returns DEAD messages to PENDING. Safe to press twice: the backend's SQL
   * filters on `status = 'DEAD'`, so the second call moves zero rows, and the
   * redelivery itself collides on the domain-event and notification unique
   * keys rather than duplicating.
   */
  recover: (input: { eventType?: string; limit?: number }) =>
    adminPost<{ recovered: number; remaining: number }>('/system/outbox/dead-letters/recover', input),
};

/* ════════════════════════════ NOTIFICATIONS ════════════════════════════ */

/**
 * Mirrors `DeliveryBacklogReport`. COUNTS AND TYPE NAMES ONLY — no title, no
 * body, no child id, no family id. That is the backend's deliberate shape and
 * this client cannot widen it.
 */
export interface DeliveryBacklogReport {
  pending: number;
  dead: number;
  oldestPendingAgeSeconds: number;
  deadByType: { type: string; count: number }[];
}

export const deliveriesApi = {
  backlog: () => adminGet<DeliveryBacklogReport>('/system/notifications/deliveries'),
};

/* ═══════════════════════════════ AI COST ═══════════════════════════════ */

/** Mirrors `IAiUsageSummary`. */
export interface AiUsageSummary {
  windowDays: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byFeature: Record<string, { calls: number; costUsd: number }>;
}

export const aiUsageApi = {
  summary: (windowDays = 30) => adminGet<AiUsageSummary>(`/ai-core/usage-summary${query({ windowDays })}`),
};
