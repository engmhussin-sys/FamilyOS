import { Inject, Injectable } from '@nestjs/common';

import {
  RUNTIME_ALERT_REPOSITORY,
  type IRuntimeAlertRepository,
} from '../ports/runtime-alert.repository.port';

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
      await this.runtimeAlertRepository.createForFamilyOwner({
        familyId: input.familyId,
        childId: input.childId,
        title: 'Protection turned off',
        body: 'Device protection (Accessibility Service) was disabled.',
        data: { alertType: 'ACCESSIBILITY_DISABLED' },
      });
    }
  }
}
