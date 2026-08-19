import { Injectable } from '@nestjs/common';

import { GoalNudgeService } from '../../../life-intelligence/application/services/goal-nudge.service';
import type { JobOutcome, PlatformJobDefinition } from '../../domain/job.types';

export const GOAL_NUDGE_SWEEP_JOB = 'goal-nudge-sweep';

/**
 * SPRINT F1 — THE EIGHTH JOB, AND THE MOMENT THE PRODUCT DID NOT HAVE.
 *
 * `GOAL_DEADLINE_NEAR` and `GOAL_ALMOST_DONE` are statements about a goal that
 * is still open, and a goal that is still open EMITS NOTHING — the same absence
 * `GOAL_STALLED_PARENT` was stuck behind for a sprint. So the fact has to be
 * ASKED FOR, on a clock, and the two clocks this product already had are both
 * the wrong clock:
 *
 *   `family-daily-rollover`   FAMILY scope, `local_hour = 2`: once per household
 *                             per day, inside every household's quiet hours, and
 *                             hours after any deadline closed.
 *   the child device check-in `ChildSignalService`'s anchor. Four hours apart at
 *                             best, gated on `APP_USAGE_MONITORING` consent, and
 *                             only while the child is holding the phone.
 *
 * `GoalNudgeService.sweep` needs to be able to see an EIGHT-MINUTE window
 * (`goal-nudge.types.ts` derives it), so the cadence has to be smaller than
 * that. `300` is the cadence `notification-delivery-sweep` and
 * `outbox-dead-letter-alert` already run at — the smallest this product uses,
 * chosen here because it is the largest one that still cannot step over the
 * band, not because a smaller number felt safer.
 *
 * PLATFORM, NOT FAMILY, and the distinction is the same one
 * `NotificationDeliverySweepJob` makes: a FAMILY-scoped job claims
 * `job_runs (job_name, family_id, business_date)` and therefore runs ONCE PER
 * HOUSEHOLD PER BUSINESS DAY. That is right for a rollover, which closes a day,
 * and catastrophically wrong for a watch that must look again in five minutes.
 * The fan-out over households happens INSIDE `GoalNudgeService.sweep`, one
 * `runWithTenant` per family — the same shape the release sweep uses.
 *
 * IDEMPOTENT INDEPENDENTLY OF THE RUNNER, like every other job body here, and
 * that property is doing real work at this cadence: 288 ticks a day all compose
 * the SAME `forEntity('signal', childId, '<kind>:<programId>', businessDate)`
 * key, and `notification_decisions_cause_uniq` refuses every one after the
 * first. Pressing «Run now» is safe for the same reason a tick is.
 *
 * IT DOES NOT THROW ON `refused`. A refusal is the ENGINE working — quiet
 * hours, the fatigue cap, the suppression floor — and backing this job off
 * because a household is asleep would stop the sweep for every other household
 * on earth. The counts land in `job_runs.details`, which is where an operator
 * reads them.
 */
@Injectable()
export class GoalNudgeSweepJob {
  constructor(private readonly nudges: GoalNudgeService) {}

  definition(): PlatformJobDefinition {
    return {
      name: GOAL_NUDGE_SWEEP_JOB,
      scope: 'PLATFORM',
      description:
        'تذكير الطفل بهدفٍ يوشك وقته على الانتهاء، أو بهدفٍ لم تبقَ منه إلا خطوة واحدة اليوم — مرّة واحدة في اليوم لكل هدف، وبتقويم الأسرة نفسها.',
      handler: (ctx) => this.run(ctx.now),
    };
  }

  async run(now: Date): Promise<JobOutcome> {
    const report = await this.nudges.sweep(now);
    return {
      // The headline number an operator scans is what actually reached a child,
      // never how many rows were read.
      affectedRows: report.produced,
      details: {
        families: report.families,
        children: report.children,
        candidates: report.candidates,
        produced: report.produced,
        already_decided: report.alreadyDecided,
        refused: report.refused,
      },
    };
  }
}
