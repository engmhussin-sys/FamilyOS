import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../src/common/redis/redis.service';

// Mocks the ioredis client itself — verifies getAndDelete issues the
// correct atomic Lua script via eval(), not that Redis's server-side
// atomicity guarantee holds under real concurrent load (that requires
// a real Redis instance — noted honestly at the bottom of this file).
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    eval: jest.fn(),
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    ping: jest.fn(),
    quit: jest.fn(),
  }));
});

describe('RedisService', () => {
  let service: RedisService;
  let mockClient: any;

  beforeEach(() => {
    const configServiceMock = {
      getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379'),
    } as unknown as ConfigService;
    service = new RedisService(configServiceMock);
    mockClient = (service as any).client;
  });

  describe('getAndDelete (Beta Validation — Replay Attack fix)', () => {
    it('uses eval() with a Lua script — NOT a separate get() + del() call', async () => {
      mockClient.eval.mockResolvedValue('the-stored-value');

      const result = await service.getAndDelete('some-key');

      expect(mockClient.eval).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('GET'"),
        1,
        'some-key',
      );
      expect(mockClient.get).not.toHaveBeenCalled();
      expect(mockClient.del).not.toHaveBeenCalled();
      expect(result).toBe('the-stored-value');
    });

    it('the Lua script only calls DEL when GET found a value', () => {
      const script = (RedisService as any).GET_AND_DELETE_SCRIPT as string;
      expect(script).toContain("if v then redis.call('DEL', KEYS[1]) end");
    });

    it('returns null when the key does not exist', async () => {
      mockClient.eval.mockResolvedValue(null);
      await expect(service.getAndDelete('missing-key')).resolves.toBeNull();
    });
  });

  describe('ping', () => {
    it('delegates to the underlying client', async () => {
      await service.ping();
      expect(mockClient.ping).toHaveBeenCalled();
    });
  });
});
