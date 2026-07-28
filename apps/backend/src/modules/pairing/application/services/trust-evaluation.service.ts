import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  DEVICE_TRUST_REPOSITORY,
  type IDeviceTrustRepository,
} from '../ports/device-trust.repository.port';
import {
  PAIRING_EVENT_REPOSITORY,
  type IPairingEventRepository,
} from '../ports/pairing-event.repository.port';
import { PairingStateMachineService } from './pairing-state-machine.service';
import type {
  ITrustChangeRecord,
  ITrustEvaluationInput,
  ITrustSignalProvider,
  TrustLevelValue,
} from '../../domain/trust.types';
import type {
  IIntelligenceSignal,
  IIntelligenceSignalProvider,
} from '../../../ai-core/domain/intelligence-signal.types';

/** Confidence this specific trust LEVEL warrants, independent of the
 * evaluation that produced it — L1 is registered-but-unverified (low
 * confidence it reflects a genuinely trustworthy device), L3 has
 * cryptographic hardware proof (near-certain). Distinct from Risk's
 * confidence (§ RiskEvaluationService), which reflects calculation
 * exactness rather than identity-verification strength. */
const TRUST_LEVEL_CONFIDENCE: Record<TrustLevelValue, number> = {
  L0_UNKNOWN: 0,
  L1_REGISTERED: 0.4,
  L2_VERIFIED: 0.7,
  L3_ATTESTED: 0.95,
  L4_ENTERPRISE: 1,
  L5_HIGH_TRUST: 1,
};

/**
 * Service 4 (Sprint 2). Per the reviewer's explicit framing: Trust is not
 * built as closed logic — it's built to BE a data source. Concretely,
 * that means:
 *   - Every level change is recorded with a human-readable `reason`
 *     (Decision-047's explainability, applied here), not just a bare
 *     enum transition — this is exactly what a future AI consumer needs
 *     to answer "why did trust drop" (Sprint 2's own framing).
 *   - This class implements `ITrustSignalProvider`
 *     (domain/trust.types.ts) — a future AI Core consumer depends on
 *     that interface (bound via the `TRUST_SIGNAL_PROVIDER` token in
 *     pairing.module.ts), not on this class directly.
 *
 * Per Decision-043 (Trust is static): this service is invoked at
 * specific pairing-lifecycle moments (registration, verification,
 * enterprise provisioning) — never on a routine schedule/heartbeat.
 */
@Injectable()
export class TrustEvaluationService implements ITrustSignalProvider, IIntelligenceSignalProvider {
  private readonly logger = new Logger(TrustEvaluationService.name);

  constructor(
    @Inject(DEVICE_TRUST_REPOSITORY) private readonly deviceTrustRepository: IDeviceTrustRepository,
    @Inject(PAIRING_EVENT_REPOSITORY) private readonly pairingEventRepository: IPairingEventRepository,
    private readonly pairingStateMachine: PairingStateMachineService,
  ) {}

  /**
   * Computes the new trust level, persists it to Device.trustLevel if it
   * changed, and — only if it changed — records a DEVICE_TRUST_CHANGED
   * event (via the shared audit trail, not a bespoke one) with an
   * explicit human-readable reason. Returns the resulting level either way.
   */
  async evaluateAndApply(input: ITrustEvaluationInput): Promise<TrustLevelValue> {
    const newLevel = this.deriveTrustLevel(input);
    const currentLevel = await this.deviceTrustRepository.getTrustLevel(input.deviceId);

    if (newLevel === currentLevel) {
      return newLevel;
    }

    await this.deviceTrustRepository.updateTrustLevel(input.deviceId, newLevel);

    const reason = this.explainChange(newLevel, input);

    await this.pairingStateMachine.transition({
      childId: input.childId,
      deviceId: input.deviceId,
      event: 'DEVICE_TRUST_CHANGED',
      actorType: 'SYSTEM',
      metadata: { fromLevel: currentLevel, toLevel: newLevel, reason },
    });

    this.logger.log(
      `Trust level changed: ${currentLevel ?? '(none)'} -> ${newLevel} ` +
        `[device=${input.deviceId}] reason="${reason}"`,
    );

    return newLevel;
  }

  // --- ITrustSignalProvider ---

  getCurrentTrustLevel(deviceId: string): Promise<TrustLevelValue | null> {
    return this.deviceTrustRepository.getTrustLevel(deviceId);
  }

  async getTrustHistory(childId: string): Promise<ITrustChangeRecord[]> {
    const events = await this.pairingEventRepository.findByEventType(
      childId,
      'DEVICE_TRUST_CHANGED',
    );

    return events.map((event) => {
      const metadata = (event as unknown as { metadata?: Record<string, unknown> }).metadata ?? {};
      return {
        deviceId: event.deviceId ?? '',
        childId: event.childId,
        fromLevel: (metadata.fromLevel as TrustLevelValue) ?? null,
        toLevel: (metadata.toLevel as TrustLevelValue) ?? (event.toState as TrustLevelValue),
        reason: (metadata.reason as string) ?? 'No reason recorded.',
        pairingStateAtChange: event.toState as ITrustChangeRecord['pairingStateAtChange'],
        occurredAt: event.occurredAt,
      };
    });
  }

  // --- IIntelligenceSignalProvider (Decision-070) ---

  /**
   * `subjectId` here is childId, not deviceId — consistent with
   * Decision-066's rule that a child's intelligence timeline is the
   * coherent, queryable unit (a device replacement continues the same
   * childId-scoped signal stream, not a disconnected new one).
   */
  async getSignals(childId: string): Promise<IIntelligenceSignal[]> {
    const history = await this.getTrustHistory(childId);
    if (history.length === 0) {
      return [];
    }

    const latest = history[history.length - 1];
    return [
      {
        domain: 'TRUST',
        subjectId: childId,
        value: { deviceId: latest.deviceId, trustLevel: latest.toLevel },
        confidence: TRUST_LEVEL_CONFIDENCE[latest.toLevel],
        reasons: [latest.reason],
        assessedAt: latest.occurredAt,
      },
    ];
  }

  // --- Pure derivation logic (trust-levels-framework.md §2/§3) ---

  private deriveTrustLevel(input: ITrustEvaluationInput): TrustLevelValue {
    if (input.isDeviceOwnerProvisioned) {
      return 'L4_ENTERPRISE';
    }
    if (input.stage === 'REGISTERED') {
      return 'L1_REGISTERED';
    }
    // stage === 'VERIFIED'
    return input.hasValidAttestation ? 'L3_ATTESTED' : 'L2_VERIFIED';
  }

  private explainChange(toLevel: TrustLevelValue, input: ITrustEvaluationInput): string {
    switch (toLevel) {
      case 'L4_ENTERPRISE':
        return 'Device provisioned as Device Owner (Enhanced Mode).';
      case 'L3_ATTESTED':
        return 'Key Attestation chain verified against the device public key.';
      case 'L2_VERIFIED':
        return 'Device verification completed; no hardware attestation available on this device.';
      case 'L1_REGISTERED':
        return 'Device registered.';
      default:
        return 'Trust level updated.';
    }
  }
}
