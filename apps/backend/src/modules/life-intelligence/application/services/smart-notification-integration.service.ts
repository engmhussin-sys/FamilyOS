import { Inject, Injectable, Logger } from '@nestjs/common';

import { RUNTIME_ALERT_REPOSITORY, type IRuntimeAlertRepository } from '../../../pairing/application/ports/runtime-alert.repository.port';
import { NOTIFICATION_REPOSITORY, type INotificationRepository } from '../../../notifications/application/ports/notification.repository.port';
import { FamilyCommunicationService } from './family-communication.service';
import { evaluateSmartNotificationCandidates, type ISmartNotificationSignals } from './smart-notification-decision-engine';
import { evaluateFatigue, type ICandidateNotification, type IRecentNotification } from './notification-fatigue-guard';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { getBusinessTimeHHMM, getStartOfBusinessDay } from '../../../../common/time/family-date';
import { forRecurringSignal } from '../../../../shared/notifications/notification-source-key';

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

    const history = await this.fetchHistory(childId);
    const outcomes: INotificationOutcome[] = [];
    // B9 — ONE `now` for the whole batch, so two candidates evaluated in the
    // same call cannot land in two different dedupe buckets because a
    // millisecond passed between them.
    const now = new Date();

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
  async notifyEvent(childId: string, familyId: string, candidate: IDeliverableNotification): Promise<INotificationOutcome> {
    const history = await this.fetchHistory(childId);
    return this.evaluateAndDeliver(childId, familyId, candidate, history, new Date());
  }

  private async fetchHistory(childId: string): Promise<IRecentNotification[]> {
    const since = new Date(Date.now() - HISTORY_WINDOW_HOURS * 60 * 60 * 1000);
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

    const decision = evaluateFatigue(candidate, history, now, currentLocalTime, businessDayStart);

    if (!decision.allowed) {
      // QUIET_HOURS means "still valid, just not right now" —
      // everything else means "this specific occurrence should not
      // be sent at all."
      const isDeferrable = decision.blockedReason === 'QUIET_HOURS';
      return {
        type: candidate.type,
        targetAudience: candidate.targetAudience,
        decision: isDeferrable ? 'DEFER' : 'SUPPRESS',
        reason: decision.blockedReason,
      };
    }

    try {
      const written = await this.deliver(childId, familyId, candidate);
      // B9 — «the constraint refused it» is a real, reportable outcome, and it
      // is a SUPPRESS rather than a SEND. Reporting SEND for a row the
      // database rejected would put a lie in the log line
      // `NotificationRewardConsumer` writes, and that log line is how the
      // redelivery behaviour is observed in production.
      return written
        ? { type: candidate.type, targetAudience: candidate.targetAudience, decision: 'SEND' }
        : { type: candidate.type, targetAudience: candidate.targetAudience, decision: 'SUPPRESS', reason: 'ALREADY_NOTIFIED' };
    } catch (err) {
      this.logger.warn(`Failed to deliver Smart Notification (${candidate.type})`, err instanceof Error ? err.message : err);
      // Deliberately still returns a real outcome object (not a
      // thrown error) — a delivery failure is reported, not
      // propagated, matching this service's own "never block the
      // caller's real business logic" discipline throughout.
      return { type: candidate.type, targetAudience: candidate.targetAudience, decision: 'SUPPRESS', reason: 'DELIVERY_ERROR' };
    }
  }

  /** Routes a SEND-approved candidate to its correct real delivery
   * mechanism based on targetAudience — enforced structurally (CHILD
   * always goes through the approval-gated path). */
  private async deliver(childId: string, familyId: string, candidate: IDeliverableNotification): Promise<boolean> {
    if (candidate.targetAudience === 'PARENT') {
      return this.runtimeAlertRepository.createForFamilyOwner({
        familyId,
        childId,
        title: candidate.title,
        body: candidate.body,
        priority: candidate.priority === 'HIGH' || candidate.priority === 'LOW' ? 'NORMAL' : candidate.priority,
        type: candidate.type,
        sourceEventId: candidate.sourceEventId,
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
