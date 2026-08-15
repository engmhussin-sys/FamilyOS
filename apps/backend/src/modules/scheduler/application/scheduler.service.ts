import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import { SCHEDULER_DEFAULTS } from '../domain/job.types';
import { JobRunner, type JobExecutionReport } from './job-runner.service';

/**
 * PHASE C P4 — THE POLLER, and the whole of the "new infrastructure" question
 * answered in one class.
 *
 * IT IS A `setInterval`. That is not a shortcut, it is the SAME MECHANISM
 * `OutboxRelay` has run on since F3, and reusing it was the explicit
 * instruction («use what exists; do not add new infrastructure if the existing
 * stack suffices»). What makes a `setInterval` sufficient here is everything
 * around it rather than the timer itself: the decision to run is taken by the
 * DATABASE (`scheduled_jobs.next_run_at` plus a lease), not by the timer, so
 * the timer's only job is to ask often enough. Consequences worth stating:
 *
 *   - N replicas may all tick. Exactly one wins each job, every tick.
 *   - A replica may miss ticks, restart, or be replaced. `next_run_at` is in
 *     the database, so nothing is lost — the next replica to ask picks it up.
 *   - Container clock skew moves a job's start by the skew, and no further.
 *     There is no accumulated drift, because the next run is computed from the
 *     server's `now()` at completion, not from the previous scheduled time.
 *
 * WHAT IT IS NOT, said plainly: it is not a distributed scheduler with
 * second-level guarantees, it does not survive a total outage by catching up
 * every missed occurrence (it catches up ONE, deliberately — see
 * `closableBusinessDate`), and it has no fairness policy beyond registry order.
 * None of those are needed by any job registered today, and inventing them
 * would be the "new infrastructure without justification" the brief forbids.
 *
 * NOT STARTED FROM `onModuleInit`, for the identical reason `OutboxRelay` is
 * not: `AppModule` is instantiated by the DI-graph unit test and by the
 * cross-tenant probe, and a timer that starts itself would open database
 * handles in suites that never asked for one and keep Jest alive. `main.ts`
 * starts it; tests call `tick()` directly, which is also what makes the
 * behaviour assertable instead of timing-dependent.
 */
@Injectable()
export class SchedulerService implements OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly runner: JobRunner) {}

  start(intervalMs: number = SCHEDULER_DEFAULTS.tickIntervalMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        this.logger.error(`scheduler.tick_failed ${err instanceof Error ? err.message : err}`),
      );
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(
      `scheduler.started worker=${this.runner.workerId} intervalMs=${intervalMs} jobs=${this.runner.jobNames().join(',')}`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * One pass over every registered job. Returns the reports so tests assert on
   * real numbers rather than on log output.
   *
   * Re-entrancy guard: a tick that overruns the interval must not have a second
   * tick start underneath it. The lease would make that safe anyway — the
   * second tick simply fails to claim — but it would double the connection load
   * for zero additional work, which is the same trade `OutboxRelay.tick` makes.
   */
  async tick(now: Date = new Date()): Promise<JobExecutionReport[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      return await this.runner.runDueJobs(now);
    } finally {
      this.ticking = false;
    }
  }
}
