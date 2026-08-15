import { Inject, Injectable, Logger } from '@nestjs/common';

import { RUNTIME_ALERT_REPOSITORY, type IRuntimeAlertRepository } from '../../../pairing/application/ports/runtime-alert.repository.port';
import { NOTIFICATION_REPOSITORY, type INotificationRepository } from '../../../notifications/application/ports/notification.repository.port';
import { FamilyCommunicationService } from './family-communication.service';
import { evaluateSmartNotificationCandidates, type ISmartNotificationSignals } from './smart-notification-decision-engine';
import { evaluateFatigue, type ICandidateNotification, type IRecentNotification } from './notification-fatigue-guard';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { getBusinessTimeHHMM, getStartOfBusinessDay } from '../../../../common/time/family-date';

export interface INotificationOutcome {
  type: string;
  targetAudience: 'PARENT' | 'CHILD';
  decision: 'SEND' | 'DEFER' | 'SUPPRESS';
  reason?: string;
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

    for (const candidate of candidates) {
      const outcome = await this.evaluateAndDeliver(childId, familyId, candidate, history);
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
  async notifyEvent(childId: string, familyId: string, candidate: ICandidateNotification): Promise<INotificationOutcome> {
    const history = await this.fetchHistory(childId);
    return this.evaluateAndDeliver(childId, familyId, candidate, history);
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
    candidate: ICandidateNotification,
    history: IRecentNotification[],
  ): Promise<INotificationOutcome> {
    const now = new Date();
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
      await this.deliver(childId, familyId, candidate);
      return { type: candidate.type, targetAudience: candidate.targetAudience, decision: 'SEND' };
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
  private async deliver(childId: string, familyId: string, candidate: ICandidateNotification): Promise<void> {
    if (candidate.targetAudience === 'PARENT') {
      await this.runtimeAlertRepository.createForFamilyOwner({
        familyId,
        childId,
        title: candidate.title,
        body: candidate.body,
        priority: candidate.priority === 'HIGH' || candidate.priority === 'LOW' ? 'NORMAL' : candidate.priority,
        type: candidate.type,
      });
    } else {
      await this.familyCommunication.draftAiMessage(childId, familyId, candidate.type, candidate.title, candidate.body);
    }
  }
}
