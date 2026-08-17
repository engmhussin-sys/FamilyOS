import { Inject, Injectable, Logger } from '@nestjs/common';

import { RUNTIME_ALERT_REPOSITORY, type IRuntimeAlertRepository } from '../../../pairing/application/ports/runtime-alert.repository.port';
import { NOTIFICATION_REPOSITORY, type INotificationRepository } from '../../../notifications/application/ports/notification.repository.port';
import {
  NOTIFICATION_DELIVERY_REPOSITORY,
  type INotificationDeliveryRepository,
} from '../../../notifications/application/ports/notification-delivery.repository.port';
import { FamilyCommunicationService } from './family-communication.service';
import { evaluateSmartNotificationCandidates, type ISmartNotificationSignals } from './smart-notification-decision-engine';
import {
  DEFAULT_FATIGUE_POLICY,
  evaluateFatigue,
  type ICandidateNotification,
  type IRecentNotification,
} from './notification-fatigue-guard';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import {
  getBusinessDate,
  getBusinessTimeHHMM,
  getStartOfBusinessDay,
  nextLocalTimeAfter,
} from '../../../../common/time/family-date';
import { forRecurringSignal } from '../../../../shared/notifications/notification-source-key';
import {
  notificationCategoryOf,
  quietHoursClassOf,
} from '../../../../shared/notifications/notification-class';

export interface INotificationOutcome {
  type: string;
  targetAudience: 'PARENT' | 'CHILD';
  decision: 'SEND' | 'DEFER' | 'SUPPRESS';
  reason?: string;
}

/**
 * B9 (PA-B-007 / PA-B-008) — a candidate PLUS the one thing that makes it
 * identifiable.
 *
 * `ICandidateNotification` is left exactly as Sprint 16 wrote it: it is the
 * input to a PURE function (`evaluateFatigue`) that has no business knowing
 * about database keys, and its unit tests construct it directly. The causal
 * key belongs to DELIVERY, not to the fatigue decision, so it is added here —
 * at the layer that actually writes a row — and it is REQUIRED, so a producer
 * cannot reach `deliver()` without having composed one.
 */
export interface IDeliverableNotification extends ICandidateNotification {
  /** Composed with one of the three documented forms in
   * `src/shared/notifications/notification-source-key.ts`. */
  readonly sourceEventId: string;
  /**
   * PHASE E (`PD-N-004`) — the producer's own payload, written verbatim into
   * `notifications.data` and held verbatim in `notification_deliveries.data`
   * across a deferral.
   *
   * It exists because `DigitalWellbeingEngineService` was routed through this
   * gate and its alerts carry device specifics the parent app reads (which
   * package, which limit, how far over). Optional, so every producer written
   * before today is unchanged.
   */
  readonly data?: Record<string, unknown>;
}

const HISTORY_WINDOW_HOURS = 24;
const KNOWN_PRIORITIES = new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);

/**
 * Sprint 16.1 Phase 3 (Smart Notification Integration) — CLOSES A
 * REAL GAP: SmartNotificationDecisionEngine and NotificationFatigueGuard
 * existed only as pure functions with zero real caller. This is the
 * missing wiring: the ONLY real entry point from a signal/event to an
 * actual delivered notification.
 *
 * Sprint 16.2 Phases 1-2 — CLOSES TWO MORE REAL GAPS: refactored to
 * expose deliverCandidate() as a public, reusable single-candidate
 * pipeline (extracted from processSignals's own per-candidate loop
 * body, not duplicated) — this is what lets Habit Completion and
 * Reward Grant events reuse the EXACT SAME fatigue-guarded delivery
 * pipeline as the periodic signal-based flow, instead of each
 * needing its own bespoke notification logic. Zero new Notification
 * Engine built — the brief's own explicit "no duplicate engines"
 * instruction, honored by this single shared code path.
 *
 * Deliberately reuses existing infrastructure:
 * - IRuntimeAlertRepository.createForFamilyOwner for PARENT-targeted
 *   candidates — Owner Resolution, real Deduplication, real Push.
 * - FamilyCommunicationService.draftAiMessage for CHILD-targeted
 *   candidates — enforces MessageApprovalStatus (Architecture 1.0
 *   §5.8). This layer NEVER bypasses that gate.
 */
