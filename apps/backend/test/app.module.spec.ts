import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';

/**
 * Sets required env vars BEFORE importing AppModule. This has to be a
 * dynamic import inside the test (not a static top-level import) because
 * ES module imports are hoisted and evaluated before any test code runs —
 * a static `import { AppModule }` would hit ConfigModule's env validation
 * (see src/config/env.validation.ts) before `process.env` is set here.
 *
 * PrismaService and RedisService are overridden with no-op stand-ins:
 * this test's job is to verify the DI graph wires up correctly (no
 * missing providers, no circular dependencies) across every module —
 * NOT to verify live database/Redis connectivity, which belongs to the
 * integration tests in test/database/ that run against docker-compose.
 */
describe('AppModule DI graph', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
  });

  it('resolves every provider across every module without a missing-dependency or circular-import error', async () => {
    const { AppModule } = await import('../src/app.module');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(RedisService)
      .useValue({ setWithTtl: jest.fn(), get: jest.fn(), getAndDelete: jest.fn() })
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
