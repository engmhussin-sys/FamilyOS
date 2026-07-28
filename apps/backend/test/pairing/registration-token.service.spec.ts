import { Test } from '@nestjs/testing';
import { RegistrationTokenService } from '../../src/modules/pairing/application/services/registration-token.service';
import { RedisService } from '../../src/common/redis/redis.service';
import { InvalidOrConsumedRegistrationTokenException } from '../../src/modules/pairing/domain/registration-token.errors';

describe('RegistrationTokenService', () => {
  const redisServiceMock = { setWithTtl: jest.fn(), getAndDelete: jest.fn() };

  let service: RegistrationTokenService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [RegistrationTokenService, { provide: RedisService, useValue: redisServiceMock }],
    }).compile();
    service = moduleRef.get(RegistrationTokenService);
  });

  describe('issue', () => {
    it('generates a 64-hex-char token and stores it hashed, with a 5-minute TTL', async () => {
      const result = await service.issue({ childId: 'child-1', familyId: 'family-1' });

      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.expiresInSeconds).toBe(300);

      const [key, value, ttl] = redisServiceMock.setWithTtl.mock.calls[0];
      // The raw token must never appear as the Redis key — only its hash.
      expect(key).not.toContain(result.token);
      expect(key.startsWith('pairing-registration-token:')).toBe(true);
      expect(JSON.parse(value)).toEqual({ childId: 'child-1', familyId: 'family-1' });
      expect(ttl).toBe(300);
    });

    it('generates a different token on every call', async () => {
      const first = await service.issue({ childId: 'child-1', familyId: 'family-1' });
      const second = await service.issue({ childId: 'child-1', familyId: 'family-1' });
      expect(first.token).not.toBe(second.token);
    });
  });

  describe('consume', () => {
    it('throws for an unknown/expired/already-consumed token', async () => {
      redisServiceMock.getAndDelete.mockResolvedValue(null);

      await expect(service.consume('a'.repeat(64))).rejects.toBeInstanceOf(
        InvalidOrConsumedRegistrationTokenException,
      );
    });

    it('returns the child/family binding on a valid token, via getAndDelete (atomic single-use)', async () => {
      redisServiceMock.getAndDelete.mockResolvedValue(
        JSON.stringify({ childId: 'child-1', familyId: 'family-1' }),
      );

      const result = await service.consume('a'.repeat(64));

      expect(result).toEqual({ childId: 'child-1', familyId: 'family-1' });
      expect(redisServiceMock.getAndDelete).toHaveBeenCalledTimes(1);
    });

    it('a second consume() of the same token fails once Redis has deleted it (simulated)', async () => {
      redisServiceMock.getAndDelete.mockResolvedValueOnce(
        JSON.stringify({ childId: 'child-1', familyId: 'family-1' }),
      );
      redisServiceMock.getAndDelete.mockResolvedValueOnce(null); // second call: already deleted

      await service.consume('a'.repeat(64));
      await expect(service.consume('a'.repeat(64))).rejects.toBeInstanceOf(
        InvalidOrConsumedRegistrationTokenException,
      );
    });
  });
});
