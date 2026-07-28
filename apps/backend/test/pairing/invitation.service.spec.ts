import { Test } from '@nestjs/testing';
import { InvitationService } from '../../src/modules/pairing/application/services/invitation.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { PairingStateMachineService } from '../../src/modules/pairing/application/services/pairing-state-machine.service';
import { InvalidOrExpiredInvitationException } from '../../src/modules/pairing/domain/invitation.errors';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';

describe('InvitationService', () => {
  const redisServiceMock = { setWithTtl: jest.fn(), getAndDelete: jest.fn() };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };
  const pairingStateMachineMock = { transition: jest.fn() };

  let service: InvitationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationService,
        { provide: RedisService, useValue: redisServiceMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: PairingStateMachineService, useValue: pairingStateMachineMock },
      ],
    }).compile();
    service = moduleRef.get(InvitationService);
  });

  describe('createInvitation', () => {
    it('rejects before touching Redis or the state machine when ownership fails', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(
        new ChildNotFoundException('child-1'),
      );

      await expect(
        service.createInvitation({ childId: 'child-1', familyId: 'family-1', initiatedByUserId: 'user-1' }),
      ).rejects.toBeInstanceOf(ChildNotFoundException);

      expect(redisServiceMock.setWithTtl).not.toHaveBeenCalled();
      expect(pairingStateMachineMock.transition).not.toHaveBeenCalled();
    });

    it('stores the ticket in Redis with a 10-minute TTL and records PAIRING_INVITED', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
      pairingStateMachineMock.transition.mockResolvedValue({ id: 'event-1' });

      const result = await service.createInvitation({
        childId: 'child-1',
        familyId: 'family-1',
        initiatedByUserId: 'user-1',
      });

      expect(result.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(result.expiresInSeconds).toBe(600);

      const [key, value, ttl] = redisServiceMock.setWithTtl.mock.calls[0];
      expect(key).toBe(`pairing-invitation:${result.code}`);
      expect(JSON.parse(value)).toEqual({
        childId: 'child-1',
        familyId: 'family-1',
        initiatedByUserId: 'user-1',
      });
      expect(ttl).toBe(600);

      expect(pairingStateMachineMock.transition).toHaveBeenCalledWith({
        childId: 'child-1',
        event: 'PAIRING_INVITED',
        actorType: 'USER',
        actorId: 'user-1',
      });
    });
  });

  describe('redeemInvitation', () => {
    it('throws when the code does not exist (expired, already used, or never issued)', async () => {
      redisServiceMock.getAndDelete.mockResolvedValue(null);

      await expect(service.redeemInvitation('AAAA-BBBB')).rejects.toBeInstanceOf(
        InvalidOrExpiredInvitationException,
      );
      expect(pairingStateMachineMock.transition).not.toHaveBeenCalled();
    });

    it('is one-time use: reads via getAndDelete, then records PAIRING_ACCEPTED', async () => {
      redisServiceMock.getAndDelete.mockResolvedValue(
        JSON.stringify({ childId: 'child-1', familyId: 'family-1', initiatedByUserId: 'user-1' }),
      );
      pairingStateMachineMock.transition.mockResolvedValue({ id: 'event-2' });

      const result = await service.redeemInvitation('ABCD-1234');

      expect(redisServiceMock.getAndDelete).toHaveBeenCalledWith('pairing-invitation:ABCD-1234');
      expect(redisServiceMock.getAndDelete).toHaveBeenCalledTimes(1);
      expect(pairingStateMachineMock.transition).toHaveBeenCalledWith({
        childId: 'child-1',
        event: 'PAIRING_ACCEPTED',
        actorType: 'DEVICE',
      });
      expect(result).toEqual({ childId: 'child-1', familyId: 'family-1', initiatedByUserId: 'user-1' });
    });
  });
});
