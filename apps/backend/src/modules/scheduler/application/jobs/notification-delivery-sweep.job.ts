import { Injectable } from '@nestjs/common';

import { QuietHoursReleaseService } from '../../../life-intelligence/application/services/quiet-hours-release.service';
import type { JobOutcome, PlatformJobDefinition } from '../../domain/job.types';

export const NOTIFICATION_DELIVERY_SWEEP_JOB = 'notification-delivery-sweep';

/**
 * PHASE D (`PC-D-005`) — THE FIFTH JOB, AND THE REASON THERE IS NOT A FIFTH
 * SCHEDULER.
 *
 * Phase C §2 row 7 listed «Notification scheduling / digest» as NOT BUILT with
 * a one-line reason: «يحتاج جدول deferral ومسار كتابة جديدين» — it needed a
 * deferral table and a write path, and wiring a scheduler to a queue that does
 * not exist is impossible. Migration 0012 created the table. This class is the
 * wiring, and it is nine lines of substance on purpose: everything a scheduled
 * job needs — the lease, the advisory lock, the run history, the backoff, the
 * visible failure state, the manual-run button, the kill switch — already
 * exists in `JobRunner`, and re-implementing any of it for notifications would
 * have been the second scheduler the brief forbids.
 *
 * PLATFORM, NOT FAMILY, and the distinction is not cosmetic. A FAMILY-scoped
 * job claims `job_runs (job_name, family_id, business_date)` and therefore runs
 * ONCE PER HOUSEHOLD PER BUSINESS DAY. That is precisely right for a rollover,
 * which closes a day, and precisely wrong for this, which must also retry a
 * push that failed twenty minutes ago. The fan-out over households happens
 * INSIDE `QuietHoursReleaseService.sweep`, one `runWithTenant` per family — the
 * same shape `OutboxRelay.dispatch` uses.
 *
 * IDEMPOTENT INDEPENDENTLY OF THE RUNNER, like every other job body here. The
 * claim is an `UPDATE ... FOR UPDATE SKIP LOCKED` that moves a row out of
 * PENDING, so a second sweep in the same second claims nothing; the digest is
 * keyed by `(business date, audience)` behind `notifications`' unique index;
 * and every delivery carries the producer's original `source_event_id`, so even
 * a row released twice cannot write two notifications. Pressing «Run now»
 * twice is safe, and it is safe for three independent reasons rather than one.
 *
 * WHY IT DOES NOT THROW ON A NON-ZERO `dead` COUNT, unlike
 * `outbox-dead-letter-alert` which throws on its own. Because this job DOES THE
 * WORK as well as measuring it: a job that fails is backed off, and backing off
 * the release sweep because some notification is undeliverable would let one
 * poisoned row delay every other household's morning queue. The visibility
 * requirement is met by the count landing in `job_runs.details` (queryable,
 * graphable, and part of the history) and by `GET /system/notifications/deliveries`,
 * not by making delivery hostage to observability.
 */
@Injectable()
export class NotificationDeliverySweepJob {
  constructor(private readonly release: QuietHoursReleaseService) {}

  definition(): PlatformJobDefinition {
    return {
      name: NOTIFICATION_DELIVERY_SWEEP_JOB,
      scope: 'PLATFORM',
      description:
        'إطلاق الإشعارات المؤجَّلة بساعات الهدوء عند نهاية نافذة كلّ أسرة، مع الدمج والملخّص وإعادة المحاولة — وتسجيل ما مات نهائيًّا كعدد مرئيّ.',
      handler: (ctx) => this.run(ctx.now),
    };
  }

  async run(now: Date): Promise<JobOutcome> {
    const report = await this.release.sweep(now);
    return {
      // The headline number an operator scans is DELIVERIES, not rows touched:
      // «this sweep put 14 notifications in front of 9 households».
      affectedRows: report.delivered + report.digests,
      details: {
        families: report.families,
        claimed: report.claimed,
        delivered: report.delivered,
        digests: report.digests,
        coalesced: report.coalesced,
        digested: report.digested,
        capped_at_delivery: report.capped,
        redeferred: report.redeferred,
        failed: report.failed,
        dead: report.dead,
      },
    };
  }
}
