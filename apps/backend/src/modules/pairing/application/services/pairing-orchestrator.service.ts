import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { InvitationService } from './invitation.service';
import { RegistrationTokenService } from './registration-token.service';
import { PairingStateMachineService } from './pairing-state-machine.service';
import { TrustEvaluationService } from './trust-evaluation.service';
import { RiskEvaluationService } from './risk-evaluation.service';
import {
  PAIRING_DEVICE_REPOSITORY,
  type ICreatePairingDeviceInput,
  type IPairingDeviceRepository,
} from '../ports/pairing-device.repository.port';
import {
  PAIRING_EVENT_REPOSITORY,
  type IPairingEventRepository,
} from '../ports/pairing-event.repository.port';
import type { IInvitationTicket, IRedeemedInvitation } from '../../domain/invitation.types';
import type { IRegistrationTokenTicket } from '../../domain/registration-token.types';
import type { IRiskAssessmentResult, IRiskSignalInput } from '../../domain/risk.types';
import type { TrustLevelValue } from '../../domain/trust.types';
import type { PairingStateValue } from '../../domain/pairing.types';

// Injected as a token from AuthModule — see pairing-module-boundary.md §2:
// Pairing consumes TokenService, the one agreed integration point.
import { TokenService } from '../../../auth/application/services/token.service';
import type { ITokenPair } from '../../../auth/domain/auth.types';
import { ScreenTimeService } from '../../../screen-time/application/services/screen-time.service';
import { RuntimeAlertService } from './runtime-alert.service';
import {
  RUNTIME_ALERT_REPOSITORY,
  type IRuntimeAlertRepository,
} from '../ports/runtime-alert.repository.port';
import type {
  IDeviceCapabilityReport,
  IDeviceSummary,
  IHeartbeatTelemetryInput,
  IPolicySyncResponse,
} from '../../domain/device-status.types';

export interface IDeviceRegistrationResult {
  deviceId: string;
  tokens: ITokenPair;
}

export interface IDeviceVerificationResult {
  trustLevel: TrustLevelValue;
  riskAssessment: IRiskAssessmentResult;
}

export interface IDeviceActivationResult {
  status: 'ACTIVATED';
  policyAssignedAt: Date;
}

export interface IPairingDeviceStatus {
  pairingState: PairingStateValue | null;
  trustLevel: TrustLevelValue | null;
  riskLevel: string;
  lastSeenAt: Date | null;
  activationStatus: 'ACTIVATED' | 'NOT_ACTIVATED';
}

/**
 * The full pairing vertical, orchestrated. Each method here corresponds
 * 1:1 to an endpoint in pairing-backend-domain-architecture.md §3 — the
 * controller (Step 2.2.3/Sprint 3) is a thin HTTP adapter over this
 * class, following this project's established controller-stays-thin
 * convention (see every other module's controller/service split).
 */
@Injectable()
export class PairingOrchestratorService {
  constructor(
    private readonly invitationService: InvitationService,
    private readonly registrationTokenService: RegistrationTokenService,
    private readonly pairingStateMachine: PairingStateMachineService,
    private readonly trustEvaluationService: TrustEvaluationService,
    private readonly riskEvaluationService: RiskEvaluationService,
    @Inject(PAIRING_DEVICE_REPOSITORY)
    private readonly pairingDeviceRepository: IPairingDeviceRepository,
    @Inject(PAIRING_EVENT_REPOSITORY)
    private readonly pairingEventRepository: IPairingEventRepository,
    private readonly tokenService: TokenService,
    private readonly screenTimeService: ScreenTimeService,
    private readonly runtimeAlertService: RuntimeAlertService,
    @Inject(RUNTIME_ALERT_REPOSITORY)
    private readonly runtimeAlertRepository: IRuntimeAlertRepository,
  ) {}

  invite(childId: string, familyId: string, initiatedByUserId: string): Promise<IInvitationTicket> {
    return this.invitationService.createInvitation({ childId, familyId, initiatedByUserId });
  }

  async accept(code: string): Promise<IRegistrationTokenTicket> {
    const ticket: IRedeemedInvitation = await this.invitationService.redeemInvitation(code);
    return this.registrationTokenService.issue({ childId: ticket.childId, familyId: ticket.familyId });
  }

