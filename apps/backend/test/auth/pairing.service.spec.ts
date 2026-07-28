import { Test } from '@nestjs/testing';
import { PairingService } from '../../src/modules/auth/application/services/pairing.service';
import { PasswordService } from '../../src/modules/auth/application/services/password.service';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { DEVICE_REPOSITORY } from '../../src/modules/auth/application/ports/auth.repository.ports';
import { InvalidOrExpiredPairingCodeException } from '../../src/modules/auth/domain/auth.errors';
import { ChildNotFoundException } from '../../src/modules/children/domain/child.errors';

describe('PairingService', () => {
  const redisServiceMock = { setWithTtl: jest.fn(), getAndDelete: jest.fn() };
  const passwordServiceMock = { generatePairingCode: jest.fn() };
  const tokenServiceMock = { issueTokenPair: jest.fn() };
  const deviceRepositoryMock = { createPairedChildDevice: jest.fn() };
  const childrenServiceMock = { assertChildBelongsToFamily: jest.fn() };

  let pairingService: PairingService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PairingService,
        { provide: RedisService, useValue: redisServiceMock },
        { provide: PasswordService, useValue: passwordServiceMock },
        { provide: TokenService, useValue: tokenServiceMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: DEVICE_REPOSITORY, useValue: deviceRepositoryMock },
      ],
    }).compile();

    pairingService = moduleRef.get(PairingService);
  });

  describe('initiate', () => {
    it('rejects with ChildNotFoundException when the child does not belong to the caller\'s family, before touching Redis', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockRejectedValue(
        new ChildNotFoundException('child-1'),
      );

      await expect(
        pairingService.initiate({
          familyId: 'family-1',
          childId: 'child-1',
          initiatedByUserId: 'user-1',
        }),
      ).rejects.toBeInstanceOf(ChildNotFoundException);

      expect(redisServiceMock.setWithTtl).not.toHaveBeenCalled();
    });

    it('stores the pairing ticket in Redis under the generated code, with a TTL, once ownership is confirmed', async () => {
      childrenServiceMock.assertChildBelongsToFamily.mockResolvedValue(undefined);
      passwordServiceMock.generatePairingCode.mockReturnValue('ABCD-1234');

      const result = await pairingService.initiate({
        familyId: 'family-1',
        childId: 'child-1',
        initiatedByUserId: 'user-1',
      });

      expect(result.code).toBe('ABCD-1234');
      expect(result.expiresInSeconds).toBe(600);
      expect(redisServiceMock.setWithTtl).toHaveBeenCalledWith(
        'device-pairing:ABCD-1234',
        JSON.stringify({ familyId: 'family-1', childId: 'child-1', initiatedByUserId: 'user-1' }),
        600,
      );
    });
  });

  describe('confirm', () => {
    it('throws when the code does not exist (expired, already used, or never issued)', async () => {
      redisServiceMock.getAndDelete.mockResolvedValue(null);

      await expect(
        pairingService.confirm({ code: 'AAAA-BBBB', platform: 'ANDROID' }, {}),
      ).rejects.toBeInstanceOf(InvalidOrExpiredPairingCodeException);

      expect(deviceRepositoryMock.createPairedChildDevice).not.toHaveBeenCalled();
    });

    it('creates the device and issues device-bound tokens on a valid code', async () => {
      redisServiceMock.getAndDelete.mockResolvedValue(
        JSON.stringify({ familyId: 'family-1', childId: 'child-1', initiatedByUserId: 'user-1' }),
      );
      deviceRepositoryMock.createPairedChildDevice.mockResolvedValue({ id: 'device-1' });
      tokenServiceMock.issueTokenPair.mockResolvedValue({
        accessToken: 'device-access',
        refreshToken: 'device-refresh',
        accessTokenExpiresInSeconds: 900,
        refreshTokenExpiresInSeconds: 2_592_000,
      });

      const result = await pairingService.confirm(
        { code: 'ABCD-1234', platform: 'ANDROID', deviceModel: 'Pixel 8' },
        { ipAddress: '10.0.0.1' },
      );

      expect(deviceRepositoryMock.createPairedChildDevice).toHaveBeenCalledWith(
        expect.objectContaining({ familyId: 'family-1', childId: 'child-1', platform: 'ANDROID' }),
      );
      expect(tokenServiceMock.issueTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({ subjectId: 'device-1', actorType: 'DEVICE', familyId: 'family-1' }),
      );
      expect(result.tokens.accessToken).toBe('device-access');
      expect(result.childId).toBe('child-1');
    });

    it('is a one-time code: the Redis key is read-and-deleted atomically', async () => {
      redisServiceMock.getAndDelete.mockResolvedValue(
        JSON.stringify({ familyId: 'family-1', childId: 'child-1', initiatedByUserId: 'user-1' }),
      );
      deviceRepositoryMock.createPairedChildDevice.mockResolvedValue({ id: 'device-1' });
      tokenServiceMock.issueTokenPair.mockResolvedValue({
        accessToken: 'a',
        refreshToken: 'r',
        accessTokenExpiresInSeconds: 900,
        refreshTokenExpiresInSeconds: 2_592_000,
      });

      await pairingService.confirm({ code: 'ABCD-1234', platform: 'IOS' }, {});

      expect(redisServiceMock.getAndDelete).toHaveBeenCalledWith('device-pairing:ABCD-1234');
      expect(redisServiceMock.getAndDelete).toHaveBeenCalledTimes(1);
    });
  });
});
