import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

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
import { EntitlementsService } from '../../../billing/application/services/entitlements.service';
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
import { runWithTenant } from '../../../../common/tenancy/tenant-context';

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
  private readonly logger = new Logger(PairingOrchestratorService.name);

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
    private readonly entitlements: EntitlementsService,
  ) {}

  invite(childId: string, familyId: string, initiatedByUserId: string): Promise<IInvitationTicket> {
    return this.invitationService.createInvitation({ childId, familyId, initiatedByUserId });
  }

  async accept(code: string): Promise<IRegistrationTokenTicket> {
    const ticket: IRedeemedInvitation = await this.invitationService.redeemInvitation(code);
    return this.registrationTokenService.issue({ childId: ticket.childId, familyId: ticket.familyId });
  }

  /** CLOSES A REAL GAP (proactive business/code audit): 'unlimited_devices_per_child'
   * has existed as a plan feature since Sprint 8 with zero enforcement
   * anywhere. The first device for any given child is always free —
   * only a SECOND device for the SAME child requires the entitlement
   * (a family with two phones for the same kid, not two different kids). */
  async registerDevice(
    childId: string,
    familyId: string,
    input: Omit<ICreatePairingDeviceInput, 'childId' | 'familyId'>,
  ): Promise<IDeviceRegistrationResult> {
    // childId/familyId come from RegistrationTokenGuard's server-issued token
    // (registration-token.guard.ts), not from the request body. Binding them as
    // the tenant here converts an AUTH_BOOTSTRAP SystemContext into a real,
    // narrow tenant scope for the rest of the registration.
    return runWithTenant(
      { familyId, actorType: 'DEVICE', actorId: `pairing-register:${childId}` },
      () => this.registerDeviceScoped(childId, familyId, input),
    );
  }

  private async registerDeviceScoped(
    childId: string,
    familyId: string,
    input: Omit<ICreatePairingDeviceInput, 'childId' | 'familyId'>,
  ): Promise<IDeviceRegistrationResult> {
    const existingFamilyDevices = await this.pairingDeviceRepository.findAllByFamily(familyId);
    const existingDevicesForThisChild = existingFamilyDevices.filter((d) => d.childId === childId);
    if (existingDevicesForThisChild.length >= 1) {
      const entitled = await this.entitlements.hasFeature(familyId, 'unlimited_devices_per_child');
      if (!entitled) {
        throw new ForbiddenException('Pairing a second device for the same child requires a plan with the unlimited_devices_per_child feature.');
      }
    }

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
    const device = await this.getLiveDeviceOrThrow(deviceId);

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

  /**
   * PARENT CONFIRMATION, ALL THE WAY TO `ACTIVATED`. This is the whole of the
   * transition table's tail in one call — `PARENT_CONFIRMED(USER)` then
   * `POLICY_ASSIGNED(SYSTEM)` then `DEVICE_ACTIVATED(SYSTEM)` — and it ends by
   * writing `Device.status = ACTIVE`, so the pairing state and the row a guard
   * reads cannot disagree. The two SYSTEM steps are not separate endpoints on
   * purpose: nothing outside this server is the actor for either of them, and
   * an endpoint a client must call to finish activating is an activation that
   * stalls the moment that client crashes.
   *
   * A SECOND CONFIRM IS A 409, NOT A NO-OP SUCCESS, and the choice is
   * deliberate rather than inherited.
   *
   * The transition table already answers it: `PARENT_CONFIRMED` is legal only
   * from `CAPABILITIES_UPLOADED`, so the second call raises
   * `InvalidPairingTransitionException` (409, and B3-shaped by the global
   * filter: `code: CONFLICT`, «هذا الإجراء تمّ بالفعل، أو لم يعد متاحًا الآن»).
   * Swallowing that into a 200 would require this method to decide that
   * "already ACTIVATED" is the ONLY illegal `from` state worth forgiving —
   * while `REJECTED`, `REVOKED` and `EXPIRED` are all equally reachable and all
   * mean something entirely different. It would also have to answer with a
   * `policyAssignedAt` for an activation that did not happen.
   *
   * The 409 is not a failure the parent app has to explain: its Arabic sentence
   * already reads «this has already been done», the state is exactly what the
   * caller wanted, and `GET /pairing/devices` shows the device ACTIVE. So the
   * client contract is «treat 409 on activate as success-already», which is a
   * one-line client rule, against «the server lies about which call did the
   * work», which is not recoverable at all. The golden lifecycle spec asserts
   * the 409 so the choice cannot drift silently.
   */
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

  /**
   * REVOCATION, IN THE ORDER THAT MATTERS.
   *
   * The state-machine transition goes FIRST and is allowed to throw: an
   * illegal `from` state must leave the device untouched, not half-revoked with
   * an audit row missing. Everything after it is the enforcement the state
   * column is a record of — `Device.status`, the refresh-token family, and (as
   * of this change) the family's own record that it happened.
   */
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

    // THE NOTIFICATION, THROUGH THIS MODULE'S EXISTING FACADE AND NO NEW ONE.
    // `RuntimeAlertService` is where this module's alerts are composed and is
    // already the reviewed producer on `notification-engine-bypass.guard.spec.ts`'s
    // allow-list; the composition itself (type, priority, source key) lives
    // there with its reasoning, not here.
    //
    // BEST-EFFORT, AND STATED: a notification failure must never leave a device
    // revoked in the state machine but still usable in the token layer. The
    // security half above has already happened by the time this line runs, and
    // it is not conditional on anyone being told.
    try {
      await this.runtimeAlertService.deviceRevoked({
        familyId: device.familyId,
        childId: device.childId,
        deviceId,
        reason,
      });
    } catch (error) {
      this.logger.warn(
        `pairing.revoke_notification_failed device=${deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    const device = await this.getLiveDeviceOrThrow(deviceId);
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
    await this.getLiveDeviceOrThrow(deviceId);
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
   * GAP CLOSED (was: "NOTE (honest limitation, flagged not hidden):
   * blockedPackages is always [] today... no service/API built for it
   * yet"): AppBlockRuleService now exists in screen-time.service.ts —
   * this calls its real, ownership-checked query instead of hardcoding
   * an empty array.
   */
  async getPolicySync(deviceId: string): Promise<IPolicySyncResponse> {
    const device = await this.getLiveDeviceOrThrow(deviceId);
    const [policy, blockedPackages] = await Promise.all([
      this.screenTimeService.getPolicy(device.childId, device.familyId),
      this.screenTimeService.getBlockedPackageNames(device.childId),
    ]);

    return {
      childId: device.childId,
      policyVersion: policy?.id ?? 'none',
      dailyLimitMinutes: policy?.dailyLimitMinutes ?? null,
      bedtimeStart: policy?.bedtimeStart ?? null,
      bedtimeEnd: policy?.bedtimeEnd ?? null,
      focusModeEnabled: policy?.focusModeEnabled ?? false,
      blockedPackages,
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

  /**
   * ADDITIVE (Sprint 23 hardening pass): for device-authenticated
   * callers that have a deviceId but no familyId context — DEVICE
   * JWTs don't carry one (see auth.types.ts's own comment: familyId is
   * "present for USER actors," not device ones). Distinct from
   * `assertDeviceBelongsToFamily` above, which requires a familyId a
   * device-authenticated caller structurally cannot supply. Zero
   * change to any existing method \u2014 this closes the specific,
   * previously-documented gap in the Life Intelligence Platform's
   * child-message-inbox route (see LifeIntelligenceController's own
   * comment, now resolved by this method existing).
   */
  /**
   * ADDITIVE (Sprint 29): sibling to getChildIdForDevice above, for
   * device-authenticated callers that ALSO need familyId to call
   * existing childId+familyId-scoped service methods.
   *
   * SECURITY FIX (found in this session's own audit of the new
   * self/* write endpoints): `DeviceJwtStrategy.validate()` only
   * checks the JWT's own claims (tokenKind, actorType) \u2014 it never
   * re-checks the device's LIVE status against the database. A
   * REVOKED or LOST device with a still-unexpired access token could
   * otherwise continue writing child data through the new self/*
   * endpoints until that token naturally expires. Not fixed in
   * DeviceJwtStrategy itself (frozen, shared by every device route,
   * including low-stakes ones like heartbeat) \u2014 fixed here, since
   * this is the first device-facing surface where a stale token could
   * WRITE meaningful child data rather than just report telemetry.
   */
  async getChildAndFamilyIdForDevice(deviceId: string): Promise<{ childId: string; familyId: string }> {
    const device = await this.getDeviceOrThrow(deviceId);
    if (device.status !== 'ACTIVE') {
      throw new ForbiddenException(`Device is ${device.status.toLowerCase()}, not active.`);
    }
    if (!device.childId) {
      throw new NotFoundException(`Device "${deviceId}" is not paired to a child.`);
    }
    return { childId: device.childId, familyId: device.familyId };
  }

  /** Sprint 5 (Push Notifications) — registers/refreshes the Parent
   * App's own push token, closing the gap flagged in
   * IPairingDeviceRepository.upsertParentDevicePushToken's own
   * docstring. Called by an authenticated PARENT (JwtAuthGuard), not
   * a device — there is no pairing flow for this, a logged-in parent
   * simply registers their own app instance. */
  async registerParentDevicePushToken(
    userId: string,
    familyId: string,
    platform: 'ANDROID' | 'IOS',
    pushToken: string,
  ): Promise<void> {
    await this.pairingDeviceRepository.upsertParentDevicePushToken({ userId, familyId, platform, pushToken });
  }

  /**
   * THE CHILD EQUIVALENT OF `registerParentDevicePushToken`, and the reason the
   * child half of the Smart Notification Engine could never deliver: the only
   * push-token route in the backend was `POST /pairing/parent-device/push-token`,
   * parent-only, so a child device had nowhere to put an FCM token.
   *
   * `deviceId` COMES FROM THE VERIFIED TOKEN, never from a body — the controller
   * passes `device.sub` off `DeviceJwtAuthGuard`'s payload, the same shape
   * `ChildAchievementsController` and `ChildCoachController` use. That is what
   * makes "child A registers a token for child B" and "family A's device
   * attaches to family B" unreachable rather than merely checked: there is no
   * field in the request in which either could be expressed.
   *
   * `getChildAndFamilyIdForDevice` is called for its ASSERTIONS, not for its
   * return value — it re-reads the row and refuses a device that is not ACTIVE
   * or not paired to a child. A revoked device therefore cannot re-attach a push
   * token and start receiving a child's notifications again on a stale access
   * token.
   *
   * `platform` is deliberately NOT a parameter, unlike the parent version. The
   * child device's platform was recorded at registration from its own registered
   * `Device` row; letting the request state it again would be a client asserting
   * a value the server already knows — and the row is keyed by id here anyway,
   * so it could only ever disagree, never inform.
   */
  async registerChildDevicePushToken(deviceId: string, pushToken: string): Promise<void> {
    await this.getChildAndFamilyIdForDevice(deviceId);
    await this.pairingDeviceRepository.setChildDevicePushToken(deviceId, pushToken);
  }

  /**
   * THE OTHER HALF OF THE `Device.pushToken` CONTRACT: a token FCM has told us
   * is permanently dead stops being sent to.
   *
   * SCOPE, STATED HONESTLY. This is the CHILD path only. `docs/integration/FCM_CONTRACT.md`
   * §7 records the parent path as an open, externally-owned item (item 13,
   * "clearing a dead token after a PERMANENT failure"), and the FCM delivery
   * pipeline itself is owned outside this module — so this method is the ABNY-side
   * primitive that pipeline calls when `PushSendResult.outcome === 'PERMANENT'`
   * for a child device's token, not a second delivery pipeline. It deliberately
   * does not classify anything: `PERMANENT_FCM_CODES` in `PushNotificationService`
   * is the one place that decision is made, and duplicating it here is how two
   * places start disagreeing about which codes are terminal.
   *
   * Returns how many rows were cleared so the caller can log a real number; zero
   * is a normal outcome (the device re-registered a fresh token first).
   */
  registerPermanentPushFailureForChildToken(pushToken: string): Promise<number> {
    return this.pairingDeviceRepository.clearDeadChildDevicePushToken(pushToken);
  }

  async getChildIdForDevice(deviceId: string): Promise<string> {
    const device = await this.getDeviceOrThrow(deviceId);
    if (device.status !== 'ACTIVE') {
      throw new ForbiddenException(`Device is ${device.status.toLowerCase()}, not active.`);
    }
    if (!device.childId) {
      throw new NotFoundException(`Device "${deviceId}" is not paired to a child.`);
    }
    return device.childId;
  }

  private async getDeviceOrThrow(deviceId: string) {
    const device = await this.pairingDeviceRepository.findById(deviceId);
    if (!device) {
      throw new NotFoundException(`Device "${deviceId}" was not found.`);
    }
    return device;
  }

  /**
   * THE DEVICE-SIDE HALF OF REVOCATION, and the reason `Device.status` is not
   * decoration.
   *
   * `revoke()` sets `Device.status = REVOKED` and revokes the device's REFRESH
   * tokens — but an ACCESS token already in the revoked device's hands stays
   * cryptographically valid until it expires, and `DeviceJwtStrategy.validate()`
   * checks only the JWT's own claims: it never re-reads the row. Every
   * `/self/*` surface is safe from that because it resolves its child through
   * `getChildAndFamilyIdForDevice`, which asserts `status === 'ACTIVE'`.
   *
   * THIS MODULE'S OWN DEVICE ROUTES DID NOT. `GET /pairing/device/policy`
   * (the child's screen-time policy and block list), `POST /pairing/device/heartbeat`
   * (writes `lastSeenAt` and telemetry, and can raise a family notification) and
   * `POST /pairing/device/capabilities` all went through `getDeviceOrThrow`,
   * which reads the row and ignores its status — so a revoked device kept
   * pulling policy and reporting telemetry for the whole life of its last access
   * token. Measured, not assumed: the golden lifecycle spec asserts each of
   * these three answers 403 after a revoke.
   *
   * IT REFUSES ON A TERMINAL STATUS RATHER THAN REQUIRING `ACTIVE`, which is the
   * distinction that lets this be used on the PAIRING routes at all: a device
   * mid-pairing is legitimately `PENDING_PAIRING` when it calls `verify`, so
   * "must be ACTIVE" would break the very flow these routes exist to complete.
   * REVOKED and LOST are the two statuses that mean «this device must stop», and
   * they are the two this refuses.
   */
  private async getLiveDeviceOrThrow(deviceId: string) {
    const device = await this.getDeviceOrThrow(deviceId);
    if (device.status === 'REVOKED' || device.status === 'LOST') {
      throw new ForbiddenException({
        code: 'DEVICE_NOT_ACTIVE',
        // B3: what the child actually reads. No enum, no status code, no
        // Prisma constraint name reaches this sentence.
        messageAr: 'تم فصل هذا الجهاز عن حساب العائلة. اطلب من ولي الأمر ربطه من جديد.',
        message: `Device "${deviceId}" is ${device.status.toLowerCase()} and may no longer act for its child.`,
      });
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
