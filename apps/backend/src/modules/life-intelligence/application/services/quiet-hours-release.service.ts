import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { FamilyDateService } from '../../../../common/time/family-date.service';
import {
  getBusinessDate,
  getBusinessTimeHHMM,
  getStartOfBusinessDay,
  nextLocalTimeAfter,
} from '../../../../common/time/family-date';
import { runWithTenant } from '../../../../common/tenancy/tenant-context';
import { forQuietHoursDigest } from '../../../../shared/notifications/notification-source-key';
import { quietHoursClassOf } from '../../../../shared/notifications/notification-class';
import {
  NOTIFICATION_DELIVERY_REPOSITORY,
  type INotificationDeliveryRepository,
} from '../../../notifications/application/ports/notification-delivery.repository.port';
import {
  NOTIFICATION_REPOSITORY,
  type INotificationRepository,
} from '../../../notifications/application/ports/notification.repository.port';
import {
  RUNTIME_ALERT_REPOSITORY,
  type IRuntimeAlertRepository,
} from '../../../pairing/application/ports/runtime-alert.repository.port';
import { digestText, planRelease } from '../../../notifications/domain/coalesce-and-digest';
import {
  QUIET_HOURS_DIGEST_TYPE,
  RELEASE_DEFAULTS,
  type DeferredNotificationRow,
  type ResolutionReason,
} from '../../../notifications/domain/notification-delivery.types';
import {
  DEFAULT_FATIGUE_POLICY,
  evaluateFatigue,
  type IRecentNotification,
} from './notification-fatigue-guard';
import { SmartNotificationIntegrationService } from './smart-notification-integration.service';

/** What one sweep did. Counts only — this object becomes `job_runs.details`,
 * and that column is contractually counts and never content. */
export interface ReleaseReport {
  readonly families: number;
  readonly claimed: number;
  readonly delivered: number;
  readonly coalesced: number;
  readonly digested: number;
  readonly digests: number;
  readonly capped: number;
  readonly redeferred: number;
  readonly failed: number;
  readonly dead: number;
}

const EMPTY_REPORT: ReleaseReport = {
  families: 0,
  claimed: 0,
  delivered: 0,
  coalesced: 0,
  digested: 0,
  digests: 0,
  capped: 0,
  redeferred: 0,
  failed: 0,
  dead: 0,
};

const HISTORY_WINDOW_HOURS = 24;
const KNOWN_PRIORITIES = new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);

/**
 * PHASE D (`PC-D-005`) — THE OTHER HALF OF DEFERRAL: THE RELEASE.
 *
 * A deferral mechanism with no release is a table that grows. This service is
 * what turns `notification_deliveries` back into notifications, and it is
 * deliberately shaped by four constraints the brief set:
 *
 *   NO SECOND SCHEDULER. It has no timer, no interval and no queue client. It
 *   exposes `sweep(now)`, and the caller is `NotificationDeliverySweepJob`,
 *   which is a PLATFORM job in the Phase C runner — same lease, same advisory
 *   lock, same `job_runs` history as the other four.
 *
 *   NO SECOND NOTIFICATION ENGINE. Delivery goes through
 *   `SmartNotificationIntegrationService.deliverNow`, the same method an
 *   immediate notification uses, which routes PARENT candidates to
 *   `createForFamilyOwner` (owner resolution, dedupe window, push fan-out) and
 *   CHILD candidates to the approval-gated `draftAiMessageIfAbsent`. This file
 *   contains zero knowledge of how a notification becomes a row.
 *
 *   THE CAPS APPLY AT DELIVERY TIME, NOT ONLY AT ENQUEUE TIME. Every surviving
 *   row is re-run through `evaluateFatigue` against the recipient's REAL
 *   history as of the release instant, and against the NEW business day's cap
 *   window. Eleven deferred notifications cannot walk past a `dailyMax` of six
 *   just because they were queued yesterday — which is exactly what a naive
 *   "release everything at 07:00" would have done.
 *
 *   THE FLOOD IS PLANNED, NOT HOPED AWAY. `planRelease` (a pure function) does
 *   the coalescing and digesting; see `coalesce-and-digest.ts` for the policy
 *   and its reasoning. This service only executes the plan.
 *
 * TENANCY. The fan-out enumeration reads TENANT IDS ONLY under
 * `NOTIFICATION_RELEASE`; every row read, every fatigue evaluation and every
 * delivery happens inside `runWithTenant({ familyId })`, exactly as
 * `OutboxRelay.dispatch` does it.
 */
