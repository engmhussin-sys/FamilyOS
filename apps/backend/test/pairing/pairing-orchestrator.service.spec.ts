import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PairingOrchestratorService } from '../../src/modules/pairing/application/services/pairing-orchestrator.service';
import { InvitationService } from '../../src/modules/pairing/application/services/invitation.service';
import { RegistrationTokenService } from '../../src/modules/pairing/application/services/registration-token.service';
import { PairingStateMachineService } from '../../src/modules/pairing/application/services/pairing-state-machine.service';
import { TrustEvaluationService } from '../../src/modules/pairing/application/services/trust-evaluation.service';
import { RiskEvaluationService } from '../../src/modules/pairing/application/services/risk-evaluation.service';
import { PAIRING_DEVICE_REPOSITORY } from '../../src/modules/pairing/application/ports/pairing-device.repository.port';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { ScreenTimeService } from '../../src/modules/screen-time/application/services/screen-time.service';
import { PAIRING_EVENT_REPOSITORY } from '../../src/modules/pairing/application/ports/pairing-event.repository.port';
import { RuntimeAlertService } from '../../src/modules/pairing/application/services/runtime-alert.service';
import { RUNTIME_ALERT_REPOSITORY } from '../../src/modules/pairing/application/ports/runtime-alert.repository.port';
import { EntitlementsService } from '../../src/modules/billing/application/services/entitlements.service';

const NO_RISK_SIGNALS = {
  isEmulator: false,
  isRooted: false,
  hasTamperIndicators: false,
  isUnsupportedDevice: false,
  missingAttestation: false,
  mockLocationEnabled: false,
  developerModeEnabled: false,
  usbDebuggingEnabled: false,
  isOldAndroidVersion: false,
};