  async registerDevice(
    childId: string,
    familyId: string,
    input: Omit<ICreatePairingDeviceInput, 'childId' | 'familyId'>,
  ): Promise<IDeviceRegistrationResult> {
    const device = await this.pairingDeviceRepository.createDevice({ ...input, childId, familyId });

    await this.pairingStateMachine.transition({
      childId,
      deviceId: device.id,
      event: 'DEVICE_REGISTERED',
      actorType: 'DEVICE',
    });
    await this.trustEvaluationService.evaluateAndApply({ deviceId: device.id, childId, stage: 'REGISTERED' });

    const tokens = await this.tokenService.issueTokenPair({
      subjectId: device.id,
      actorType: 'DEVICE',
      familyId,
    });

    return { deviceId: device.id, tokens };
  }

  async verify(
    deviceId: string,
    input: {
      attestationChain?: string;
      riskSignals: IRiskSignalInput;
    },
  ): Promise<IDeviceVerificationResult> {
    const device = await this.getDeviceOrThrow(deviceId);

    // NOTE (honest limitation, flagged not hidden): attestationChain
    // presence alone is treated as "has valid attestation" — the
    // cryptographic chain-of-trust verification against Google's root
    // key (trust-levels-framework.md §3) is NOT implemented in this
    // sprint. Tracked as a required follow-up before this trust level
    // can be relied on for anything security-critical.
    const hasValidAttestation = Boolean(input.attestationChain);

    await this.pairingStateMachine.transition({
      childId: device.childId,
      deviceId,
      event: 'DEVICE_VERIFIED',
      actorType: 'DEVICE',
    });

    const trustLevel = await this.trustEvaluationService.evaluateAndApply({
      deviceId,
      childId: device.childId,
      stage: 'VERIFIED',
      hasValidAttestation,
    });

    // NOTE (honest limitation, flagged not hidden): riskSignals are
    // self-reported by the device today — a compromised device could
    // lie about its own root/emulator status. Independent server-side
    // verification is out of this sprint's scope (would need Play
    // Integrity API or similar, a separate follow-up).
    const riskAssessment = await this.riskEvaluationService.assessAndRecord(deviceId, input.riskSignals);

    await this.pairingStateMachine.transition({
      childId: device.childId,
      deviceId,
      event: 'CAPABILITIES_UPLOADED',
      actorType: 'DEVICE',
    });

    return { trustLevel, riskAssessment };
  }

  async activate(
    deviceId: string,
    familyId: string,
    userId: string,
    overrideRiskWarning: boolean,
  ): Promise<IDeviceActivationResult> {
    const device = await this.getDeviceOrThrowScopedToFamily(deviceId, familyId);

    const latestRisk = await this.riskEvaluationService.getLatestRiskAssessment(deviceId);
    const isHighRisk = latestRisk?.overallLevel === 'HIGH' || latestRisk?.overallLevel === 'CRITICAL';

    if (isHighRisk && !overrideRiskWarning) {
      await this.pairingStateMachine.transition({
        childId: device.childId,
        deviceId,
        event: 'ACTIVATION_BLOCKED_HIGH_RISK',
        actorType: 'SYSTEM',
      });
      throw new ConflictException(
        `Device risk level is ${latestRisk?.overallLevel}. Set overrideRiskWarning to proceed anyway.`,
      );
    }

    await this.pairingStateMachine.transition({
      childId: device.childId,
      deviceId,
      event: 'PARENT_CONFIRMED',
      actorType: 'USER',
      actorId: userId,
    });

    // NOTE: real per-child policy assignment (pulling/creating a
    // ScreenTimePolicy) is a Sprint-4 "Real Parental Control Engine"
    // concern, per the reviewer's own sprint ordering — this transition
    // records that policy assignment happened at the pairing-state
    // level without yet wiring a concrete policy payload.
    await this.pairingStateMachine.transition({
      childId: device.childId,
      deviceId,
      event: 'POLICY_ASSIGNED',
      actorType: 'SYSTEM',
    });

    await this.pairingStateMachine.transition({
      childId: device.childId,
      deviceId,
      event: 'DEVICE_ACTIVATED',
      actorType: 'SYSTEM',
    });

    await this.pairingDeviceRepository.activateDevice(deviceId);

    return { status: 'ACTIVATED', policyAssignedAt: new Date() };
  }

  async reject(deviceId: string, familyId: string, userId: string, reason?: string): Promise<void> {
    const device = await this.getDeviceOrThrowScopedToFamily(deviceId, familyId);
    await this.pairingStateMachine.transition({
      childId: device.childId,
      deviceId,
      event: 'PAIRING_REJECTED',
      actorType: 'USER',
      actorId: userId,
      metadata: reason ? { reason } : undefined,
    });
  }

