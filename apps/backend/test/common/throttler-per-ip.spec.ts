/**
 * SA-004 regression suite.
 *
 * Two independent defects made every one of the 27 `@Throttle` decorators
 * in this codebase inert in any real deployment:
 *
 *   1. `main.ts` never set Express's `trust proxy`, so behind the reverse
 *      proxy this app always runs behind, `req.ip` was the proxy's own
 *      address — identical for every client on earth. One shared bucket.
 *   2. `ThrottlerModule.forRoot()` used the default in-process `Map`, so
 *      limits multiplied by the replica count and reset on every deploy.
 *
 * This suite proves (1) end to end over real HTTP: with `trust proxy`
 * configured, two different `X-Forwarded-For` clients get INDEPENDENT
 * buckets, and without it they share one. (2) is proven against a real
 * Redis server in test/common/redis-throttler.storage.spec.ts.
 */
import { INestApplication } from '@nestjs/common';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request = require('supertest');

import { configureTrustProxy, TRUSTED_PROXY_HOP_COUNT } from '../../src/common/http/trust-proxy';

@Controller('limited')
class LimitedController {
  @Get()
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  hit(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
  controllers: [LimitedController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
class ThrottleTestModule {}

async function bootstrap(trustProxy: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ThrottleTestModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  if (trustProxy) configureTrustProxy(app);
  await app.init();
  return app;
}

const CLIENT_A = '203.0.113.10';
const CLIENT_B = '198.51.100.20';

describe('SA-004 — rate limiting is per client IP behind a proxy', () => {
  it('is a hop count, not `true` (a forged X-Forwarded-For must not mint new buckets)', () => {
    expect(TRUSTED_PROXY_HOP_COUNT).toBe(1);
    expect(typeof TRUSTED_PROXY_HOP_COUNT).toBe('number');
  });

  describe('with trust proxy configured (the fixed behaviour)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootstrap(true);
    });

    afterAll(async () => {
      await app?.close();
    });

    it('gives two different client IPs independent buckets', async () => {
      const server = app.getHttpServer();

      // Client A burns its whole allowance (limit 2).
      expect((await request(server).get('/limited').set('X-Forwarded-For', CLIENT_A)).status).toBe(200);
      expect((await request(server).get('/limited').set('X-Forwarded-For', CLIENT_A)).status).toBe(200);
      const aThird = await request(server).get('/limited').set('X-Forwarded-For', CLIENT_A);
      expect(aThird.status).toBe(429);

      // Client B is untouched by A's exhaustion — this is the assertion
      // that fails without `trust proxy`.
      expect((await request(server).get('/limited').set('X-Forwarded-For', CLIENT_B)).status).toBe(200);
      expect((await request(server).get('/limited').set('X-Forwarded-For', CLIENT_B)).status).toBe(200);
      expect((await request(server).get('/limited').set('X-Forwarded-For', CLIENT_B)).status).toBe(429);

      // ...and A is still blocked, i.e. B's traffic did not reset A.
      expect((await request(server).get('/limited').set('X-Forwarded-For', CLIENT_A)).status).toBe(429);
    });

    it('reads the client address the trusted proxy appended', async () => {
      const app2 = await bootstrap(true);
      const server = app2.getHttpServer();
      // A forged chain: the client claims to be 10.0.0.1, the trusted
      // proxy appended the real address last. Hop count 1 takes the
      // proxy's entry, not the client's claim, so both requests below
      // land in the SAME bucket.
      expect(
        (await request(server).get('/limited').set('X-Forwarded-For', `10.0.0.1, ${CLIENT_A}`)).status,
      ).toBe(200);
      expect(
        (await request(server).get('/limited').set('X-Forwarded-For', `10.0.0.2, ${CLIENT_A}`)).status,
      ).toBe(200);
      expect(
        (await request(server).get('/limited').set('X-Forwarded-For', `10.0.0.3, ${CLIENT_A}`)).status,
      ).toBe(429);
      await app2.close();
    });
  });

  describe('without trust proxy (the SA-004 defect, kept as a control)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootstrap(false);
    });

    afterAll(async () => {
      await app?.close();
    });

    it('makes every client share ONE bucket — B is blocked by A traffic it never sent', async () => {
      const server = app.getHttpServer();

      expect((await request(server).get('/limited').set('X-Forwarded-For', CLIENT_A)).status).toBe(200);
      expect((await request(server).get('/limited').set('X-Forwarded-For', CLIENT_A)).status).toBe(200);

      const bFirst = await request(server).get('/limited').set('X-Forwarded-For', CLIENT_B);
      expect(bFirst.status).toBe(429);
    });
  });
});