describe('PairingOrchestratorService', () => {
  const invitationServiceMock = { createInvitation: jest.fn(), redeemInvitation: jest.fn() };
  const registrationTokenServiceMock = { issue: jest.fn() };
  const pairingStateMachineMock = { transition: jest.fn(), getCurrentState: jest.fn() };
  const trustEvaluationServiceMock = { evaluateAndApply: jest.fn(), getCurrentTrustLevel: jest.fn() };
  const riskEvaluationServiceMock = { assessAndRecord: jest.fn(), getLatestRiskAssessment: jest.fn() };
  const pairingDeviceRepositoryMock = {
    createDevice: jest.fn(),
    findById: jest.fn(),
    activateDevice: jest.fn(),
    revokeDevice: jest.fn(),
    touchLastSeen: jest.fn(),
    updateCapabilityProfile: jest.fn(),
    findAllByFamily: jest.fn().mockResolvedValue([]),
    updateTelemetry: jest.fn(),
    setChildDevicePushToken: jest.fn(),
    clearDeadChildDevicePushToken: jest.fn(),
  };
  const tokenServiceMock = { issueTokenPair: jest.fn(), revokeAllTokensForDevice: jest.fn() };
  const screenTimeServiceMock = { getPolicy: jest.fn(), getBlockedPackageNames: jest.fn().mockResolvedValue([]) };
  const pairingEventRepositoryMock = { findAllByChild: jest.fn() };
  const runtimeAlertServiceMock = { evaluateTransition: jest.fn(), deviceRevoked: jest.fn() };
  const runtimeAlertRepositoryMock = { listForUser: jest.fn(), createForFamilyOwner: jest.fn() };
  const entitlementsMock = { hasFeature: jest.fn() };

  let service: PairingOrchestratorService;

  beforeEach(async () => {
    jest.clearAllMocks();
    pairingDeviceRepositoryMock.findAllByFamily.mockResolvedValue([]); // reset after clearAllMocks
    const moduleRef = await Test.createTestingModule({
      providers: [
        PairingOrchestratorService,
        { provide: InvitationService, useValue: invitationServiceMock },
        { provide: RegistrationTokenService, useValue: registrationTokenServiceMock },
        { provide: PairingStateMachineService, useValue: pairingStateMachineMock },
        { provide: TrustEvaluationService, useValue: trustEvaluationServiceMock },
        { provide: RiskEvaluationService, useValue: riskEvaluationServiceMock },
        { provide: PAIRING_DEVICE_REPOSITORY, useValue: pairingDeviceRepositoryMock },
        { provide: TokenService, useValue: tokenServiceMock },
        { provide: ScreenTimeService, useValue: screenTimeServiceMock },
        { provide: PAIRING_EVENT_REPOSITORY, useValue: pairingEventRepositoryMock },
        { provide: RuntimeAlertService, useValue: runtimeAlertServiceMock },
        { provide: RUNTIME_ALERT_REPOSITORY, useValue: runtimeAlertRepositoryMock },
        { provide: EntitlementsService, useValue: entitlementsMock },
      ],
    }).compile();
    service = moduleRef.get(PairingOrchestratorService);
  });

  describe('invite / accept', () => {
    it('invite delegates to InvitationService.createInvitation', async () => {
      invitationServiceMock.createInvitation.mockResolvedValue({ code: 'ABCD-1234', expiresInSeconds: 600 });
      const result = await service.invite('child-1', 'family-1', 'user-1');
      expect(invitationServiceMock.createInvitation).toHaveBeenCalledWith({
        childId: 'child-1',
        familyId: 'family-1',
        initiatedByUserId: 'user-1',
      });
      expect(result.code).toBe('ABCD-1234');
    });

    it('accept redeems the invitation then issues a registration token for the resulting child/family', async () => {
      invitationServiceMock.redeemInvitation.mockResolvedValue({
        childId: 'child-1',
        familyId: 'family-1',
        initiatedByUserId: 'user-1',
      });
      registrationTokenServiceMock.issue.mockResolvedValue({ token: 'reg-token', expiresInSeconds: 300 });

      const result = await service.accept('ABCD-1234');

      expect(registrationTokenServiceMock.issue).toHaveBeenCalledWith({
        childId: 'child-1',
        familyId: 'family-1',
      });
      expect(result.token).toBe('reg-token');
    });
  });

  describe('registerDevice', () => {
    it('creates the device, transitions DEVICE_REGISTERED, evaluates trust, and issues DEVICE tokens', async () => {
      pairingDeviceRepositoryMock.createDevice.mockResolvedValue({
        id: 'device-1',
        childId: 'child-1',
        familyId: 'family-1',
        status: 'PENDING_PAIRING',
        lastSeenAt: null,
      });
      tokenServiceMock.issueTokenPair.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });

      const result = await service.registerDevice('child-1', 'family-1', {
        publicKey: 'pub-key',
        platform: 'ANDROID',
      });

      expect(pairingStateMachineMock.transition).toHaveBeenCalledWith(
        expect.objectContaining({ childId: 'child-1', deviceId: 'device-1', event: 'DEVICE_REGISTERED' }),
      );
      expect(trustEvaluationServiceMock.evaluateAndApply).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'device-1', stage: 'REGISTERED' }),
      );
      expect(tokenServiceMock.issueTokenPair).toHaveBeenCalledWith({
        subjectId: 'device-1',
        actorType: 'DEVICE',
        familyId: 'family-1',
      });
      expect(result.deviceId).toBe('device-1');
    });

    it('CLOSES A REAL GAP (proactive business/code audit): allows a FIRST device for a child without checking entitlements', async () => {
      pairingDeviceRepositoryMock.findAllByFamily.mockResolvedValue([]);
      pairingDeviceRepositoryMock.createDevice.mockResolvedValue({ id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'PENDING_PAIRING', lastSeenAt: null });
      tokenServiceMock.issueTokenPair.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });

      await service.registerDevice('child-1', 'family-1', { publicKey: 'pub-key', platform: 'ANDROID' });

      expect(entitlementsMock.hasFeature).not.toHaveBeenCalled();
    });

    it('blocks a SECOND device for the SAME child when unlimited_devices_per_child is not entitled', async () => {
      pairingDeviceRepositoryMock.findAllByFamily.mockResolvedValue([
        { id: 'existing-device', childId: 'child-1', familyId: 'family-1' },
      ]);
      entitlementsMock.hasFeature.mockResolvedValue(false);

      await expect(
        service.registerDevice('child-1', 'family-1', { publicKey: 'pub-key-2', platform: 'ANDROID' }),
      ).rejects.toThrow(ForbiddenException);

      expect(entitlementsMock.hasFeature).toHaveBeenCalledWith('family-1', 'unlimited_devices_per_child');
      expect(pairingDeviceRepositoryMock.createDevice).not.toHaveBeenCalled();
    });

    /**
     * F1 — THE SECOND-DEVICE PAYWALL, same defect as `ChildrenService`.
     *
     * The thrown string named `unlimited_devices_per_child` — an internal
     * feature key — and the parent app resolves `messageAr ?? message`, so
     * with no Arabic it was rendered verbatim on an RTL screen at the upsell
     * moment. Shape, language and leak are asserted separately below.
     */
    it('refuses with the B3 contract — a code and an Arabic upsell sentence, naming no feature flag', async () => {
      pairingDeviceRepositoryMock.findAllByFamily.mockResolvedValue([
        { id: 'existing-device', childId: 'child-1', familyId: 'family-1' },
      ]);
      entitlementsMock.hasFeature.mockResolvedValue(false);

      const error: ForbiddenException = await service
        .registerDevice('child-1', 'family-1', { publicKey: 'pub-key-2', platform: 'ANDROID' })
        .then(
          () => {
            throw new Error('registerDevice resolved — the entitlement gate did not fire.');
          },
          (e: unknown) => e as ForbiddenException,
        );

      const body = error.getResponse() as { code: string; message: string; messageAr: string };

      expect(error.getStatus()).toBe(403);
      // The SAME code as the add-child paywall: both route to one plans screen.
      expect(body.code).toBe('PLAN_UPGRADE_REQUIRED');
      expect(body.messageAr).toBe(
        'باقتك الحالية تكفي لجهاز واحد لكل طفل. طوّر باقتك لتربط جهازًا إضافيًا لنفس الطفل وتتابعه على الجهازين.',
      );

      const whole = JSON.stringify(body);
      expect(whole).not.toContain('unlimited_devices_per_child');
      expect(whole).not.toContain('feature');
      expect(body.messageAr).not.toMatch(/[A-Za-z0-9]/);
    });

    it('does NOT block a device for a DIFFERENT child in the same family — the limit is per-child, not per-family', async () => {
      pairingDeviceRepositoryMock.findAllByFamily.mockResolvedValue([
        { id: 'existing-device', childId: 'some-other-child', familyId: 'family-1' },
      ]);
      pairingDeviceRepositoryMock.createDevice.mockResolvedValue({ id: 'device-2', childId: 'child-1', familyId: 'family-1', status: 'PENDING_PAIRING', lastSeenAt: null });
      tokenServiceMock.issueTokenPair.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });

      await service.registerDevice('child-1', 'family-1', { publicKey: 'pub-key', platform: 'ANDROID' });

      expect(entitlementsMock.hasFeature).not.toHaveBeenCalled();
      expect(pairingDeviceRepositoryMock.createDevice).toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    it('throws NotFoundException for an unknown device before touching anything else', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue(null);

      await expect(
        service.verify('device-1', { riskSignals: NO_RISK_SIGNALS }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(pairingStateMachineMock.transition).not.toHaveBeenCalled();
    });

    it('runs DEVICE_VERIFIED -> trust eval -> risk eval -> CAPABILITIES_UPLOADED in order, treating attestation presence as validity', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'PENDING_PAIRING', lastSeenAt: null,
      });
      trustEvaluationServiceMock.evaluateAndApply.mockResolvedValue('L3_ATTESTED');
      riskEvaluationServiceMock.assessAndRecord.mockResolvedValue({
        overallRisk: 0, overallLevel: 'LOW', categoryScores: {}, reasons: [],
      });

      const result = await service.verify('device-1', {
        attestationChain: 'chain-data',
        riskSignals: NO_RISK_SIGNALS,
      });

      expect(trustEvaluationServiceMock.evaluateAndApply).toHaveBeenCalledWith(
        expect.objectContaining({ hasValidAttestation: true }),
      );
      expect(result.trustLevel).toBe('L3_ATTESTED');
      expect(result.riskAssessment.overallLevel).toBe('LOW');

      const events = pairingStateMachineMock.transition.mock.calls.map((c) => c[0].event);
      expect(events).toEqual(['DEVICE_VERIFIED', 'CAPABILITIES_UPLOADED']);
    });
  });

  describe('activate', () => {
    it('throws NotFoundException when the device belongs to a different family (404, not 403)', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'someone-elses-family', status: 'PENDING_PAIRING', lastSeenAt: null,
      });

      await expect(
        service.activate('device-1', 'family-1', 'user-1', false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('blocks activation on HIGH risk without override, and records ACTIVATION_BLOCKED_HIGH_RISK', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'PENDING_PAIRING', lastSeenAt: null,
      });
      riskEvaluationServiceMock.getLatestRiskAssessment.mockResolvedValue({ overallLevel: 'HIGH' });

      await expect(service.activate('device-1', 'family-1', 'user-1', false)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(pairingStateMachineMock.transition).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ACTIVATION_BLOCKED_HIGH_RISK' }),
      );
      expect(pairingDeviceRepositoryMock.activateDevice).not.toHaveBeenCalled();
    });

    it('proceeds through PARENT_CONFIRMED -> POLICY_ASSIGNED -> DEVICE_ACTIVATED when risk is overridden', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'PENDING_PAIRING', lastSeenAt: null,
      });
      riskEvaluationServiceMock.getLatestRiskAssessment.mockResolvedValue({ overallLevel: 'HIGH' });

      const result = await service.activate('device-1', 'family-1', 'user-1', true);

      const events = pairingStateMachineMock.transition.mock.calls.map((c) => c[0].event);
      expect(events).toEqual(['PARENT_CONFIRMED', 'POLICY_ASSIGNED', 'DEVICE_ACTIVATED']);
      expect(pairingDeviceRepositoryMock.activateDevice).toHaveBeenCalledWith('device-1');
      expect(result.status).toBe('ACTIVATED');
    });

    it('proceeds directly (no block) when risk is LOW, no override needed', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'PENDING_PAIRING', lastSeenAt: null,
      });
      riskEvaluationServiceMock.getLatestRiskAssessment.mockResolvedValue({ overallLevel: 'LOW' });

      await service.activate('device-1', 'family-1', 'user-1', false);

      const events = pairingStateMachineMock.transition.mock.calls.map((c) => c[0].event);
      expect(events).not.toContain('ACTIVATION_BLOCKED_HIGH_RISK');
    });
  });

  describe('revoke', () => {
    it('transitions DEVICE_REVOKED, marks the device revoked, and revokes its tokens — in that order', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });

      await service.revoke('device-1', 'family-1', 'user-1', 'Lost device');

      expect(pairingStateMachineMock.transition).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'DEVICE_REVOKED', metadata: { reason: 'Lost device' } }),
      );
      expect(pairingDeviceRepositoryMock.revokeDevice).toHaveBeenCalledWith('device-1');
      expect(tokenServiceMock.revokeAllTokensForDevice).toHaveBeenCalledWith('device-1');
    });

    it('tells the household, through this module’s EXISTING alert facade and no new one', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });

      await service.revoke('device-1', 'family-1', 'user-1', 'wrong phone');

      // `RuntimeAlertService` composes it — the orchestrator does not reach
      // `createForFamilyOwner` itself, which is what keeps this module to ONE
      // entry on the notification-engine bypass allow-list.
      expect(runtimeAlertServiceMock.deviceRevoked).toHaveBeenCalledWith({
        familyId: 'family-1',
        childId: 'child-1',
        deviceId: 'device-1',
        reason: 'wrong phone',
      });
      expect(runtimeAlertRepositoryMock.createForFamilyOwner).not.toHaveBeenCalled();
    });

    it('a failed notification NEVER un-revokes the device — the security half already happened', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      runtimeAlertServiceMock.deviceRevoked.mockRejectedValueOnce(new Error('notifications table is down'));

      await expect(service.revoke('device-1', 'family-1', 'user-1')).resolves.toBeUndefined();

      expect(pairingDeviceRepositoryMock.revokeDevice).toHaveBeenCalledWith('device-1');
      expect(tokenServiceMock.revokeAllTokensForDevice).toHaveBeenCalledWith('device-1');
    });

    it('an ILLEGAL transition leaves the device untouched — nothing is half-revoked', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      pairingStateMachineMock.transition.mockRejectedValueOnce(new ConflictException('illegal'));

      await expect(service.revoke('device-1', 'family-1', 'user-1')).rejects.toThrow(ConflictException);

      expect(pairingDeviceRepositoryMock.revokeDevice).not.toHaveBeenCalled();
      expect(tokenServiceMock.revokeAllTokensForDevice).not.toHaveBeenCalled();
      expect(runtimeAlertServiceMock.deviceRevoked).not.toHaveBeenCalled();
    });
  });

  /**
   * THE DEVICE-SIDE HALF OF REVOCATION. `Device.status = REVOKED` is only worth
   * what the guards that read it are worth, and until this change THREE of this
   * module's own device routes did not read it at all: policy sync, heartbeat
   * and capability reporting all resolved through `getDeviceOrThrow`, which
   * loads the row and ignores its status. A revoked device therefore kept
   * pulling its child's screen-time policy and writing telemetry for the whole
   * remaining life of its last access token — `DeviceJwtStrategy` checks the
   * JWT's claims and never re-reads the row, and `revoke` kills only the
   * REFRESH family.
   */
  describe('a revoked or lost device cannot keep operating', () => {
    const terminalStatuses = ['REVOKED', 'LOST'];

    it.each(terminalStatuses)('refuses policy sync for a %s device', async (status) => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status, lastSeenAt: null,
      });

      await expect(service.getPolicySync('device-1')).rejects.toThrow(ForbiddenException);
      expect(screenTimeServiceMock.getPolicy).not.toHaveBeenCalled();
    });

    it.each(terminalStatuses)('refuses a heartbeat from a %s device — no lastSeen, no telemetry', async (status) => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status, lastSeenAt: null,
      });

      await expect(service.recordHeartbeat('device-1', { batteryPercent: 50 })).rejects.toThrow(ForbiddenException);
      expect(pairingDeviceRepositoryMock.touchLastSeen).not.toHaveBeenCalled();
      expect(pairingDeviceRepositoryMock.updateTelemetry).not.toHaveBeenCalled();
    });

    it.each(terminalStatuses)('refuses a capability report from a %s device', async (status) => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status, lastSeenAt: null,
      });

      await expect(
        service.reportCapabilities('device-1', { profileHash: 'h' } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(pairingDeviceRepositoryMock.updateCapabilityProfile).not.toHaveBeenCalled();
    });

    it.each(terminalStatuses)('refuses verification from a %s device', async (status) => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status, lastSeenAt: null,
      });

      await expect(
        service.verify('device-1', { riskSignals: NO_RISK_SIGNALS }),
      ).rejects.toThrow(ForbiddenException);
      expect(pairingStateMachineMock.transition).not.toHaveBeenCalled();
    });

    it('what the child READS is a sentence, not an enum or a status code', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'REVOKED', lastSeenAt: null,
      });

      const error = await service.getPolicySync('device-1').catch((e: ForbiddenException) => e);
      const body = (error as ForbiddenException).getResponse() as { code: string; messageAr: string };

      expect(body.code).toBe('DEVICE_NOT_ACTIVE');
      expect(body.messageAr).toBe('تم فصل هذا الجهاز عن حساب العائلة. اطلب من ولي الأمر ربطه من جديد.');
      expect(body.messageAr).not.toMatch(/REVOKED|LOST|403|Device/);
    });

    it('but a device MID-PAIRING is not blocked — PENDING_PAIRING is the normal state at verification', async () => {
      // The distinction that makes this guard usable on the pairing routes at
      // all: it refuses TERMINAL statuses, it does not demand ACTIVE.
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'PENDING_PAIRING', lastSeenAt: null,
      });
      trustEvaluationServiceMock.evaluateAndApply.mockResolvedValue('L2_VERIFIED');
      riskEvaluationServiceMock.assessAndRecord.mockResolvedValue({ overallLevel: 'LOW' });

      await expect(service.verify('device-1', { riskSignals: NO_RISK_SIGNALS })).resolves.toBeDefined();
    });
  });

  /**
   * GAP 5 — the child's own push token. Before this, `Device.pushToken` had
   * exactly one writer (`POST /pairing/parent-device/push-token`, parent-only),
   * so the child half of the Smart Notification Engine had nowhere to deliver.
   */
  describe('registerChildDevicePushToken', () => {
    it('writes the token against the device from the VERIFIED TOKEN, by id', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });

      await service.registerChildDevicePushToken('device-1', 'fcm-abc');

      // By PRIMARY KEY, so a repeat call writes the same row — idempotent by
      // construction rather than by a check that could be forgotten.
      expect(pairingDeviceRepositoryMock.setChildDevicePushToken).toHaveBeenCalledWith('device-1', 'fcm-abc');
    });

    it('is idempotent: registering the same token twice touches one row, twice', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });

      await service.registerChildDevicePushToken('device-1', 'fcm-abc');
      await service.registerChildDevicePushToken('device-1', 'fcm-abc');

      expect(pairingDeviceRepositoryMock.setChildDevicePushToken).toHaveBeenNthCalledWith(1, 'device-1', 'fcm-abc');
      expect(pairingDeviceRepositoryMock.setChildDevicePushToken).toHaveBeenNthCalledWith(2, 'device-1', 'fcm-abc');
    });

    it.each(['REVOKED', 'LOST', 'PENDING_PAIRING'])(
      'a %s device cannot attach a push token and start receiving a child’s notifications',
      async (status) => {
        pairingDeviceRepositoryMock.findById.mockResolvedValue({
          id: 'device-1', childId: 'child-1', familyId: 'family-1', status, lastSeenAt: null,
        });

        await expect(service.registerChildDevicePushToken('device-1', 'fcm-abc')).rejects.toThrow(ForbiddenException);
        expect(pairingDeviceRepositoryMock.setChildDevicePushToken).not.toHaveBeenCalled();
      },
    );

    it('a device paired to no child is refused', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: null, familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });

      await expect(service.registerChildDevicePushToken('device-1', 'fcm-abc')).rejects.toThrow(NotFoundException);
      expect(pairingDeviceRepositoryMock.setChildDevicePushToken).not.toHaveBeenCalled();
    });

    it('a device that does not exist is a 404, not a created row', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue(null);

      await expect(service.registerChildDevicePushToken('nope', 'fcm-abc')).rejects.toThrow(NotFoundException);
      expect(pairingDeviceRepositoryMock.setChildDevicePushToken).not.toHaveBeenCalled();
    });
  });

  describe('registerPermanentPushFailureForChildToken', () => {
    it('delegates to the token-keyed clear and reports how many rows it cleared', async () => {
      // FCM_CONTRACT.md §7's required behaviour for the CHILD path. It
      // deliberately classifies nothing: `PERMANENT_FCM_CODES` in
      // PushNotificationService is the one place that decision is made.
      pairingDeviceRepositoryMock.clearDeadChildDevicePushToken.mockResolvedValue(1);

      await expect(service.registerPermanentPushFailureForChildToken('dead-token')).resolves.toBe(1);
      expect(pairingDeviceRepositoryMock.clearDeadChildDevicePushToken).toHaveBeenCalledWith('dead-token');
    });

    it('clearing an already-rotated token is 0, not an error — the onTokenRefresh race', async () => {
      pairingDeviceRepositoryMock.clearDeadChildDevicePushToken.mockResolvedValue(0);

      await expect(service.registerPermanentPushFailureForChildToken('stale')).resolves.toBe(0);
    });
  });

  describe('getStatus', () => {
    it('returns exactly the 5 fields, aggregated from three services', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE',
        lastSeenAt: new Date('2026-07-28T00:00:00Z'),
      });
      pairingStateMachineMock.getCurrentState.mockResolvedValue('HEALTHY');
      trustEvaluationServiceMock.getCurrentTrustLevel.mockResolvedValue('L3_ATTESTED');
      riskEvaluationServiceMock.getLatestRiskAssessment.mockResolvedValue({ overallLevel: 'LOW' });

      const status = await service.getStatus('device-1', 'family-1');

      expect(status).toEqual({
        pairingState: 'HEALTHY',
        trustLevel: 'L3_ATTESTED',
        riskLevel: 'LOW',
        lastSeenAt: new Date('2026-07-28T00:00:00Z'),
        activationStatus: 'ACTIVATED',
      });
    });

    it('SECURITY: throws NotFoundException (not the status) when the device belongs to a different family', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'someone-elses-family', status: 'ACTIVE', lastSeenAt: null,
      });

      await expect(service.getStatus('device-1', 'family-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(pairingStateMachineMock.getCurrentState).not.toHaveBeenCalled();
    });
  });

  describe('assertDeviceBelongsToFamily', () => {
    it('returns the childId when ownership matches', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      await expect(service.assertDeviceBelongsToFamily('device-1', 'family-1')).resolves.toEqual({
        childId: 'child-1',
      });
    });

    it('throws NotFoundException when ownership does not match', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'someone-elses-family', status: 'ACTIVE', lastSeenAt: null,
      });
      await expect(
        service.assertDeviceBelongsToFamily('device-1', 'family-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('recordHeartbeat', () => {
    it('always touches lastSeenAt', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      pairingStateMachineMock.getCurrentState.mockResolvedValue('HEALTHY');

      await service.recordHeartbeat('device-1');

      expect(pairingDeviceRepositoryMock.touchLastSeen).toHaveBeenCalledWith('device-1');
    });

    it('does NOT write a HEARTBEAT_RECEIVED event when already HEALTHY (sampling principle)', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      pairingStateMachineMock.getCurrentState.mockResolvedValue('HEALTHY');

      await service.recordHeartbeat('device-1');

      expect(pairingStateMachineMock.transition).not.toHaveBeenCalled();
    });

    it('DOES write HEARTBEAT_RECEIVED when recovering from DEGRADED', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      pairingStateMachineMock.getCurrentState.mockResolvedValue('DEGRADED');

      await service.recordHeartbeat('device-1');

      expect(pairingStateMachineMock.transition).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'HEARTBEAT_RECEIVED' }),
      );
    });
  });

  describe('reportCapabilities', () => {
    it('stores the capability report and hash via the repository, caching current state', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });

      const report = {
        manufacturer: 'Google', model: 'Pixel 8', sdkInt: 34,
        usageAccessGranted: true, accessibilityEnabled: false, overlayGranted: true,
        batteryOptimizationExempted: true, notificationsGranted: true, profileHash: 'hash-1',
      };

      await service.reportCapabilities('device-1', report);

      expect(pairingDeviceRepositoryMock.updateCapabilityProfile).toHaveBeenCalledWith(
        'device-1', report, 'hash-1',
      );
    });

    it('throws NotFoundException for an unknown device', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue(null);
      await expect(
        service.reportCapabilities('device-1', {} as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getPolicySync', () => {
    it('returns real policy fields from ScreenTimeService when a policy exists', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      screenTimeServiceMock.getPolicy.mockResolvedValue({
        id: 'policy-1', dailyLimitMinutes: 90, bedtimeStart: '21:00', bedtimeEnd: '07:00', focusModeEnabled: true,
      });

      const result = await service.getPolicySync('device-1');

      expect(screenTimeServiceMock.getPolicy).toHaveBeenCalledWith('child-1', 'family-1');
      expect(result.dailyLimitMinutes).toBe(90);
      expect(result.blockedPackages).toEqual([]); // honest — no AppBlockRule service exists yet
    });

    it('returns sensible defaults when no policy has been set yet', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      screenTimeServiceMock.getPolicy.mockResolvedValue(null);

      const result = await service.getPolicySync('device-1');

      expect(result.dailyLimitMinutes).toBeNull();
      expect(result.policyVersion).toBe('none');
    });
  });

  describe('recordHeartbeat with telemetry (Sprint 4 extension)', () => {
    it('persists telemetry via updateTelemetry when provided', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      pairingStateMachineMock.getCurrentState.mockResolvedValue('HEALTHY');

      await service.recordHeartbeat('device-1', { batteryPercent: 80, isConnected: true });

      expect(pairingDeviceRepositoryMock.updateTelemetry).toHaveBeenCalledWith('device-1', {
        batteryPercent: 80,
        isConnected: true,
      });
    });

    it('does not call updateTelemetry when no telemetry is provided', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      pairingStateMachineMock.getCurrentState.mockResolvedValue('HEALTHY');

      await service.recordHeartbeat('device-1');

      expect(pairingDeviceRepositoryMock.updateTelemetry).not.toHaveBeenCalled();
    });

    it('Sprint 6: calls RuntimeAlertService.evaluateTransition with old and new accessibility state', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
        lastTelemetry: { accessibilityServiceEnabled: true },
      });
      pairingStateMachineMock.getCurrentState.mockResolvedValue('HEALTHY');

      await service.recordHeartbeat('device-1', { accessibilityServiceEnabled: false });

      expect(runtimeAlertServiceMock.evaluateTransition).toHaveBeenCalledWith({
        familyId: 'family-1',
        childId: 'child-1',
        previousAccessibilityEnabled: true,
        currentAccessibilityEnabled: false,
      });
    });

    it('Sprint 6: does not call evaluateTransition when accessibilityServiceEnabled is absent from telemetry', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      pairingStateMachineMock.getCurrentState.mockResolvedValue('HEALTHY');

      await service.recordHeartbeat('device-1', { batteryPercent: 80 });

      expect(runtimeAlertServiceMock.evaluateTransition).not.toHaveBeenCalled();
    });
  });

  describe('getTimeline (Sprint 6)', () => {
    it('returns the full childId-scoped event history for an owned device', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });
      pairingEventRepositoryMock.findAllByChild.mockResolvedValue([{ id: 'event-1' }, { id: 'event-2' }]);

      const timeline = await service.getTimeline('device-1', 'family-1');

      expect(pairingEventRepositoryMock.findAllByChild).toHaveBeenCalledWith('child-1');
      expect(timeline).toHaveLength(2);
    });

    it('SECURITY: throws NotFoundException for a device in a different family', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'someone-elses-family', status: 'ACTIVE', lastSeenAt: null,
      });

      await expect(service.getTimeline('device-1', 'family-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(pairingEventRepositoryMock.findAllByChild).not.toHaveBeenCalled();
    });
  });

  describe('listAlerts (Sprint 6)', () => {
    it('delegates to the repository, scoped by userId', async () => {
      runtimeAlertRepositoryMock.listForUser.mockResolvedValue([{ id: 'alert-1' }]);
      const result = await service.listAlerts('user-1');
      expect(runtimeAlertRepositoryMock.listForUser).toHaveBeenCalledWith('user-1');
      expect(result).toEqual([{ id: 'alert-1' }]);
    });
  });

  describe('getRuntimeStatus (Sprint 6)', () => {
    it('reads accessibilityServiceEnabled/enforcementActive from cached telemetry', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
        lastTelemetry: { accessibilityServiceEnabled: true, enforcementActive: true },
      });

      const status = await service.getRuntimeStatus('device-1');

      expect(status).toEqual({ accessibilityServiceEnabled: true, enforcementActive: true });
    });

    it('defaults to null fields when no telemetry has ever arrived', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE', lastSeenAt: null,
      });

      const status = await service.getRuntimeStatus('device-1');

      expect(status).toEqual({ accessibilityServiceEnabled: null, enforcementActive: null });
    });
  });

  describe('listFamilyDevices', () => {
    it('aggregates trust, risk, and capability data per device', async () => {
      pairingDeviceRepositoryMock.findAllByFamily.mockResolvedValue([
        {
          id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE',
          lastSeenAt: new Date('2026-07-28T00:00:00Z'), capabilityProfile: { manufacturer: 'Google' },
          capabilityProfileHash: 'hash-1', childFirstName: 'Yusuf', platform: 'ANDROID',
        },
      ]);
      trustEvaluationServiceMock.getCurrentTrustLevel.mockResolvedValue('L2_VERIFIED');
      riskEvaluationServiceMock.getLatestRiskAssessment.mockResolvedValue({ overallLevel: 'LOW' });

      const result = await service.listFamilyDevices('family-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'device-1',
        childFirstName: 'Yusuf',
        trustLevel: 'L2_VERIFIED',
        riskLevel: 'LOW',
        capabilities: { manufacturer: 'Google' },
      });
    });

    it('Sprint 5: exposes runtimeStatus read from cached telemetry', async () => {
      pairingDeviceRepositoryMock.findAllByFamily.mockResolvedValue([
        {
          id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE',
          lastSeenAt: null, capabilityProfile: null, capabilityProfileHash: null,
          lastTelemetry: { accessibilityServiceEnabled: true, enforcementActive: true, batteryPercent: 80 },
          childFirstName: 'Yusuf', platform: 'ANDROID',
        },
      ]);
      trustEvaluationServiceMock.getCurrentTrustLevel.mockResolvedValue('L2_VERIFIED');
      riskEvaluationServiceMock.getLatestRiskAssessment.mockResolvedValue(null);

      const result = await service.listFamilyDevices('family-1');

      expect(result[0].runtimeStatus).toEqual({
        accessibilityServiceEnabled: true,
        enforcementActive: true,
      });
    });

    it('Sprint 5: defaults runtimeStatus fields to null when no telemetry has ever arrived', async () => {
      pairingDeviceRepositoryMock.findAllByFamily.mockResolvedValue([
        {
          id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE',
          lastSeenAt: null, capabilityProfile: null, capabilityProfileHash: null,
          lastTelemetry: null, childFirstName: 'Yusuf', platform: 'ANDROID',
        },
      ]);
      trustEvaluationServiceMock.getCurrentTrustLevel.mockResolvedValue(null);
      riskEvaluationServiceMock.getLatestRiskAssessment.mockResolvedValue(null);

      const result = await service.listFamilyDevices('family-1');

      expect(result[0].runtimeStatus).toEqual({
        accessibilityServiceEnabled: null,
        enforcementActive: null,
      });
    });
  });

  // --- Sprint 29: device-authenticated self-service resolution, plus
  // the REVOKED-device security fix found in this session's own audit ---
  describe('getChildIdForDevice / getChildAndFamilyIdForDevice', () => {
    it('SECURITY REGRESSION TEST: throws ForbiddenException for a REVOKED device even with a structurally valid deviceId — a still-unexpired token must not act for a revoked device', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'REVOKED',
        lastSeenAt: null, capabilityProfile: null, capabilityProfileHash: null, lastTelemetry: null,
      });

      await expect(service.getChildIdForDevice('device-1')).rejects.toThrow(ForbiddenException);
      await expect(service.getChildAndFamilyIdForDevice('device-1')).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for a LOST device', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'LOST',
        lastSeenAt: null, capabilityProfile: null, capabilityProfileHash: null, lastTelemetry: null,
      });

      await expect(service.getChildIdForDevice('device-1')).rejects.toThrow(ForbiddenException);
    });

    it('resolves childId and familyId for a genuinely ACTIVE device', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue({
        id: 'device-1', childId: 'child-1', familyId: 'family-1', status: 'ACTIVE',
        lastSeenAt: null, capabilityProfile: null, capabilityProfileHash: null, lastTelemetry: null,
      });

      const result = await service.getChildAndFamilyIdForDevice('device-1');

      expect(result).toEqual({ childId: 'child-1', familyId: 'family-1' });
    });

    it('throws NotFoundException for a device that does not exist', async () => {
      pairingDeviceRepositoryMock.findById.mockResolvedValue(null);
      await expect(service.getChildIdForDevice('missing-device')).rejects.toThrow(NotFoundException);
    });
  });
});
