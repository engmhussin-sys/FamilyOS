import { ConflictException, NotFoundException } from '@nestjs/common';
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
    findAllByFamily: jest.fn(),
    updateTelemetry: jest.fn(),
  };
  const tokenServiceMock = { issueTokenPair: jest.fn(), revokeAllTokensForDevice: jest.fn() };
  const screenTimeServiceMock = { getPolicy: jest.fn() };

  let service: PairingOrchestratorService;

  beforeEach(async () => {
    jest.clearAllMocks();
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
});
