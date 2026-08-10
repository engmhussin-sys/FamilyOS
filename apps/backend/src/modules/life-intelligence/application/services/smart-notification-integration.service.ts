import { Inject, Injectable, Logger } from '@nestjs/common';

import { RUNTIME_ALERT_REPOSITORY, type IRuntimeAlertRepository } from '../../../pairing/application/ports/runtime-alert.repository.port';
import { NOTIFICATION_REPOSITORY, type INotificationRepository } from '../../../notifications/application/ports/notification.repository.port';
import { FamilyCommunicationService } from './family-communication.service';
import { evaluateSmartNotificationCandidates, type ISmartNotificationSignals } from './smart-notification-decision-engine';
import { evaluateFatigue, type ICandidateNotification } from './notification-fatigue-guard';

export interface INotificationOutcome {
  type: string;
  targetAudience: 'PARENT' | 'CHILD';
  decision: 'SEND' | 'DEFER' | 'SUPPRESS';
  reason?: string;
}

const HISTORY_WINDOW_HOURS = 24;

/**
 * Sprint 16.1 Phase 3 (Smart Notification Integration) — CLOSES A
 * REAL GAP: SmartNotificationDecisionEngine and NotificationFatigueGuard
 * (both built and tested in Sprint 16) existed only as pure functions
 * with zero real caller — nothing ever actually invoked them against
 * real data or delivered a real notification. This is that missing
 * wiring: the ONLY real entry point from a signal to an actual
 * delivered notification.
 *
 * Deliberately reuses existing infrastructure rather than building a
 * new one, per the brief's own explicit instruction:
 * - IRuntimeAlertRepository.createForFamilyOwner for PARENT-targeted
 *   candidates — already has Owner Resolution, real Deduplication,
 *   and real Push Notification delivery.
 * - FamilyCommunicationService.draftAiMessage for CHILD-targeted
 *   candidates — already enforces the hard "no AI/system content
 *   reaches a child without parent approval" rule via
 *   MessageApprovalStatus (Architecture 1.0 §5.8). This integration
 *   layer NEVER bypasses that gate.
 *
 * The pure decision logic itself is NOT reimplemented here — imported
 * and called exactly as already tested (28/28 tests, Sprint 16).
 */
@Injectable()
export class SmartNotificationIntegrationService {
  private readonly logger = new Logger(SmartNotificationIntegrationService.name);

  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly notificationRepository: INotificationRepository,
    @Inject(RUNTIME_ALERT_REPOSITORY) private readonly runtimeAlertRepository: IRuntimeAlertRepository,
    private readonly familyCommunication: FamilyCommunicationService,
  ) {}

  /** The single real entry point: signal snapshot in, real outcomes
   * out. Never throws for an individual candidate's failure — one
   * candidate's delivery issue must never block evaluating or
   * delivering the others. */
  async processSignals(childId: string, familyId: string, signals: ISmartNotificationSignals): Promise<INotificationOutcome[]> {
    const candidates = evaluateSmartNotificationCandidates(signals);
    if (candidates.length === 0) return [];

    const since = new Date(Date.now() - HISTORY_WINDOW_HOURS * 60 * 60 * 1000);
    const rawHistory = await this.notificationRepository.findRecentForChild(childId, since);
    // Safe narrowing: every writer of Notification.priority uses this
    // exact union (schema's own open-string design, per its
    // docstring, means TypeScript can't narrow it automatically) —
    // an unexpected stored value defensively falls back to NORMAL
    // rather than crashing the whole evaluation.
    const KNOWN_PRIORITIES = new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);
    const history = rawHistory.map((n) => ({
      type: n.type,
      priority: (KNOWN_PRIORITIES.has(n.priority) ? n.priority : 'NORMAL') as 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW',
      createdAt: n.createdAt,
    }));
    const now = new Date();
    const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const outcomes: INotificationOutcome[] = [];

    for (const candidate of candidates) {
      const decision = evaluateFatigue(candidate, history, now, currentLocalTime);

      if (!decision.allowed) {
        // Sprint 16.1 Phase 3 — CLOSES A REAL GAP: the brief's own
        // required three-way decision (SEND/DEFER/SUPPRESS).
        // QUIET_HOURS means "still valid, just not right now" —
        // everything else means "this specific occurrence should not
        // be sent at all."
        const isDeferrable = decision.blockedReason === 'QUIET_HOURS';
        outcomes.push({
          type: candidate.type,
          targetAudience: candidate.targetAudience,
          decision: isDeferrable ? 'DEFER' : 'SUPPRESS',
          reason: decision.blockedReason,
        });
        continue;
      }

      try {
        await this.deliver(childId, familyId, candidate);
        outcomes.push({ type: candidate.type, targetAudience: candidate.targetAudience, decision: 'SEND' });
        // Feeds back into the SAME history array used by subsequent
        // candidates in this same batch — two candidates matching in
        // one call must each be correctly counted against
        // dailyMax/categoryMax for the other.
        history.unshift({ type: candidate.type, priority: candidate.priority, createdAt: now });
      } catch (err) {
        this.logger.warn(`Failed to deliver Smart Notification (${candidate.type})`, err instanceof Error ? err.message : err);
      }
    }

    return outcomes;
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
