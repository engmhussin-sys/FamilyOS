import { Injectable, Logger } from '@nestjs/common';

import { runAsSystemAsync } from '../../../../common/tenancy/system-context';
import { DataRetentionEnforcementService } from '../../../data-retention/application/data-retention-enforcement.service';
import { EMPTY_OUTCOME, type JobOutcome, type PlatformJobDefinition } from '../../domain/job.types';

export const RETENTION_SWEEP_JOB = 'data-retention-sweep';

/**
 * PHASE C P4 — THE JOB THAT MAKES RETENTION A MECHANISM.
 *
 * WHAT WAS BROKEN BY ITS ABSENCE, precisely: `enforceAll()` had zero
 * production callers, so every retention period in
 * `DataRetentionPolicyService` — 90 days for notifications, 90 for a child's
 * app-usage history, 180 for analytics — described a deletion that had never
 * once happened on any deployment. The tables grew monotonically. For a
 * product about to run a pilot on children's behavioural data, that is a
 * compliance condition and not a backlog item, which is exactly how Phase B
 * §19 classified it.
 *
 * CROSS-TENANT BY DEFINITION, AND DECLARED AS SUCH. It runs under
 * `runAsSystem('DATA_RETENTION_JOB', ...)` — the SystemReason F2 created for
 * precisely this and which had, until now, no caller either. Every bypass is
 * logged with its justification, so `grep tenant.system_bypass` enumerates
 * every sweep that actually ran.
 *
 * IT DOES NOT RE-ENTER A TENANT, and that is the one difference from
 * `family-daily-rollover`. A retention sweep whose statement carried a
 * `family_id` would have to be run 60,000 times to do one day's work; the
 * DELETE is deliberately one statement over all households, and the report
 * says so rather than dressing it up.
 */
@Injectable()
export class RetentionSweepJob {
  private readonly logger = new Logger(RetentionSweepJob.name);

  constructor(private readonly retention: DataRetentionEnforcementService) {}

  definition(): PlatformJobDefinition {
    return {
      name: RETENTION_SWEEP_JOB,
      scope: 'PLATFORM',
      description:
        'كنس الاحتفاظ اليومي: يحذف الصفوف التي تجاوزت مدّتها في جدول الاحتفاظ، على دفعات محدودة، ويسجّل الأعداد دون المحتوى.',
      handler: (ctx) => this.run(ctx.now),
    };
  }

  /**
   * One sweep. Returns per-table counts; the caller writes them into
   * `job_runs.details`.
   *
   * THE TWO HALVES, and why they are both here. `sweepAll()` runs the
   * table-driven age-based schedule (eleven tables, batched and bounded).
   * `enforceNonAgeBased()` runs the three mechanisms that cannot be expressed
   * that way: the analytics anonymisation (an UPDATE, not a DELETE), the
   * per-row `expiresAt` location sweep, and the evidence sweep that has to
   * delete bytes out of object storage before it tombstones a row. Splitting
   * them into two jobs would have given an operator two buttons for one
   * compliance obligation and a way to press only one of them.
   */
  async run(now: Date): Promise<JobOutcome> {
    return runAsSystemAsync(
      'DATA_RETENTION_JOB',
      'Scheduled retention sweep deletes aged rows across every tenant; retention is an age-based obligation over the whole deployment and cannot be expressed inside one family scope.',
      async () => {
        const details: Record<string, number> = {};
        let affectedRows = 0;
        let truncatedTargets = 0;

        for (const result of await this.retention.sweepAll({ now })) {
          details[result.key] = result.deletedRows;
          affectedRows += result.deletedRows;
          if (result.truncated) truncatedTargets += 1;
        }

        for (const result of await this.retention.enforceNonAgeBased()) {
          // The category names carry spaces and parentheses; the run history is
          // keyed by machine-readable ids, so they are normalised here rather
          // than in the policy table, which is read by humans.
          details[normaliseKey(result.category)] = result.affectedRows;
          affectedRows += result.affectedRows;
        }

        if (truncatedTargets > 0) {
          // A visible signal, not a silent partial. The run still SUCCEEDS —
          // it deleted everything it was allowed to — but the operator can see
          // that a table has a backlog the daily cap did not clear.
          details.truncated_targets = truncatedTargets;
          this.logger.warn(
            `retention.batch_cap_reached targets=${truncatedTargets} — a table still has rows past their retention period; the next run continues from the same cutoff.`,
          );
        }

        return affectedRows === 0 && Object.keys(details).length === 0
          ? EMPTY_OUTCOME
          : { affectedRows, details };
      },
    );
  }
}

function normaliseKey(category: string): string {
  return category
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
