import { Test } from '@nestjs/testing';
import { PairingStateMachineService } from '../../src/modules/pairing/application/services/pairing-state-machine.service';
import { PAIRING_EVENT_REPOSITORY } from '../../src/modules/pairing/application/ports/pairing-event.repository.port';
import {
  InvalidPairingTransitionException,
  MissingChildIdException,
  MissingDeviceIdException,
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

  describe('childId requirement (Decision-065/066: childId is the Primary Owner reference)', () => {
    it('throws when childId is missing from transition()', async () => {
      await expect(
        service.transition({ childId: '', event: 'PAIRING_INVITED', actorType: 'USER' }),
      ).rejects.toBeInstanceOf(MissingChildIdException);
      expect(repositoryMock.record).not.toHaveBeenCalled();
    });

    it('getCurrentState also enforces the childId requirement', async () => {
      await expect(service.getCurrentState('')).rejects.toBeInstanceOf(MissingChildIdException);
    });
  });

  describe('getCurrentState', () => {
    it('returns null when no pairing history exists yet', async () => {
      repositoryMock.findLatest.mockResolvedValue(null);
      const state = await service.getCurrentState('child-1');
      expect(state).toBeNull();
      expect(repositoryMock.findLatest).toHaveBeenCalledWith('child-1');
    });

    it('returns the toState of the most recent event, looked up by childId only', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'ACTIVATED' });
      const state = await service.getCurrentState('child-1');
      expect(state).toBe('ACTIVATED');
    });
  });

  describe('the full happy-path sequence', () => {
    it('walks every state in order, deviceId appearing only from DEVICE_REGISTERED onward', async () => {
      const sequence: Array<{
        event: Parameters<typeof service.transition>[0]['event'];
        expectedFrom: string | null;
        expectedTo: string;
        deviceId?: string;
      }> = [
        { event: 'PAIRING_INVITED', expectedFrom: null, expectedTo: 'INVITATION_SENT' },
        { event: 'PAIRING_ACCEPTED', expectedFrom: 'INVITATION_SENT', expectedTo: 'AUTHENTICATING' },
        { event: 'DEVICE_REGISTERED', expectedFrom: 'AUTHENTICATING', expectedTo: 'DEVICE_REGISTERED', deviceId: 'device-1' },
        { event: 'DEVICE_VERIFIED', expectedFrom: 'DEVICE_REGISTERED', expectedTo: 'DEVICE_VERIFIED', deviceId: 'device-1' },
        { event: 'CAPABILITIES_UPLOADED', expectedFrom: 'DEVICE_VERIFIED', expectedTo: 'CAPABILITIES_UPLOADED', deviceId: 'device-1' },
        { event: 'PARENT_CONFIRMED', expectedFrom: 'CAPABILITIES_UPLOADED', expectedTo: 'PARENT_CONFIRMED', deviceId: 'device-1' },
        { event: 'POLICY_ASSIGNED', expectedFrom: 'PARENT_CONFIRMED', expectedTo: 'POLICY_ASSIGNED', deviceId: 'device-1' },
        { event: 'DEVICE_ACTIVATED', expectedFrom: 'POLICY_ASSIGNED', expectedTo: 'ACTIVATED', deviceId: 'device-1' },
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
          childId: 'child-1', // constant throughout — this is the point of Decision-066
          deviceId: step.deviceId,
          event: step.event,
          actorType: 'USER',
        });

        expect(record.fromState).toBe(step.expectedFrom);
        expect(record.toState).toBe(step.expectedTo);
        currentState = step.expectedTo;
      }

      expect(repositoryMock.record).toHaveBeenCalledTimes(sequence.length);
      // Every single findLatest call was scoped to the same childId — never deviceId.
      for (const call of repositoryMock.findLatest.mock.calls) {
        expect(call[0]).toBe('child-1');
      }
    });
  });

  describe('early events succeed with deviceId = null (Cases 1 & 2)', () => {
    it('Case 1: PAIRING_INVITED succeeds with deviceId null', async () => {
      repositoryMock.findLatest.mockResolvedValue(null);
      repositoryMock.record.mockImplementation(async (input) => ({ id: 'e1', ...input }));

      const record = await service.transition({
        childId: 'child-1',
        event: 'PAIRING_INVITED',
        actorType: 'USER',
      });

      expect(record.deviceId).toBeUndefined(); // never set — deviceId omitted entirely, not just null
      expect(repositoryMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ childId: 'child-1', deviceId: undefined }),
      );
    });

    it('Case 2: PAIRING_ACCEPTED succeeds with deviceId null', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'INVITATION_SENT' });
      repositoryMock.record.mockImplementation(async (input) => ({ id: 'e2', ...input }));

      const record = await service.transition({
        childId: 'child-1',
        event: 'PAIRING_ACCEPTED',
        actorType: 'DEVICE',
      });

      expect(record.toState).toBe('AUTHENTICATING');
      expect(repositoryMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ childId: 'child-1', deviceId: undefined }),
      );
    });
  });

  describe('device-required events (Cases 3 & 4, Decision-065/066 Event Matrix)', () => {
    it('Case 3: DEVICE_REGISTERED succeeds when deviceId is provided', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'AUTHENTICATING' });
      repositoryMock.record.mockImplementation(async (input) => ({ id: 'e3', ...input }));

      const record = await service.transition({
        childId: 'child-1',
        deviceId: 'device-1',
        event: 'DEVICE_REGISTERED',
        actorType: 'DEVICE',
      });

      expect(record.toState).toBe('DEVICE_REGISTERED');
      expect(repositoryMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'device-1' }),
      );
    });

    it('Case 4: DEVICE_REGISTERED without deviceId is rejected — never reaches the repository', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'AUTHENTICATING' });

      await expect(
        service.transition({ childId: 'child-1', event: 'DEVICE_REGISTERED', actorType: 'DEVICE' }),
      ).rejects.toBeInstanceOf(MissingDeviceIdException);

      expect(repositoryMock.record).not.toHaveBeenCalled();
    });

    it.each(['DEVICE_ACTIVATED', 'DEVICE_REVOKED'])(
      '%s also requires deviceId, per the Event Matrix',
      async (event) => {
        const fromState = event === 'DEVICE_ACTIVATED' ? 'POLICY_ASSIGNED' : 'HEALTHY';
        repositoryMock.findLatest.mockResolvedValue({ toState: fromState });

        await expect(
          service.transition({ childId: 'child-1', event: event as any, actorType: 'SYSTEM' }),
        ).rejects.toBeInstanceOf(MissingDeviceIdException);
      },
    );
  });

  describe('invalid transitions are refused, not corrected', () => {
    it('rejects DEVICE_ACTIVATED attempted before PARENT_CONFIRMED', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'CAPABILITIES_UPLOADED' });

      await expect(
        service.transition({ childId: 'child-1', deviceId: 'device-1', event: 'DEVICE_ACTIVATED', actorType: 'SYSTEM' }),
      ).rejects.toBeInstanceOf(InvalidPairingTransitionException);

      expect(repositoryMock.record).not.toHaveBeenCalled();
    });

    it('rejects PAIRING_ACCEPTED with no prior invitation (currentState null)', async () => {
      repositoryMock.findLatest.mockResolvedValue(null);

      await expect(
        service.transition({ childId: 'child-1', event: 'PAIRING_ACCEPTED', actorType: 'DEVICE' }),
      ).rejects.toBeInstanceOf(InvalidPairingTransitionException);
    });

    it('rejects re-firing PAIRING_INVITED once a pairing is already in progress', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'AUTHENTICATING' });

      await expect(
        service.transition({ childId: 'child-1', event: 'PAIRING_INVITED', actorType: 'USER' }),
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
          childId: 'child-1',
          event: 'PAIRING_REJECTED',
          actorType: 'USER',
        });

        expect(record.toState).toBe('REJECTED');
      },
    );

    it('rejects PAIRING_REJECTED once already ACTIVATED — too late to reject, must revoke instead', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'ACTIVATED' });

      await expect(
        service.transition({ childId: 'child-1', event: 'PAIRING_REJECTED', actorType: 'USER' }),
      ).rejects.toBeInstanceOf(InvalidPairingTransitionException);
    });
  });

  describe('revocation and removal', () => {
    it('allows DEVICE_REVOKED from HEALTHY, DEGRADED, or SUSPENDED', async () => {
      for (const fromState of ['HEALTHY', 'DEGRADED', 'SUSPENDED']) {
        repositoryMock.findLatest.mockResolvedValue({ toState: fromState });
        repositoryMock.record.mockResolvedValue({ id: 'x', fromState, toState: 'REVOKED' });

        await expect(
          service.transition({ childId: 'child-1', deviceId: 'device-1', event: 'DEVICE_REVOKED', actorType: 'USER' }),
        ).resolves.toBeDefined();
      }
    });

    it('requires REVOKED before REMOVED — cannot remove an active device directly', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'ACTIVATED' });

      await expect(
        service.transition({ childId: 'child-1', deviceId: 'device-1', event: 'DEVICE_REMOVED', actorType: 'USER' }),
      ).rejects.toBeInstanceOf(InvalidPairingTransitionException);
    });
  });

  describe('canTransition (no side effects)', () => {
    it('returns true without calling record', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'INVITATION_SENT' });

      const result = await service.canTransition('child-1', 'PAIRING_ACCEPTED');

      expect(result).toBe(true);
      expect(repositoryMock.record).not.toHaveBeenCalled();
    });

    it('returns false for an illegal transition', async () => {
      repositoryMock.findLatest.mockResolvedValue({ toState: 'INVITATION_SENT' });

      const result = await service.canTransition('child-1', 'DEVICE_ACTIVATED');

      expect(result).toBe(false);
    });
  });
});