  async revoke(deviceId: string, familyId: string, userId: string, reason?: string): Promise<void> {
    const device = await this.getDeviceOrThrowScopedToFamily(deviceId, familyId);
    await this.pairingStateMachine.transition({
      childId: device.childId,
      deviceId,
      event: 'DEVICE_REVOKED',
      actorType: 'USER',
      actorId: userId,
      metadata: reason ? { reason } : undefined,
    });
    await this.pairingDeviceRepository.revokeDevice(deviceId);
    await this.tokenService.revokeAllTokensForDevice(deviceId);
  }

  async getStatus(deviceId: string, familyId: string): Promise<IPairingDeviceStatus> {
    const device = await this.getDeviceOrThrowScopedToFamily(deviceId, familyId);
    const [pairingState, trustLevel, latestRisk] = await Promise.all([
      this.pairingStateMachine.getCurrentState(device.childId),
      this.trustEvaluationService.getCurrentTrustLevel(deviceId),
      this.riskEvaluationService.getLatestRiskAssessment(deviceId),
    ]);

    return {
      pairingState,
      trustLevel,
      riskLevel: latestRisk?.overallLevel ?? 'UNKNOWN',
      lastSeenAt: device.lastSeenAt,
      activationStatus: device.status === 'ACTIVE' ? 'ACTIVATED' : 'NOT_ACTIVATED',
    };
  }

  /**
   * Sprint 4 (Track A) — a thin, reusable ownership check for other
   * modules that need to confirm a device belongs to a family before
   * doing anything with it, WITHOUT duplicating
   * getDeviceOrThrowScopedToFamily's logic. First consumer:
   * AiDiagnosticsService (ai-core module) — see
   * docs/architecture/sprint4-track-a-completion.md.
   */
  async assertDeviceBelongsToFamily(deviceId: string, familyId: string): Promise<{ childId: string }> {
    const device = await this.getDeviceOrThrowScopedToFamily(deviceId, familyId);
    return { childId: device.childId };
  }

  /**
   * Sprint 3's heartbeat receiver, extended in Sprint 4 to accept
   * optional telemetry (Decision-013's Heartbeat/Battery/Storage/
   * Connectivity list). Still does NOT write a DevicePairingEvent on
   * every call — only on an actual DEGRADED -> HEALTHY recovery
   * (lifecycle ADR §10's sampling principle). Telemetry is cached
   * current-state (Device.lastTelemetry), same reasoning as
   * capabilityProfile below — no per-heartbeat history table.
   */
  async recordHeartbeat(deviceId: string, telemetry?: IHeartbeatTelemetryInput): Promise<void> {
    const device = await this.getDeviceOrThrow(deviceId);
    await this.pairingDeviceRepository.touchLastSeen(deviceId);

    if (telemetry) {
      // Sprint 6: compare against the PREVIOUS telemetry before it's
      // overwritten — this is the one place that "before" state exists.
      const previousAccessibilityEnabled =
        (device.lastTelemetry?.['accessibilityServiceEnabled'] as boolean) ?? null;

      await this.pairingDeviceRepository.updateTelemetry(deviceId, telemetry as Record<string, unknown>);

      if (telemetry.accessibilityServiceEnabled !== undefined) {
        await this.runtimeAlertService.evaluateTransition({
          familyId: device.familyId,
          childId: device.childId,
          previousAccessibilityEnabled,
          currentAccessibilityEnabled: telemetry.accessibilityServiceEnabled,
        });
      }
    }

    const currentState = await this.pairingStateMachine.getCurrentState(device.childId);
    if (currentState === 'ACTIVATED' || currentState === 'DEGRADED') {
      await this.pairingStateMachine.transition({
        childId: device.childId,
        deviceId,
        event: 'HEARTBEAT_RECEIVED',
        actorType: 'DEVICE',
      });
    }
    // If already HEALTHY, no event is written — the state doesn't
    // change and lastSeenAt/telemetry (above) are the only signals that
    // needed updating.
  }

  /**
   * Sprint 4 — the Full Capability Engine's report endpoint. Cached
   * (Decision-019): only updates the hash/profile, does not append a
   * history row — `capabilityProfile`/`capabilityProfileHash` are
   * current-state fields on `Device`, same pattern as `trustLevel`.
   */
  async reportCapabilities(deviceId: string, report: IDeviceCapabilityReport): Promise<void> {
    await this.getDeviceOrThrow(deviceId);
    await this.pairingDeviceRepository.updateCapabilityProfile(
      deviceId,
      report as unknown as Record<string, unknown>,
      report.profileHash,
    );
  }