@Injectable()
export class SmartNotificationIntegrationService {
  private readonly logger = new Logger(SmartNotificationIntegrationService.name);

  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificationRepository: INotificationRepository,
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly deferralRepository: INotificationDeliveryRepository,
    @Inject(RUNTIME_ALERT_REPOSITORY) private readonly runtimeAlertRepository: IRuntimeAlertRepository,
    private readonly familyCommunication: FamilyCommunicationService,
    private readonly familyDate: FamilyDateService,
  ) {}

  /** The signal-batch entry point (Sprint 16.1 Phase 3, unchanged
   * behavior — 8/8 existing tests still pass against this method
   * after the refactor below). */
  async processSignals(childId: string, familyId: string, signals: ISmartNotificationSignals): Promise<INotificationOutcome[]> {
    const candidates = evaluateSmartNotificationCandidates(signals);
    if (candidates.length === 0) return [];

    // B9 — ONE `now` for the whole batch, so two candidates evaluated in the
    // same call cannot land in two different dedupe buckets because a
    // millisecond passed between them. PHASE D — and the history window is
    // anchored to it too, so «the last 24 hours» means the last 24 hours
    // before the instant being evaluated.
    const now = new Date();
    const history = await this.fetchHistory(childId, now);
    const outcomes: INotificationOutcome[] = [];

    for (const candidate of candidates) {
      // B9 — THE PERIODIC CLASS, composed here rather than by the caller
      // because the caller supplies SIGNALS, not notifications: it does not
      // know which candidates the decision engine will produce and cannot
      // name them. A hydration reminder has no domain event and no entity —
      // it is a recurring observation that SHOULD notify again later — so it
      // takes the bucketed form, with the bucket width equal to the fatigue
      // guard's own sliding DUPLICATE window. The guard stays the product
      // behaviour; the constraint is the floor under it.
      const deliverable: IDeliverableNotification = {
        ...candidate,
        sourceEventId: forRecurringSignal('signal', childId, candidate.type, now),
      };
      const outcome = await this.evaluateAndDeliver(childId, familyId, deliverable, history, now);
      outcomes.push(outcome);
      // Feeds back into the SAME history array used by subsequent
      // candidates in this same batch — two candidates matching in
      // one call must each be correctly counted against
      // dailyMax/categoryMax for the other.
      if (outcome.decision === 'SEND') {
        history.unshift({ type: candidate.type, priority: candidate.priority, createdAt: new Date() });
      }
    }

    return outcomes;
  }

  /** Sprint 16.2 Phases 1-2 — CLOSES A REAL GAP: the single-candidate
   * public entry point for EVENT-DRIVEN callers (a habit streak
   * milestone, a reward grant) — as opposed to processSignals' own
   * periodic/context-scan entry point. Fetches its own fresh history
   * (real DB read, so a caller doesn't need to manage that itself)
   * and runs the EXACT SAME fatigue-guarded delivery pipeline. Never
   * throws for a delivery failure — logged, not propagated, so a
   * notification issue never blocks the real business event (a habit
   * completion, a reward grant) that triggered it. */
  async notifyEvent(
    childId: string,
    familyId: string,
    candidate: IDeliverableNotification,
    /**
     * PHASE D — `now` IS A PARAMETER, exactly as it already is for
     * `evaluateFatigue`, `closableBusinessDate` and every other decision in
     * this codebase that has a right answer. Deferral turned this method into
     * one of those: it now computes a persisted instant from the family's
     * calendar, and a function that reads the clock inside itself cannot be
     * proven correct across a midnight or a DST boundary without faking the
     * system clock — which, for a path that also does real database I/O, means
     * faking the timers the database driver needs. Defaulted, so no existing
     * caller changes.
     */
    now: Date = new Date(),
  ): Promise<INotificationOutcome> {
    const history = await this.fetchHistory(childId, now);
    return this.evaluateAndDeliver(childId, familyId, candidate, history, now);
  }

  /** PHASE D (`PD-N-003`): the window is anchored to the `now` being evaluated,
   * not to the wall clock. The two agree in production and disagree in every
   * test and every replayed instant, which is precisely where a cap silently
   * stops applying. */
  private async fetchHistory(childId: string, now: Date): Promise<IRecentNotification[]> {
    const since = new Date(now.getTime() - HISTORY_WINDOW_HOURS * 60 * 60 * 1000);
    const rawHistory = await this.notificationRepository.findRecentForChild(childId, since);
    // Safe narrowing: every writer of Notification.priority uses this
    // exact union (schema's own open-string design means TypeScript
    // can't narrow it automatically) — an unexpected stored value
    // defensively falls back to NORMAL rather than crashing.
    return rawHistory.map((n) => ({
      type: n.type,
      priority: (KNOWN_PRIORITIES.has(n.priority) ? n.priority : 'NORMAL') as 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW',
      createdAt: n.createdAt,
    }));
  }

  /** Extracted from Sprint 16.1 Phase 3's own processSignals loop
   * body — shared by both the batch (processSignals) and single-event
   * (notifyEvent) entry points, so there is exactly ONE place the
   * fatigue-guard decision and delivery routing logic lives. */
  private async evaluateAndDeliver(
    childId: string,
    familyId: string,
    candidate: IDeliverableNotification,
    history: IRecentNotification[],
    now: Date,
  ): Promise<INotificationOutcome> {
    // B2 (PA-B-002), THE SERVER-LOCAL CLASS. This line was
    // `now.getHours()` — the CONTAINER's wall clock, not UTC and not the
    // family's. The default quiet-hours policy is 21:00-07:00; evaluated
    // against UTC for a Cairo family in summer that is 00:00-10:00 LOCAL, so
    // notifications were muted through the whole morning and allowed through
    // the three hours before local bedtime. The feature was not merely
    // imprecise, it was inverted exactly where it matters.
    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const currentLocalTime = getBusinessTimeHHMM(now, timeZone);
    const businessDayStart = getStartOfBusinessDay(now, timeZone);

    // PHASE E (`PD-N-004`) — THE DELIVER CLASS IS CHECKED BEFORE THE GUARD, NOT
    // INSIDE IT.
    //
    // Phase D put the matrix behind `evaluateFatigue`: a candidate had to be
    // BLOCKED for `QUIET_HOURS` before `handleQuietHours` ever asked what class
    // it was. That ordering has two consequences, and the second is a defect.
    //
    // First, `evaluateFatigue` decides the quiet-hours question on
    // `priority !== 'CRITICAL'` — the old implicit rule the matrix was written
    // to replace — so a DELIVER-class type at NORMAL priority reached the gate
    // only by accident of that comparison.
    //
    // Second and worse: a DELIVER-class safety alert blocked for DAILY_MAX,
    // CATEGORY_MAX or COOLDOWN returned SUPPRESS and never reached
    // `handleQuietHours` at all. A household that had already had twelve
    // notifications today would have had `ACCESSIBILITY_DISABLED` — the alert
    // that says the entire enforcement surface is off — silenced by a fatigue
    // cap. The matrix says in words that DELIVER «bypasses quiet hours
    // entirely, SAFETY-CRITICAL ONLY»; this is that sentence expressed as
    // control flow instead of trusted to a downstream branch.
    //
    // The list is three types long and `notification-class.spec.ts` fails if it
    // grows without a written justification, which is what keeps this from
    // being a hole. Duplicate suppression is NOT lost with it: the unique index
    // `notifications (family_id, source_event_id, user_id)` still collapses a
    // redelivered cause to one row, and it is stricter than the five-minute
    // window because it never forgets.
    if (quietHoursClassOf(candidate.type, candidate.priority) === 'DELIVER') {
      this.logger.log(
        `notification.safety_bypass type=${candidate.type} audience=${candidate.targetAudience}`,
      );
      return this.deliverEvaluated(childId, familyId, candidate);
    }

    const decision = evaluateFatigue(candidate, history, now, currentLocalTime, businessDayStart);

    if (!decision.allowed) {
      // PHASE D (`PC-D-005`) — THE LINE THAT USED TO LOSE THE NOTIFICATION.
      //
      // This branch read `decision: isDeferrable ? 'DEFER' : 'SUPPRESS'` and
      // then returned. `DEFER` wrote no row, enqueued nothing and scheduled
      // nothing — it was a WORD. With the default 21:00-07:00 policy that word
      // covered 41.6% of every day, and a reward the child genuinely earned
      // inside that window was announced to nobody, ever.
      //
      // Everything except QUIET_HOURS is still a real suppression and still
      // terminal: a cooldown, a duplicate or a cap means «this specific
      // occurrence should not be sent at all», and holding it until morning
      // would defeat the cap it was refused by.
      if (decision.blockedReason !== 'QUIET_HOURS') {
        return {
          type: candidate.type,
          targetAudience: candidate.targetAudience,
          decision: 'SUPPRESS',
          reason: decision.blockedReason,
        };
      }
      return this.handleQuietHours(childId, familyId, candidate, timeZone, now);
    }

    // B9 — «the constraint refused it» is a real, reportable outcome, and it is
    // a SUPPRESS rather than a SEND. Reporting SEND for a row the database
    // rejected would put a lie in the log line `NotificationRewardConsumer`
    // writes, and that log line is how the redelivery behaviour is observed in
    // production. A delivery failure is likewise reported, not propagated — a
    // notification problem must never block the reward grant that caused it.
    return this.deliverEvaluated(childId, familyId, candidate);
  }

  /**
   * PHASE D (`PC-D-005`) — THE THREE BEHAVIOURS, AT THE ONE GATE.
   *
   * The fatigue guard has just said «not now». What «not now» MEANS is a
   * per-type product decision, and it lives in `notification-class.ts` as a
   * table with a written justification per row rather than as a predicate over
   * `priority` — because priority describes how loud a notification is, not
   * whether the fact it carries survives the night. A `HYDRATION_REMINDER` and
   * a `REWARD_GRANTED` are both NORMAL and their correct behaviours here are
   * opposites.
   *
   *   DELIVER   safety-critical. Bypasses quiet hours and goes out now. The
   *             list is three types long and every member is argued for in the
   *             table; `test/notifications/notification-class.spec.ts` fails if
   *             it grows without a justification.
   *   SUPPRESS  the occurrence describes a MOMENT that will have passed by
   *             morning. Dropped — but WITH ITS REASON RECORDED, which is the
   *             entire difference between this and the defect.
   *   DEFER     the default. A row in `notification_deliveries` with a
   *             scheduled delivery instant computed on the FAMILY'S calendar,
   *             released by the existing scheduler.
   *
   * IT NEVER THROWS. A deferral that fails to enqueue is logged and reported as
   * a suppression with `DEFER_ENQUEUE_FAILED`, because this service's standing
   * discipline is that a notification problem must never fail the reward grant
   * or habit completion that triggered it.
   */
  private async handleQuietHours(
    childId: string,
    familyId: string,
    candidate: IDeliverableNotification,
    timeZone: string,
    now: Date,
  ): Promise<INotificationOutcome> {
    const quietHoursClass = quietHoursClassOf(candidate.type, candidate.priority);

    if (quietHoursClass === 'DELIVER') {
      // PHASE E: `evaluateAndDeliver` now short-circuits this class BEFORE the
      // fatigue guard, so this branch is reached only by a future caller that
      // enters here directly. Kept, and kept identical, because a gate whose
      // safety case depends on nobody ever calling it by a second door is a
      // gate with a second door.
      this.logger.log(
        `notification.quiet_hours_bypassed type=${candidate.type} audience=${candidate.targetAudience}`,
      );
      return this.deliverEvaluated(childId, familyId, candidate);
    }

    if (quietHoursClass === 'SUPPRESS') {
      // DROPPED WITH A LOGGED REASON. The log line is the deliverable: a
      // hydration nudge that is discarded because its premise expires overnight
      // is a decision, and a decision that leaves no trace is indistinguishable
      // from the bug.
      this.logger.log(
        `notification.quiet_hours_suppressed type=${candidate.type} audience=${candidate.targetAudience} reason=EXPIRES_OVERNIGHT`,
      );
      return {
        type: candidate.type,
        targetAudience: candidate.targetAudience,
        decision: 'SUPPRESS',
        reason: 'QUIET_HOURS_EXPIRES_OVERNIGHT',
      };
    }

    // DEFER. The scheduled instant is the next time THIS FAMILY'S wall clock
    // reads `quietHoursEnd`, read from tzdata at that instant — not `now + 9h`,
    // not the container's clock, and not midnight-plus-seven (which does not
    // exist on Africa/Cairo's spring-forward day).
    try {
      const scheduledFor = nextLocalTimeAfter(now, DEFAULT_FATIGUE_POLICY.quietHoursEnd, timeZone);
      const enqueuedId = await this.deferralRepository.enqueue({
        familyId,
        childId,
        type: candidate.type,
        category: notificationCategoryOf(candidate.type),
        priority: candidate.priority,
        targetAudience: candidate.targetAudience,
        title: candidate.title,
        body: candidate.body,
        // THE CAUSAL KEY, CARRIED UNCHANGED. This is the whole of «idempotency
        // survives defer -> deliver»: the key composed by the producer at 22:00
        // is the key inserted into `notifications` at 07:00, so a redelivery of
        // the same cause still collides with B9's unique index.
        sourceEventId: candidate.sourceEventId,
        // PHASE E (`PD-N-004`) — the payload travels with the message. See
        // `IDeliverableNotification.data`.
        data: candidate.data ?? null,
        deferReason: 'QUIET_HOURS',
        scheduledFor,
        businessDate: getBusinessDate(now, timeZone),
      });

      this.logger.log(
        `notification.deferred type=${candidate.type} audience=${candidate.targetAudience} ` +
          `scheduledFor=${scheduledFor.toISOString()} ${enqueuedId ? 'enqueued' : 'already_queued'}`,
      );
      return {
        type: candidate.type,
        targetAudience: candidate.targetAudience,
        decision: 'DEFER',
        // `ALREADY_DEFERRED` and `QUIET_HOURS` are different facts and the
        // caller's log line must be able to tell them apart: the first means a
        // redelivered cause found its own row already waiting.
        reason: enqueuedId ? 'QUIET_HOURS' : 'ALREADY_DEFERRED',
      };
    } catch (err) {
      this.logger.error(
        `notification.defer_failed type=${candidate.type} ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        type: candidate.type,
        targetAudience: candidate.targetAudience,
        decision: 'SUPPRESS',
        reason: 'DEFER_ENQUEUE_FAILED',
      };
    }
  }

  /**
   * The write plus the two outcomes it can have, shared by the immediate path
   * and the DELIVER-class quiet-hours bypass so that «the constraint refused
   * it» is reported identically in both.
   */
  private async deliverEvaluated(
    childId: string,
    familyId: string,
    candidate: IDeliverableNotification,
  ): Promise<INotificationOutcome> {
    try {
      const written = await this.deliverNow(childId, familyId, candidate);
      return written
        ? { type: candidate.type, targetAudience: candidate.targetAudience, decision: 'SEND' }
        : {
            type: candidate.type,
            targetAudience: candidate.targetAudience,
            decision: 'SUPPRESS',
            reason: 'ALREADY_NOTIFIED',
          };
    } catch (err) {
      this.logger.warn(
        `Failed to deliver Smart Notification (${candidate.type})`,
        err instanceof Error ? err.message : err,
      );
      return {
        type: candidate.type,
        targetAudience: candidate.targetAudience,
        decision: 'SUPPRESS',
        reason: 'DELIVERY_ERROR',
      };
    }
  }

  /** Routes a SEND-approved candidate to its correct real delivery
   * mechanism based on targetAudience — enforced structurally (CHILD
   * always goes through the approval-gated path).
   *
   * PHASE D — PUBLIC, so that `QuietHoursReleaseService` releases a deferred
   * notification through THIS EXACT METHOD rather than through a second copy of
   * the routing rules. There is one place a notification becomes a row, and a
   * deferred notification reaches it by the same door as an immediate one; that
   * is what «no second notification engine» means in code rather than in prose.
   */
  async deliverNow(
    childId: string,
    familyId: string,
    candidate: IDeliverableNotification,
    options: { deferPushToCaller?: boolean } = {},
  ): Promise<boolean> {
    if (candidate.targetAudience === 'PARENT') {
      return this.runtimeAlertRepository.createForFamilyOwner({
        familyId,
        childId,
        title: candidate.title,
        body: candidate.body,
        priority: candidate.priority === 'HIGH' || candidate.priority === 'LOW' ? 'NORMAL' : candidate.priority,
        type: candidate.type,
        // PHASE E (`PD-N-004`) — carried through to `notifications.data`
        // unchanged, which is where the parent app reads a wellbeing alert's
        // specifics.
        data: candidate.data,
        sourceEventId: candidate.sourceEventId,
        // PHASE D: only the release path sets this, and only because it owns a
        // durable retry the repository's best-effort push would otherwise burn.
        deferPushToCaller: options.deferPushToCaller,
      });
    }
    // B9 — the CHILD branch is protected too, and by the same kind of thing:
    // `child_messages (family_id, source_event_id)`. Phase A's §5 table listed
    // seven producer paths and marked all seven «قيد DB؟ ❌»; three of them
    // (badge-to-child, level-up-to-child, and any CHILD-targeted signal) land
    // here, not on `notifications`, so a fix that touched only one table would
    // have left them exactly as exposed as before while reporting success.
    // The `:child` facet keeps the child's row and the parent's row from
    // colliding when ONE event legitimately notifies both audiences.
    const drafted = await this.familyCommunication.draftAiMessageIfAbsent(
      childId,
      familyId,
      candidate.type,
      candidate.title,
      candidate.body,
      `${candidate.sourceEventId}:child`,
    );
    return drafted !== null;
  }
}
