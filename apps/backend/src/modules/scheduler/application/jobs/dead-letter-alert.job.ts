import { Injectable, Logger } from '@nestjs/common';

import { OutboxRelay } from '../../../events/application/outbox.relay';
import type { JobOutcome, PlatformJobDefinition } from '../../domain/job.types';

export const DEAD_LETTER_ALERT_JOB = 'outbox-dead-letter-alert';

/**
 * PHASE C P4 — the recurring reader for a queue that could only be read by
 * hand.
 *
 * WHAT WAS BROKEN BY ITS ABSENCE. F3 gave the outbox a `DEAD` status and a
 * `maxAttempts` of 8; PHASE-C-P0 gave `DEAD` a reader (`deadLetters()`) and a
 * button (`recoverDeadLetters()`). Both are correct and both require a HUMAN TO
 * ALREADY SUSPECT SOMETHING. Nothing polled them. And the one gauge that did
 * run — `backlog()` — counts `('PENDING','FAILED')` only, so a message
 * reaching `DEAD` makes the backlog number go DOWN: the alert got quieter
 * exactly as the incident got worse. A reward could sit in
 * `rewards_ledger_entries` with its `REWARD_GRANTED` announcement permanently
 * undelivered and no periodic process anywhere would have said so.
 *
 * WHY THIS JOB DOES NOT AUTO-RECOVER, stated plainly because the P4 brief
 * names dead-letter recovery as a scheduler candidate and this is a deliberate
 * refusal rather than an omission:
 *
 *   A dead letter is a message that has already failed EIGHT times with
 *   exponential backoff. Requeueing it on a timer is the textbook way a poison
 *   message becomes an infinite loop, and the judgement it requires — «the
 *   downstream is healthy again» — is a human's. PHASE-C-P0 made that argument
 *   when it built the recovery route as a POST an operator presses, and
 *   reversing it here because a scheduler now exists would be building the
 *   mechanism and then using it to undo the reasoning that produced it.
 *
 *   So this job does the half that is unambiguously safe and was genuinely
 *   missing: it OBSERVES on a five-minute cadence, records the gauge in
 *   `job_runs` where it can be graphed and alerted on, and FAILS — visibly,
 *   with a climbing `consecutive_failures` — when the dead-letter count is
 *   above zero. The operator still presses the button; they now find out
 *   without being told.
 */
@Injectable()
export class DeadLetterAlertJob {
  private readonly logger = new Logger(DeadLetterAlertJob.name);

  constructor(private readonly relay: OutboxRelay) {}

  definition(): PlatformJobDefinition {
    return {
      name: DEAD_LETTER_ALERT_JOB,
      scope: 'PLATFORM',
      description:
        'مِقياس الرسائل الميتة في الـ outbox: يقرأ العدّاد كل خمس دقائق ويُسجّل الحالة كفشل مرئي إن وُجدت رسالة واحدة على الأقل.',
      handler: () => this.run(),
    };
  }

  /**
   * DETERMINISTIC AND READ-ONLY. It changes nothing, so running it twice is
   * trivially idempotent — which is the point: the ONE job in this scheduler
   * that fires most often is also the one that cannot damage anything.
   *
   * IT THROWS ON A NON-ZERO COUNT. That is the alert. `job_runs.status` becomes
   * FAILED, `scheduled_jobs.consecutive_failures` climbs, the backoff spaces
   * the checks out, and `GET /system/jobs/failures` shows it — the visible
   * failure state requirement, used for its real purpose instead of only for
   * crashes.
   */
  async run(): Promise<JobOutcome> {
    const [dead, backlog] = await Promise.all([this.relay.deadLetters(), this.relay.backlog()]);

    const details: Record<string, number> = {
      dead_letters: dead.total,
      backlog_pending: backlog.pendingCount,
      backlog_age_seconds: backlog.ageSeconds,
      affected_families: dead.messages.length > 0 ? new Set(dead.messages.map((m) => m.familyId)).size : 0,
    };

    if (dead.total > 0) {
      // The event TYPES are named; no family id, no payload, no child. An
      // operator needs to know WHAT is undeliverable to triage it; they do not
      // need to know whose, and the triage list behind the admin guard already
      // answers that for whoever is entitled to ask.
      const byType = dead.byEventType.map((r) => `${r.eventType}=${r.count}`).join(',');
      this.logger.error(`outbox.dead_letters_present total=${dead.total} byType=${byType}`);
      throw new DeadLettersPresentError(dead.total, byType);
    }

    return { affectedRows: 0, details };
  }
}

/**
 * A named error rather than `new Error(...)`, so the failure in `job_runs`
 * reads as a CONDITION and not as a crash. «outbox has 3 dead letters» and
 * «the job threw TypeError» are different incidents and an operator must be
 * able to tell them apart from the history alone.
 */
export class DeadLettersPresentError extends Error {
  constructor(total: number, byType: string) {
    super(`outbox has ${total} dead letter(s) awaiting operator recovery [${byType}]`);
    this.name = 'DeadLettersPresentError';
  }
}