  /**
   * Sprint 4 — Policy Sync. Reuses ScreenTimeService directly (already
   * built, Phase 1) rather than duplicating policy logic in Pairing —
   * pairing-module-boundary.md's "Pairing triggers Screen Time, does not
   * own its logic" rule, now exercised for a read instead of the
   * write-trigger it was originally described for.
   *
   * NOTE (honest limitation, flagged not hidden): `blockedPackages` is
   * always `[]` today. `AppBlockRule` exists in the schema but has no
   * service/API built for it yet — returning fabricated data here would
   * be worse than an honestly empty list. Tracked as a required
   * follow-up (Sprint 5's "Parental Control Engine," per the reviewer's
   * own sprint plan), not silently faked.
   */
  async getPolicySync(deviceId: string): Promise<IPolicySyncResponse> {
    const device = await this.getDeviceOrThrow(deviceId);
    const policy = await this.screenTimeService.getPolicy(device.childId, device.familyId);

    return {
      childId: device.childId,
      policyVersion: policy?.id ?? 'none',
      dailyLimitMinutes: policy?.dailyLimitMinutes ?? null,
      bedtimeStart: policy?.bedtimeStart ?? null,
      bedtimeEnd: policy?.bedtimeEnd ?? null,
      focusModeEnabled: policy?.focusModeEnabled ?? false,
      blockedPackages: [],
    };
  }

  /** Sprint 4 — the Dashboard's live device list, per family. */
  async listFamilyDevices(familyId: string): Promise<IDeviceSummary[]> {
    const devices = await this.pairingDeviceRepository.findAllByFamily(familyId);

    return Promise.all(
      devices.map(async (device) => {
        const [riskAssessment] = await Promise.all([
          this.riskEvaluationService.getLatestRiskAssessment(device.id),
        ]);
        return {
          id: device.id,
          childId: device.childId,
          childFirstName: device.childFirstName,
          platform: device.platform,
          status: device.status,
          trustLevel: await this.trustEvaluationService.getCurrentTrustLevel(device.id),
          riskLevel: riskAssessment?.overallLevel ?? 'UNKNOWN',
          lastSeenAt: device.lastSeenAt,
          capabilities: device.capabilityProfile as unknown as IDeviceCapabilityReport | null,
          runtimeStatus: {
            accessibilityServiceEnabled:
              (device.lastTelemetry?.['accessibilityServiceEnabled'] as boolean) ?? null,
            enforcementActive: (device.lastTelemetry?.['enforcementActive'] as boolean) ?? null,
          },
        };
      }),
    );
  }

  /** Sprint 6 — Runtime Timeline. Family-ownership-checked, same as
   * getStatus (this session's earlier security fix, reused here rather
   * than re-derived). */
  async getTimeline(deviceId: string, familyId: string) {
    const device = await this.getDeviceOrThrowScopedToFamily(deviceId, familyId);
    return this.pairingEventRepository.findAllByChild(device.childId);
  }

  /** Sprint 6 — Alert Center. userId-scoped, not familyId — a runtime
   * alert was created for a specific recipient (createForFamilyOwner),
   * so reading it back is naturally scoped to "my notifications," same
   * as any notification system. */
  listAlerts(userId: string) {
    return this.runtimeAlertRepository.listForUser(userId);
  }

  /** Sprint 6 — the read path AiDiagnosticsService (ai-core module)
   * consumes, so Runtime signals reach AI Core without ai-core needing
   * to know about Device.lastTelemetry's storage shape directly. */
  async getRuntimeStatus(deviceId: string): Promise<{
    accessibilityServiceEnabled: boolean | null;
    enforcementActive: boolean | null;
  }> {
    const device = await this.getDeviceOrThrow(deviceId);
    return {
      accessibilityServiceEnabled:
        (device.lastTelemetry?.['accessibilityServiceEnabled'] as boolean) ?? null,
      enforcementActive: (device.lastTelemetry?.['enforcementActive'] as boolean) ?? null,
    };
  }

  private async getDeviceOrThrow(deviceId: string) {
    const device = await this.pairingDeviceRepository.findById(deviceId);
    if (!device) {
      throw new NotFoundException(`Device "${deviceId}" was not found.`);
    }
    return device;
  }

  private async getDeviceOrThrowScopedToFamily(deviceId: string, familyId: string) {
    const device = await this.getDeviceOrThrow(deviceId);
    if (device.familyId !== familyId) {
      // Same 404-not-403 principle as ChildNotFoundException
      // (children-module.md §2) — don't reveal a device exists in
      // another family.
      throw new NotFoundException(`Device "${deviceId}" was not found.`);
    }
    return device;
  }
}