@Injectable()
export class QuietHoursReleaseService {
  private readonly logger = new Logger(QuietHoursReleaseService.name);
  /** Same shape as `OutboxRelay.workerId` and `JobRunner.workerId`, so all
   * three leases read alike in the database during an incident. */
  readonly workerId = `notif-${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly deliveries: INotificationDeliveryRepository,
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly notifications: INotificationRepository,
    @Inject(RUNTIME_ALERT_REPOSITORY)
    private readonly runtimeAlerts: IRuntimeAlertRepository,
    private readonly integration: SmartNotificationIntegrationService,
    private readonly familyDate: FamilyDateService,
  ) {}

  /**
   * One pass. Reclaim stale leases, find the families with something due,
   * release each one inside its own tenant scope.
   *
   * ONE FAMILY'S FAILURE DOES NOT STOP THE SWEEP — the same coupling decision
   * the scheduler's own family fan-out made, and for the same reason: one
   * household with a broken row must not be able to hold every other
   * household's morning queue.
   */
  async sweep(now: Date = new Date()): Promise<ReleaseReport> {
    await this.deliveries.reclaimStaleLocks(RELEASE_DEFAULTS.leaseSeconds);

    const familyIds = await this.deliveries.familiesWithDueDeliveries(
      now,
      RELEASE_DEFAULTS.familyBatchSize,
    );
    if (familyIds.length === 0) return EMPTY_REPORT;

    let report: ReleaseReport = { ...EMPTY_REPORT, families: familyIds.length };
    for (const familyId of familyIds) {
      try {
        const one = await runWithTenant(
          { familyId, actorType: 'SYSTEM', actorId: 'quiet-hours-release' },
          () => this.releaseForFamily(familyId, now),
        );
        report = merge(report, one);
      } catch (err) {
        this.logger.error(
          `notification.release_failed family=${familyId.slice(0, 8)} ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        report = merge(report, { ...EMPTY_REPORT, failed: 1 });
      }
    }
    return report;
  }

  /** Everything below runs inside `runWithTenant` for exactly one household. */
  private async releaseForFamily(familyId: string, now: Date): Promise<ReleaseReport> {
    const rows = await this.deliveries.claimDue(
      familyId,
      this.workerId,
      now,
      RELEASE_DEFAULTS.perFamilyLimit,
    );
    if (rows.length === 0) return EMPTY_REPORT;

    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const localTime = getBusinessTimeHHMM(now, timeZone);

    // THE RE-DEFER GUARD. A row can legitimately come due while the window is
    // still quiet: a parent moved the family to a different timezone, an
    // operator pressed «Run now» at 03:00, a replica's clock drifted. Sending
    // then would defeat quiet hours using the machinery built to honour them.
    // Bounded by `maxDeferrals`, because a loop that always re-defers is a
    // queue that looks healthy and delivers nothing.
    const stillQuiet = isWithinQuietHours(localTime);
    const deliverable: DeferredNotificationRow[] = [];
    let redeferred = 0;
    let capped = 0;

    for (const row of rows) {
      if (!stillQuiet || quietHoursClassOf(row.type, row.priority) === 'DELIVER') {
        deliverable.push(row);
        continue;
      }
      if (row.attemptCount >= RELEASE_DEFAULTS.maxDeferrals) {
        await this.deliveries.markSuppressed(row.id, 'MAX_DEFERRALS');
        capped += 1;
        continue;
      }
      await this.deliveries.redefer(
        row.id,
        nextLocalTimeAfter(now, DEFAULT_FATIGUE_POLICY.quietHoursEnd, timeZone),
      );
      redeferred += 1;
    }

    let report: ReleaseReport = {
      ...EMPTY_REPORT,
      claimed: rows.length,
      redeferred,
      capped,
    };

    for (const audience of ['PARENT', 'CHILD'] as const) {
      report = merge(
        report,
        await this.releaseAudience(familyId, audience, deliverable, timeZone, now),
      );
    }
    return report;
  }

  private async releaseAudience(
    familyId: string,
    audience: 'PARENT' | 'CHILD',
    rows: readonly DeferredNotificationRow[],
    timeZone: string,
    now: Date,
  ): Promise<ReleaseReport> {
    const plan = planRelease(rows, audience);
    if (plan.deliver.length === 0 && plan.resolve.length === 0) return EMPTY_REPORT;

    let coalesced = 0;
    let digested = 0;
    for (const { row, reason } of plan.resolve) {
      await this.deliveries.markSuppressed(row.id, reason);
      if (reason === 'COALESCED') coalesced += 1;
      if (reason === 'DIGESTED') digested += 1;
    }

    // THE CAPS, AT DELIVERY TIME. Read the recipient's real recent history NOW,
    // and bound «today» by the business day the release falls in — which is the
    // NEW day, not the one the notification was deferred on. That is the whole
    // difference between «the cap was checked when it was queued» and «the cap
    // is true when it arrives».
    const businessDayStart = getStartOfBusinessDay(now, timeZone);
    const childIds = [...new Set(rows.map((r) => r.childId).filter((c): c is string => c !== null))];
    const historyByChild = new Map<string, IRecentNotification[]>();
    for (const childId of childIds) {
      historyByChild.set(childId, await this.historyFor(childId, now));
    }

    let delivered = 0;
    let capped = 0;
    let failed = 0;
    let dead = 0;

    for (const row of plan.deliver) {
      const history = row.childId ? (historyByChild.get(row.childId) ?? []) : [];
      const decision = evaluateFatigue(
        {
          type: row.type,
          priority: row.priority,
          title: row.title,
          body: row.body,
          targetAudience: row.targetAudience,
        },
        history,
        now,
        getBusinessTimeHHMM(now, timeZone),
        businessDayStart,
      );

      if (!decision.allowed) {
        // QUIET_HOURS cannot appear here — the re-defer guard above already
        // removed those rows — so anything blocked at this point is a genuine
        // cap, cooldown or duplicate and is TERMINAL. Recorded with the guard's
        // own reason, so «why did I not get it?» has an answer in a column.
        await this.deliveries.markSuppressed(
          row.id,
          (decision.blockedReason ?? 'DAILY_MAX') as ResolutionReason,
        );
        capped += 1;
        continue;
      }

      try {
        const written = await this.integration.deliverNow(
          row.childId ?? '',
          familyId,
          {
            type: row.type,
            priority: row.priority,
            title: row.title,
            body: row.body,
            targetAudience: row.targetAudience,
            // UNCHANGED FROM THE PRODUCER. This is the line that makes B9's
            // idempotency survive the deferral: the key composed at 22:00 is
            // the key inserted at 07:00, so a redelivery of the same cause
            // still collides with `notifications (family_id, source_event_id,
            // user_id)` and no reward is announced twice.
            sourceEventId: row.sourceEventId,
            // PHASE E (`PD-N-004`) — AND THE PAYLOAD IS UNCHANGED TOO. The
            // notification released at 07:00 is the notification composed at
            // 00:30 rather than a reconstruction of it, so a policy-violation
            // alert still names the package it was about.
            data: row.data ?? undefined,
          },
          // PHASE D: THIS ROW OWNS THE PUSH RETRY. The repository would
          // otherwise fire a best-effort push and swallow its failure, burning
          // the attempt this row is about to schedule a retry for.
          { deferPushToCaller: true },
        );

        // ATTEMPT 1 vs LATER ATTEMPTS, and the distinction is load-bearing.
        //
        // `written === false` means «`notifications` already had this row».
        // On the FIRST attempt that can only be a genuine duplicate — some
        // other producer already announced this exact cause — and the row is
        // terminal. On a LATER attempt it is the row THIS delivery wrote before
        // its push failed, so it is expected, and treating it as a duplicate
        // would end the retry loop at attempt two and make the backoff
        // decorative.
        const isOwnEarlierWrite = !written && row.attemptCount > 1;
        if (!written && !isOwnEarlierWrite) {
          await this.deliveries.markSuppressed(row.id, 'ALREADY_NOTIFIED');
          continue;
        }

        // THE PUSH, AND THE RETRY DECISION. A CHILD-targeted notification has
        // no push path at all — `draftAiMessageIfAbsent` writes a PENDING
        // child message that a parent must approve (Architecture 1.0 §5.8) —
        // so the row write IS the delivery for that audience.
        const push =
          row.targetAudience === 'PARENT'
            ? await this.runtimeAlerts.pushToFamilyOwner({
                familyId,
                title: row.title,
                body: row.body,
              })
            : 'NONE';

        if (push === 'RETRYABLE') {
          // Transient: FCM was unreachable, rate-limited or broken. Back off
          // and try again; after `maxAttempts` the SQL writes DEAD and the row
          // becomes a number an operator can read.
          await this.deliveries.markAttemptFailed(row.id, `push_retryable attempt=${row.attemptCount}`);
          if (row.attemptCount >= RELEASE_DEFAULTS.maxAttempts) {
            dead += 1;
            this.logger.error(
              `notification.delivery_dead type=${row.type} attempts=${row.attemptCount} reason=push_retryable`,
            );
          } else {
            failed += 1;
          }
          continue;
        }

        // SENT, SKIPPED, NONE, PERMANENT and NO_RECIPIENT are all terminal, and
        // three of them are SUCCESSES rather than failures: the in-app row
        // exists and the app shows it on next open. Retrying a stale token or a
        // household with no registered device eight times would manufacture
        // DEAD rows out of facts about the deployment, not about the delivery.
        await this.deliveries.markDelivered(row.id);
        delivered += 1;
        // Feeds the SAME history array the next row is evaluated against, so
        // two releases in one sweep each count against the other's cap.
        if (row.childId) {
          historyByChild.get(row.childId)?.unshift({
            type: row.type,
            priority: row.priority,
            createdAt: new Date(now),
          });
        }
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        await this.deliveries.markAttemptFailed(row.id, message);
        // `attemptCount` was incremented AT CLAIM, so this row has already
        // burned it; reaching the cap means the SQL just wrote DEAD.
        if (row.attemptCount >= RELEASE_DEFAULTS.maxAttempts) {
          dead += 1;
          this.logger.error(
            `notification.delivery_dead type=${row.type} attempts=${row.attemptCount} error="${message.slice(0, 200)}"`,
          );
        } else {
          failed += 1;
          this.logger.warn(
            `notification.delivery_retry type=${row.type} attempt=${row.attemptCount} error="${message.slice(0, 200)}"`,
          );
        }
      }
    }

    const digests = await this.writeDigest(familyId, audience, plan.digestOf, timeZone, now);
    return { ...EMPTY_REPORT, delivered, coalesced, digested, digests, capped, failed, dead };
  }

  /**
   * ONE DIGEST, PER FAMILY, PER BUSINESS DAY, PER AUDIENCE — and the guarantee
   * is a unique index, not a count this method has to get right.
   * `forQuietHoursDigest` composes `digest:{businessDate}:{audience}`, so a
   * sweep that runs twice (an operator's «Run now», a replica retrying after a
   * crash mid-release) has its second digest refused by
   * `notifications (family_id, source_event_id, user_id)`. Without that, the
   * anti-flood mechanism would itself be capable of producing a flood.
   */
  private async writeDigest(
    familyId: string,
    audience: 'PARENT' | 'CHILD',
    digestOf: readonly DeferredNotificationRow[],
    timeZone: string,
    now: Date,
  ): Promise<number> {
    if (digestOf.length === 0) return 0;
    const text = digestText(digestOf.length);
    const businessDate = getBusinessDate(now, timeZone);
    try {
      const written = await this.integration.deliverNow(digestOf[0].childId ?? '', familyId, {
        type: QUIET_HOURS_DIGEST_TYPE,
        priority: 'LOW',
        title: text.title,
        body: text.body,
        targetAudience: audience,
        sourceEventId: forQuietHoursDigest(businessDate, audience),
      });
      return written ? 1 : 0;
    } catch (err) {
      // A digest that fails does NOT fail the release: the notifications it
      // summarises are already resolved, and re-running the sweep would
      // re-resolve nothing. It is logged and counted as zero.
      this.logger.warn(
        `notification.digest_failed family=${familyId.slice(0, 8)} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }

  /**
   * PHASE D (`PD-N-003`) — THE WINDOW IS ANCHORED TO `now`, NOT TO THE WALL
   * CLOCK, and it was not: this method read `Date.now()` while every decision
   * around it used the `now` the sweep was given. The two agree in production
   * and disagree everywhere else — which meant the caps were evaluated against
   * a history window that had nothing to do with the instant being evaluated.
   * The suite's own «caps at delivery time» case measured it: a cap that was
   * exhausted returned an EMPTY history and the notification went out.
   */
  private async historyFor(childId: string, now: Date): Promise<IRecentNotification[]> {
    const since = new Date(now.getTime() - HISTORY_WINDOW_HOURS * 60 * 60 * 1000);
    const raw = await this.notifications.findRecentForChild(childId, since);
    return raw.map((n) => ({
      type: n.type,
      priority: (KNOWN_PRIORITIES.has(n.priority) ? n.priority : 'NORMAL') as
        | 'CRITICAL'
        | 'HIGH'
        | 'NORMAL'
        | 'LOW',
      createdAt: n.createdAt,
    }));
  }
}

function merge(a: ReleaseReport, b: ReleaseReport): ReleaseReport {
  return {
    families: a.families + (b === EMPTY_REPORT ? 0 : b.families),
    claimed: a.claimed + b.claimed,
    delivered: a.delivered + b.delivered,
    coalesced: a.coalesced + b.coalesced,
    digested: a.digested + b.digested,
    digests: a.digests + b.digests,
    capped: a.capped + b.capped,
    redeferred: a.redeferred + b.redeferred,
    failed: a.failed + b.failed,
    dead: a.dead + b.dead,
  };
}

/**
 * The same wraparound comparison `NotificationFatigueGuard` uses, and it is
 * duplicated here DELIBERATELY-NOT: it reads `DEFAULT_FATIGUE_POLICY`, the same
 * constant, so the two can never disagree about when quiet hours are. The
 * function is private because the guard's own copy is the product behaviour and
 * this one is only the re-defer safety check.
 */
function isWithinQuietHours(currentHHMM: string): boolean {
  const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const current = toMinutes(currentHHMM);
  const start = toMinutes(DEFAULT_FATIGUE_POLICY.quietHoursStart);
  const end = toMinutes(DEFAULT_FATIGUE_POLICY.quietHoursEnd);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}
