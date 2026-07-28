import { Test } from '@nestjs/testing';
import { PairingStateMachineService } from '../../src/modules/pairing/application/services/pairing-state-machine.service';
import { PAIRING_EVENT_REPOSITORY } from '../../src/modules/pairing/application/ports/pairing-event.repository.port';
import {
  InvalidPairingTransitionException,
  MissingPairingCorrelationKeyException,
} from '../../src/modules/pairing/domain/pairing.errors';

describe('PairingStateMachineService', () => {
  const repositoryMock = {
    record: jest.fn(),
    findLatest: jest.fn(),
  };

  let service: PairingStateMachineService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PairingStateMachineService,
        { provide: PAIRING_EVENT_REPOSITORY, useValue: repositoryMock },
      ],
    }).compile();
    service = moduleRef.get(PairingStateMachineService);
  });

  describe('correlation key requirement', () => {
    it('throws when neither deviceId nor childId is provided', async () => {
      await expect(
        service.transition({ event: 'PAIRING_INVITED', actorType: 'USER' }),
      ).rejects.toBeInstanceOf(MissingPairingCorrelationKeyException);
      expect(repositoryMock.record).not.toHaveBeenCalled();
    });

    it('getCurrentState also enforces the correlation key requirement', async () => {
      await expect(service.getCurrentState({})).rejects.toBeInstanceOf(
        MissingPairingCorrelationKeyException,
      );
    });
  });

  describe('getCurrentState', () => {
    it('returns null when no pairing history exists yet', async () => {
      repositoryMock.findLatest.mockResolvedValue(null);
      const state = await service.getCurrentState({ childId: 'child-1' });
      expect(state).toBeNull();
    });

    it('returns the toState of the most recent event', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'ACTIVATED' });
      const state = await service.getCurrentState({ deviceId: 'device-1' });
      expect(state).toBe('ACTIVATED');
    });
  });

  describe('the full happy-path sequence', () => {
    it('walks every state in order, each building on the last', async () => {
      const sequence: Array<{
        event: Parameters<typeof service.transition>[0]['event'];
        expectedFrom: string | null;
        expectedTo: string;
      }> = [
        { event: 'PAIRING_INVITED', expectedFrom: null, expectedTo: 'INVITATION_SENT' },
        { event: 'PAIRING_ACCEPTED', expectedFrom: 'INVITATION_SENT', expectedTo: 'AUTHENTICATING' },
        { event: 'DEVICE_REGISTERED', expectedFrom: 'AUTHENTICATING', expectedTo: 'DEVICE_REGISTERED' },
        { event: 'DEVICE_VERIFIED', expectedFrom: 'DEVICE_REGISTERED', expectedTo: 'DEVICE_VERIFIED' },
        { event: 'CAPABILITIES_UPLOADED', expectedFrom: 'DEVICE_VERIFIED', expectedTo: 'CAPABILITIES_UPLOADED' },
        { event: 'PARENT_CONFIRMED', expectedFrom: 'CAPABILITIES_UPLOADED', expectedTo: 'PARENT_CONFIRMED' },
        { event: 'POLICY_ASSIGNED', expectedFrom: 'PARENT_CONFIRMED', expectedTo: 'POLICY_ASSIGNED' },
        { event: 'DEVICE_ACTIVATED', expectedFrom: 'POLICY_ASSIGNED', expectedTo: 'ACTIVATED' },
      ];

      let currentState: string | null = null;

      for (const step of sequence) {
        repositoryMock.findLatest.mockResolvedValue(
          currentState ? { toState: currentState } : null,
        );
        repositoryMock.record.mockImplementation(async (input) => ({
          id: 'event-id',
          ...input,
        }));

        const record = await service.transition({
          event: step.event,
          childId: currentState === null ? 'child-1' : undefined,
          deviceId: currentState !== null ? 'device-1' : undefined,
          actorType: 'USER',
        });

        expect(record.fromState).toBe(step.expectedFrom);
        expect(record.toState).toBe(step.expectedTo);
        currentState = step.expectedTo;
      }

      expect(repositoryMock.record).toHaveBeenCalledTimes(sequence.length);
    });
  });

  describe('invalid transitions are refused, not corrected', () => {
    it('rejects DEVICE_ACTIVATED attempted before PARENT_CONFIRMED', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'CAPABILITIES_UPLOADED' });

      await expect(
        service.transition({ event: 'DEVICE_ACTIVATED', deviceId: 'device-1', actorType: 'SYSTEM' }),
      ).rejects.toBeInstanceOf(InvalidPairingTransitionException);

      expect(repositoryMock.record).not.toHaveBeenCalled();
    });

    it('rejects PAIRING_ACCEPTED with no prior invitation (currentState null)', async () => {
      repositoryMock.findLatest.mockResolvedValue(null);

      await expect(
        service.transition({ event: 'PAIRING_ACCEPTED', deviceId: 'device-1', actorType: 'DEVICE' }),
      ).rejects.toBeInstanceOf(InvalidPairingTransitionException);
    });

    it('rejects re-firing PAIRING_INVITED once a pairing is already in progress', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'AUTHENTICATING' });

      await expect(
        service.transition({ event: 'PAIRING_INVITED', childId: 'child-1', actorType: 'USER' }),
      ).rejects.toBeInstanceOf(InvalidPairingTransitionException);
    });
  });

  describe('rejection flow (Decision-056: broadened scope)', () => {
    it.each(['AUTHENTICATING', 'DEVICE_REGISTERED', 'DEVICE_VERIFIED', 'CAPABILITIES_UPLOADED'])(
      'allows PAIRING_REJECTED from %s',
      async (fromState) => {
        repositoryMock.findLatest.mockResolvedValue({ toState: fromState });
        repositoryMock.record.mockResolvedValue({
          id: 'event-id',
          fromState,
          toState: 'REJECTED',
        });

        const record = await service.transition({
          event: 'PAIRING_REJECTED',
          deviceId: 'device-1',
          actorType: 'USER',
        });

        expect(record.toState).toBe('REJECTED');
      },
    );

    it('rejects PAIRING_REJECTED once already ACTIVATED — too late to reject, must revoke instead', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'ACTIVATED' });

      await expect(
        service.transition({ event: 'PAIRING_REJECTED', deviceId: 'device-1', actorType: 'USER' }),
      ).rejects.toBeInstanceOf(InvalidPairingTransitionException);
    });
  });

  describe('revocation and removal', () => {
    it('allows DEVICE_REVOKED from HEALTHY, DEGRADED, or SUSPENDED', async () => {
      for (const fromState of ['HEALTHY', 'DEGRADED', 'SUSPENDED']) {
        repositoryMock.findLatest.mockResolvedValue({ toState: fromState });
        repositoryMock.record.mockResolvedValue({ id: 'x', fromState, toState: 'REVOKED' });

        await expect(
          service.transition({ event: 'DEVICE_REVOKED', deviceId: 'device-1', actorType: 'USER' }),
        ).resolves.toBeDefined();
      }
    });

    it('requires REVOKED before REMOVED — cannot remove an active device directly', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'ACTIVATED' });

      await expect(
        service.transition({ event: 'DEVICE_REMOVED', deviceId: 'device-1', actorType: 'USER' }),
      ).rejects.toBeInstanceOf(InvalidPairingTransitionException);
    });
  });

  describe('canTransition (no side effects)', () => {
    it('returns true without calling record', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'INVITATION_SENT' });

      const result = await service.canTransition({ deviceId: 'device-1' }, 'PAIRING_ACCEPTED');

      expect(result).toBe(true);
      expect(repositoryMock.record).not.toHaveBeenCalled();
    });

    it('returns false for an illegal transition', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'INVITATION_SENT' });

      const result = await service.canTransition({ deviceId: 'device-1' }, 'DEVICE_ACTIVATED');

      expect(result).toBe(false);
    });
  });
});
