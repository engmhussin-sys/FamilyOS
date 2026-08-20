import { Inject, Injectable } from '@nestjs/common';

import {
  RUNTIME_ALERT_REPOSITORY,
  type IRuntimeAlertRepository,
} from '../ports/runtime-alert.repository.port';
import { forEntity, forRecurringSignal } from '../../../../shared/notifications/notification-source-key';

/**
 * Sprint 6. Transition-based, not level-based: an alert fires only when
 * `accessibilityServiceEnabled` flips from true to false between two
 * heartbeats — not on every heartbeat where it happens to be false
 * (which would spam a notification every ~30 seconds per HeartbeatService's
 * interval). The caller (PairingOrchestratorService.recordHeartbeat)
 * supplies both the previous and new values; this service owns only the
 * decision of whether that comparison warrants an alert.
 */
@Injectable()
export class RuntimeAlertService {
  constructor(
    @Inject(RUNTIME_ALERT_REPOSITORY) private readonly runtimeAlertRepository: IRuntimeAlertRepository,
  ) {}

  async evaluateTransition(input: {
    familyId: string;
    childId: string;
    previousAccessibilityEnabled: boolean | null;
    currentAccessibilityEnabled: boolean | null;
  }): Promise<void> {
    const wasEnabled = input.previousAccessibilityEnabled;
    const isEnabled = input.currentAccessibilityEnabled;

    // Only a genuine true -> false transition triggers an alert. `null`
    // (never reported before) is deliberately NOT treated as "was
    // enabled" — there's nothing to have transitioned FROM yet.
    if (wasEnabled === true && isEnabled === false) {
      // B9 (PA-B-007 / PA-B-008) — producer 7 of 7, and one of the two that
      // bypass `NotificationFatigueGuard` entirely (deliberately: a CRITICAL
      // protection alert must not be swallowed by a daily cap). Bypassing the
      // guard used to mean bypassing the ONLY dedupe there was; it now means
      // bypassing the guard while the constraint still holds underneath.
      //
      // THE BUCKETED FORM, because this is a recurring observation: a device
      // whose Accessibility Service is turned off again next week is a NEW
      // thing worth alerting about, so the key cannot be `(child, type)` alone
      // or the second real incident would be silently dropped. Five minutes is
      // the same width `PrismaRuntimeAlertRepository`'s own sliding window
      // uses, so the two agree by construction rather than by coincidence.
      await this.runtimeAlertRepository.createForFamilyOwner({
        familyId: input.familyId,
        childId: input.childId,
        title: 'Protection turned off',
        body: 'Device protection (Accessibility Service) was disabled.',
        data: { alertType: 'ACCESSIBILITY_DISABLED' },
        priority: 'CRITICAL',
        sourceEventId: forRecurringSignal('runtime', input.childId, 'ACCESSIBILITY_DISABLED', new Date()),
      });
    }
  }

  /**
   * A CHILD'S DEVICE WAS UNLINKED FROM THE FAMILY.
   *
   * IT LIVES HERE AND NOT IN `PairingOrchestratorService`, and that is a
   * structural answer rather than a stylistic one.
   * `notification-engine-bypass.guard.spec.ts` RULE B1 requires every producer
   * that reaches `createForFamilyOwner` to be inside the Smart Notification
   * Engine or on a reviewed allow-list; this service is already on it,
   * classified SYSTEM. Calling the repository straight from the orchestrator
   * would have needed a SECOND allow-list entry, for the same module and the
   * same kind of fact — which is how an allow-list stops being an audit trail.
   * So the module keeps ONE alerting facade, and this is its second alert.
   *
   * WHY A PARENT-INITIATED ACTION IS WORTH A NOTIFICATION AT ALL. The family has
   * two co-equal parents (`@ParentSurface`), and one of them unlinking a child's
   * device is exactly the change the other must not discover by noticing the
   * child has been unmonitored for a week. It is also the human-readable half of
   * the audit trail: the `DevicePairingEvent` row records who and why, and
   * nobody reads that table from a phone.
   *
   * NOT CRITICAL, deliberately. Unlike the accessibility alert above, nothing is
   * being defeated here — a parent did this on purpose — so it takes the generic
   * `RUNTIME_ALERT` type, already classified DEFER/SYSTEM, and does not wake a
   * household at 03:00 to report a decision one of them made at 02:59.
   *
   * `forEntity`, NOT `forRecurringSignal`: a device can be revoked exactly once
   * (REVOKED's only exit is REMOVED), so the pair (child, device) IS the
   * identity of this fact. That makes a duplicate structurally impossible under
   * `notifications (family_id, source_event_id, user_id)` rather than merely
   * improbable within a five-minute bucket.
   */
  async deviceRevoked(input: {
    familyId: string;
    childId: string;
    deviceId: string;
    reason?: string;
  }): Promise<void> {
    await this.runtimeAlertRepository.createForFamilyOwner({
      familyId: input.familyId,
      childId: input.childId,
      title: 'Device unlinked',
      body: "A child's device was unlinked from this family and no longer has access.",
      data: {
        alertType: 'DEVICE_REVOKED',
        deviceId: input.deviceId,
        ...(input.reason ? { reason: input.reason } : {}),
      },
      priority: 'HIGH',
      sourceEventId: forEntity('runtime', input.childId, input.deviceId, 'DEVICE_REVOKED'),
    });
  }
}
