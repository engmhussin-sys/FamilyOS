import { Test } from '@nestjs/testing';
import { TrustEvaluationService } from '../../src/modules/pairing/application/services/trust-evaluation.service';
import { DEVICE_TRUST_REPOSITORY } from '../../src/modules/pairing/application/ports/device-trust.repository.port';
import { PAIRING_EVENT_REPOSITORY } from '../../src/modules/pairing/application/ports/pairing-event.repository.port';
import { PairingStateMachineService } from '../../src/modules/pairing/application/services/pairing-state-machine.service';

describe('TrustEvaluationService', () => {
  const deviceTrustRepositoryMock = { getTrustLevel: jest.fn(), updateTrustLevel: jest.fn() };
  const pairingEventRepositoryMock = { findByEventType: jest.fn() };
  const pairingStateMachineMock = { transition: jest.fn() };

  let service: TrustEvaluationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TrustEvaluationService,
        { provide: DEVICE_TRUST_REPOSITORY, useValue: deviceTrustRepositoryMock },
        { provide: PAIRING_EVENT_REPOSITORY, useValue: pairingEventRepositoryMock },
        { provide: PairingStateMachineService, useValue: pairingStateMachineMock },
      ],
    }).compile();
    service = moduleRef.get(TrustEvaluationService);
  });

  describe('evaluateAndApply — derivation rules (trust-levels-framework.md §2/§3)', () => {
    it('derives L1_REGISTERED at the REGISTERED stage', async () => {
      deviceTrustRepositoryMock.getTrustLevel.mockResolvedValue(null);

      const result = await service.evaluateAndApply({
        deviceId: 'device-1',
        childId: 'child-1',
        stage: 'REGISTERED',
      });

      expect(result).toBe('L1_REGISTERED');
      expect(deviceTrustRepositoryMock.updateTrustLevel).toHaveBeenCalledWith('device-1', 'L1_REGISTERED');
    });

    it('derives L2_VERIFIED at VERIFIED stage without attestation', async () => {
      deviceTrustRepositoryMock.getTrustLevel.mockResolvedValue('L1_REGISTERED');

      const result = await service.evaluateAndApply({
        deviceId: 'device-1',
        childId: 'child-1',
        stage: 'VERIFIED',
        hasValidAttestation: false,
      });

      expect(result).toBe('L2_VERIFIED');
    });

    it('derives L3_ATTESTED at VERIFIED stage with valid attestation', async () => {
      deviceTrustRepositoryMock.getTrustLevel.mockResolvedValue('L1_REGISTERED');

      const result = await service.evaluateAndApply({
        deviceId: 'device-1',
        childId: 'child-1',
        stage: 'VERIFIED',
        hasValidAttestation: true,
      });

      expect(result).toBe('L3_ATTESTED');
    });

    it('derives L4_ENTERPRISE regardless of stage when Device Owner provisioned', async () => {
      deviceTrustRepositoryMock.getTrustLevel.mockResolvedValue('L2_VERIFIED');

      const result = await service.evaluateAndApply({
        deviceId: 'device-1',
        childId: 'child-1',
        stage: 'VERIFIED',
        isDeviceOwnerProvisioned: true,
      });

      expect(result).toBe('L4_ENTERPRISE');
    });
  });

  describe('no-op when the level does not actually change', () => {
    it('does not write or emit an event when newLevel === currentLevel', async () => {
      deviceTrustRepositoryMock.getTrustLevel.mockResolvedValue('L1_REGISTERED');

      await service.evaluateAndApply({ deviceId: 'device-1', childId: 'child-1', stage: 'REGISTERED' });

      expect(deviceTrustRepositoryMock.updateTrustLevel).not.toHaveBeenCalled();
      expect(pairingStateMachineMock.transition).not.toHaveBeenCalled();
    });
  });

  describe('explainable event recording (Decision-047, applied to Trust)', () => {
    it('emits DEVICE_TRUST_CHANGED with a human-readable reason on an actual change', async () => {
      deviceTrustRepositoryMock.getTrustLevel.mockResolvedValue('L1_REGISTERED');
      pairingStateMachineMock.transition.mockResolvedValue({ id: 'event-1' });

      await service.evaluateAndApply({
        deviceId: 'device-1',
        childId: 'child-1',
        stage: 'VERIFIED',
        hasValidAttestation: true,
      });

      expect(pairingStateMachineMock.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          childId: 'child-1',
          deviceId: 'device-1',
          event: 'DEVICE_TRUST_CHANGED',
          actorType: 'SYSTEM',
          metadata: expect.objectContaining({
            fromLevel: 'L1_REGISTERED',
            toLevel: 'L3_ATTESTED',
            reason: expect.stringContaining('Attestation'),
          }),
        }),
      );
    });
  });

  describe('ITrustSignalProvider', () => {
    it('getCurrentTrustLevel delegates to the repository', async () => {
      deviceTrustRepositoryMock.getTrustLevel.mockResolvedValue('L3_ATTESTED');
      await expect(service.getCurrentTrustLevel('device-1')).resolves.toBe('L3_ATTESTED');
    });

    it('getTrustHistory maps raw events into explainable trust-change records', async () => {
      pairingEventRepositoryMock.findByEventType.mockResolvedValue([
        {
          deviceId: 'device-1',
          childId: 'child-1',
          toState: 'DEVICE_VERIFIED',
          occurredAt: new Date('2026-07-28T10:00:00Z'),
          metadata: { fromLevel: 'L1_REGISTERED', toLevel: 'L3_ATTESTED', reason: 'Attestation verified.' },
        },
      ]);

      const history = await service.getTrustHistory('child-1');

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        deviceId: 'device-1',
        fromLevel: 'L1_REGISTERED',
        toLevel: 'L3_ATTESTED',
        reason: 'Attestation verified.',
      });
    });
  });

  describe('IIntelligenceSignalProvider (Decision-070)', () => {
    it('getSignals returns [] when the child has no trust history yet', async () => {
      pairingEventRepositoryMock.findByEventType.mockResolvedValue([]);
      await expect(service.getSignals('child-1')).resolves.toEqual([]);
    });

    it('getSignals normalizes the latest trust change into the shared signal shape', async () => {
      pairingEventRepositoryMock.findByEventType.mockResolvedValue([
        {
          deviceId: 'device-1',
          childId: 'child-1',
          toState: 'DEVICE_VERIFIED',
          occurredAt: new Date('2026-07-28T10:00:00Z'),
          metadata: { fromLevel: 'L1_REGISTERED', toLevel: 'L3_ATTESTED', reason: 'Attestation verified.' },
        },
      ]);

      const signals = await service.getSignals('child-1');

      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        domain: 'TRUST',
        subjectId: 'child-1',
        value: { deviceId: 'device-1', trustLevel: 'L3_ATTESTED' },
        confidence: 0.95,
        reasons: ['Attestation verified.'],
      });
    });
  });
});
