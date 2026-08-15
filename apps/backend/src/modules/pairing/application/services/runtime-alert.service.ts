import { Inject, Injectable } from '@nestjs/common';

import {
  RUNTIME_ALERT_REPOSITORY,
  type IRuntimeAlertRepository,
} from '../ports/runtime-alert.repository.port';
import { forRecurringSignal } from '../../../../shared/notifications/notification-source-key';

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
}
