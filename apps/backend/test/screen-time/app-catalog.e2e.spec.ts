/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * THE APP CATALOGUE, PROVEN AGAINST A REAL POSTGRESQL OVER THE REAL DEPLOYED
 * HTTP PIPELINE.
 *
 * `app-catalog.service.spec.ts` pins the two decisions the service makes with
 * mocked ports. This suite proves the things only a running server and a real
 * database can prove, and it boots through `applyGlobalHttpPipeline` — THE SAME
 * FUNCTION `main.ts` CALLS — so every request below crosses the real `api/v1`
 * prefix, the real `forbidNonWhitelisted: true` pipe, the real guard chain, the
 * real tenant extension and the real `GlobalExceptionFilter`.
 *
 * WHAT IT ASSERTS, and why each one is here rather than in the unit spec:
 *
 *   1. A parent in family A cannot see family B's apps. Isolation is a property
 *      of the tenant extension and the ownership assertion together; neither is
 *      observable with a mocked repository.
 *   2. IDEMPOTENCY BY REPLAY. The same inventory is posted twice and the ROWS
 *      are counted in PostgreSQL. That is a claim about
 *      `app_catalog_entries_device_id_package_name_key`, not about a code path,
 *      so no assertion here looks at a code path.
 *   3. A child cannot write another child's or another family's catalogue, even
 *      with the ids in the body.
 *   4. The parent payload's OWN KEYS carry no `deviceId` and no `familyId` —
 *      asserted on the keys of the JSON a client actually receives, never on a
 *      TypeScript type, because a type is not what crosses the wire.
 *   5. Ordering (most-recently-used first, nulls last, then name) and the
 *      result cap, measured on 600 seeded rows.
 *   6. The validation boundary: an oversized array, a bogus package name, a
 *      hostile icon URL and a future timestamp.
 *
 * RE-RUNNABLE ON A DIRTY DATABASE, ON PURPOSE. Every family, child, device and
 * package name is stamped with `Date.now()`, and every count is scoped to a
 * device this run created. A suite that only passes against a freshly migrated
 * database is a suite that will fail on the second run, and this repository has
 * been bitten by exactly that.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline, API_GLOBAL_PREFIX } from '../../src/common/http/global-pipeline';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import {
  APP_CATALOG_PARENT_RESULT_CAP,
  MAX_APPS_PER_INVENTORY_REPORT,
} from '../../src/modules/screen-time/domain/app-catalog.types';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;
const V = `/${API_GLOBAL_PREFIX}`;

/** The EXACT keys the contract promises a parent, and nothing else. */
const PROMISED_KEYS = ['appName', 'category', 'firstSeenAt', 'iconUrl', 'id', 'lastUsedAt', 'packageName'];

function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client/wasm');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const base = new PrismaClient({ adapter: new PrismaPg(pool) });
    const extended = base.$extends(createTenantExtension());
    extended.onModuleInit = async () => undefined;
    extended.onModuleDestroy = async () => {
      await base.$disconnect();
      await pool.end();
    };
    return extended;
  }
  const { PrismaClient } = require('@prisma/client');
  const base = new PrismaClient({ datasources: { db: { url } } });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

interface Kid {
  childId: string;
  deviceId: string;
  deviceToken: string;
}

interface Tenant {
  familyId: string;
  parentToken: string;
  kids: Kid[];
}

describeIfDb('the app catalogue over the real deployed HTTP pipeline', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let tokens: TokenService;

  const stamp = Date.now();
  const A: Tenant = { familyId: '', parentToken: '', kids: [] };
  const B: Tenant = { familyId: '', parentToken: '', kids: [] };

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `app-catalog suite: ${what}`, async () => await fn());

  const asParent = (t: Tenant) => ({ Authorization: `Bearer ${t.parentToken}` });
  const asChild = (k: Kid) => ({ Authorization: `Bearer ${k.deviceToken}` });

  /** Rows on ONE device, counted in PostgreSQL rather than inferred from a
   * response — the idempotency claim is about the table. */
  const rowsOnDevice = (deviceId: string): Promise<number> =>
    sys('count rows on device', () => prisma.appCatalogEntry.count({ where: { deviceId } }));

  async function registerTenant(label: string, t: Tenant, kidCount: number): Promise<void> {
    const email = `appcatalog.${label}.${stamp}@example.com`;
    const password = 'App-Catalogue-Passw0rd!23';

    const reg = await request(http).post(`${V}/auth/register`).send({
      email,
      password,
      fullName: `Catalogue Parent ${label}`,
      familyName: `Catalogue Family ${label}`,
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register(${label}) -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }

    const login = await request(http).post(`${V}/auth/login`).send({ email, password });
    t.parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(t.parentToken.split('.')[1], 'base64').toString());
    t.familyId = claims.familyId;

    for (let i = 0; i < kidCount; i += 1) {
      // Seeded, not created over HTTP: the free plan entitles a family to ONE
      // child (`POST /children` answers PLAN_UPGRADE_REQUIRED for the second),
      // and this suite is about the catalogue rather than about billing. Same
      // fixture shape `cross-tenant-probe.e2e.spec.ts` uses for the same reason.
      const child = await sys('seed child', () =>
        prisma.child.create({
          data: { familyId: t.familyId, firstName: `Kid ${label}${i}`, dateOfBirth: new Date('2015-06-01') },
          select: { id: true },
        }),
      );

      const device = await sys('seed device', () =>
        prisma.device.create({
          data: {
            familyId: t.familyId,
            ownerType: 'CHILD',
            childId: child.id,
            platform: 'ANDROID',
            status: 'ACTIVE',
            pairedAt: new Date(),
          },
          select: { id: true },
        }),
      );
      const pair = await runWithTenant(
        { familyId: t.familyId, actorType: 'DEVICE', actorId: device.id },
        () => tokens.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId: t.familyId }),
      );
      t.kids.push({ childId: child.id, deviceId: device.id, deviceToken: pair.accessToken });
    }
  }

  /** Clears the IP-keyed throttle counters. Every e2e suite in this repository
   * calls from 127.0.0.1 and the global limit is 100/min, so without this a
   * later suite fails on a FIXTURE for a reason unrelated to what it asserts —
   * `child-catalogue.e2e.spec.ts` carries the same block, for the same reason.
   * It clears counters, never an assertion. */
  async function clearThrottle(): Promise<void> {
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL as string);
    const keys = await client.keys('throttle:*');
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  }

  beforeAll(async () => {
    await clearThrottle();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useFactory({ factory: offlinePrismaService })
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();

    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    // A: kid 0 = the ordinary device, kid 1 = the sibling nobody may write to,
    // kid 2 = the ordering fixture, kid 3 = the cap fixture.
    await registerTenant('a', A, 4);
    await registerTenant('b', B, 1);
  }, 300000);

  // The suite makes well over a hundred calls from one IP; the global limiter
  // is 100/min. Same reasoning as `clearThrottle`'s own comment.
  beforeEach(async () => {
    await clearThrottle();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const pkg = (suffix: string) => `com.abny${stamp}.${suffix}`;

  // =========================================================================
  // 1. THE CONTRACT: WHO REACHES IT, AND WHAT COMES BACK
  // =========================================================================

  describe('the two surfaces, and the wall between them', () => {
    it('a DEVICE token posts an inventory; the parent then reads it back', async () => {
      const post = await request(http)
        .post(`${V}/self/apps`)
        .set(asChild(A.kids[0]))
        .send({
          apps: [
            { packageName: pkg('alpha'), appName: 'Alpha', category: 'GAME', iconUrl: 'https://cdn.example.com/a.png' },
            { packageName: pkg('beta'), appName: 'Beta' },
            { packageName: pkg('gamma'), appName: 'Gamma', lastUsedAt: new Date(Date.now() - 60_000).toISOString() },
          ],
        });
      expect([200, 201]).toContain(post.status);
      expect(post.body).toEqual({ upserted: 3 });

      const read = await request(http).get(`${V}/children/${A.kids[0].childId}/apps`).set(asParent(A));
      expect(read.status).toBe(200);
      expect(read.body.items.map((i: any) => i.packageName).sort()).toEqual(
        [pkg('alpha'), pkg('beta'), pkg('gamma')].sort(),
      );
    });

    it('a PARENT token cannot post an inventory, and a DEVICE token cannot read the parent list', async () => {
      const parentPost = await request(http)
        .post(`${V}/self/apps`)
        .set(asParent(A))
        .send({ apps: [{ packageName: pkg('nope'), appName: 'Nope' }] });
      expect([401, 403]).toContain(parentPost.status);

      const deviceRead = await request(http)
        .get(`${V}/children/${A.kids[0].childId}/apps`)
        .set(asChild(A.kids[0]));
      expect([401, 403]).toContain(deviceRead.status);
    });

    it('neither surface answers an unauthenticated caller', async () => {
      const read = await request(http).get(`${V}/children/${A.kids[0].childId}/apps`);
      expect([401, 403]).toContain(read.status);

      const post = await request(http)
        .post(`${V}/self/apps`)
        .send({ apps: [{ packageName: pkg('nope'), appName: 'Nope' }] });
      expect([401, 403]).toContain(post.status);
    });
  });

  // =========================================================================
  // 2. THE RESPONSE SHAPE — ASSERTED ON THE ACTUAL KEYS
  // =========================================================================

  describe('what the parent payload is allowed to contain', () => {
    it('carries EXACTLY the promised keys — no deviceId, no familyId, on any item', async () => {
      const res = await request(http).get(`${V}/children/${A.kids[0].childId}/apps`).set(asParent(A));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['items']);
      expect(res.body.items.length).toBeGreaterThan(0);

      for (const item of res.body.items) {
        // The keys of the JSON a client really receives — not a type, which is
        // erased long before this byte stream exists.
        expect(Object.keys(item).sort()).toEqual(PROMISED_KEYS);
      }
    });

    it('does not carry the device id or the family id ANYWHERE in the body, under any key name', async () => {
      const res = await request(http).get(`${V}/children/${A.kids[0].childId}/apps`).set(asParent(A));
      const raw = JSON.stringify(res.body);

      expect(raw).not.toContain(A.kids[0].deviceId);
      expect(raw).not.toContain(A.familyId);
      // Non-vacuity: the ids really are strings that a leak WOULD show up as.
      expect(A.kids[0].deviceId.length).toBeGreaterThan(30);
      expect(raw).toContain(pkg('alpha'));
    });

    it('states the absent fields as null rather than omitting them — a picker needs a shape it can trust', async () => {
      const res = await request(http).get(`${V}/children/${A.kids[0].childId}/apps`).set(asParent(A));
      const beta = res.body.items.find((i: any) => i.packageName === pkg('beta'));
      expect(beta).toBeDefined();
      expect(beta.category).toBeNull();
      expect(beta.iconUrl).toBeNull();
      expect(beta.lastUsedAt).toBeNull();
      expect(beta.firstSeenAt).not.toBeNull();
    });
  });

  // =========================================================================
  // 3. IDEMPOTENCY, PROVEN BY REPLAY
  // =========================================================================

  describe('replaying the same inventory', () => {
    const payload = {
      apps: [
        { packageName: '', appName: 'Replay One' },
        { packageName: '', appName: 'Replay Two' },
      ],
    };

    beforeAll(() => {
      payload.apps[0].packageName = pkg('replay.one');
      payload.apps[1].packageName = pkg('replay.two');
    });

    it('produces the same rows twice — the UNIQUE CONSTRAINT decides, not a check in code', async () => {
      const device = A.kids[0].deviceId;
      const before = await rowsOnDevice(device);

      const first = await request(http).post(`${V}/self/apps`).set(asChild(A.kids[0])).send(payload);
      expect([200, 201]).toContain(first.status);
      const afterFirst = await rowsOnDevice(device);
      expect(afterFirst).toBe(before + 2);

      const second = await request(http).post(`${V}/self/apps`).set(asChild(A.kids[0])).send(payload);
      expect([200, 201]).toContain(second.status);
      expect(second.body).toEqual(first.body);

      // THE ASSERTION THAT MATTERS: the table did not grow.
      expect(await rowsOnDevice(device)).toBe(afterFirst);
    }, 60000);

    it('updates a changed app in place and keeps firstSeenAt — a re-report is not a first sighting', async () => {
      const read = async () => {
        const res = await request(http).get(`${V}/children/${A.kids[0].childId}/apps`).set(asParent(A));
        return res.body.items.find((i: any) => i.packageName === pkg('replay.one'));
      };

      const original = await read();
      expect(original.appName).toBe('Replay One');
      const rowsBefore = await rowsOnDevice(A.kids[0].deviceId);

      const rename = await request(http)
        .post(`${V}/self/apps`)
        .set(asChild(A.kids[0]))
        .send({ apps: [{ packageName: pkg('replay.one'), appName: 'Replay One Renamed' }] });
      expect([200, 201]).toContain(rename.status);

      const updated = await read();
      expect(updated.id).toBe(original.id);
      expect(updated.appName).toBe('Replay One Renamed');
      expect(updated.firstSeenAt).toBe(original.firstSeenAt);
      // An UPDATE, not an insert: the same id, and no new row behind it.
      expect(await rowsOnDevice(A.kids[0].deviceId)).toBe(rowsBefore);
    }, 60000);

    it('counts ROWS, not lines: the same package twice in one report is one row', async () => {
      const device = A.kids[0].deviceId;
      const before = await rowsOnDevice(device);

      const res = await request(http)
        .post(`${V}/self/apps`)
        .set(asChild(A.kids[0]))
        .send({
          apps: [
            { packageName: pkg('dupe'), appName: 'First' },
            { packageName: pkg('dupe'), appName: 'Second' },
          ],
        });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toEqual({ upserted: 1 });
      expect(await rowsOnDevice(device)).toBe(before + 1);
    }, 60000);
  });

  // =========================================================================
  // 4. TENANCY AND OWNERSHIP
  // =========================================================================

  describe('a family cannot see, and a device cannot write, outside itself', () => {
    beforeAll(async () => {
      const res = await request(http)
        .post(`${V}/self/apps`)
        .set(asChild(B.kids[0]))
        .send({ apps: [{ packageName: pkg('familyb.secret'), appName: 'Family B Secret' }] });
      expect([200, 201]).toContain(res.status);
    });

    it("parent A asking for family B's child gets a 404 — never a 403, which would confirm the child exists", async () => {
      const res = await request(http).get(`${V}/children/${B.kids[0].childId}/apps`).set(asParent(A));
      expect(res.status).toBe(404);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(pkg('familyb.secret'));
      expect(raw).not.toContain(B.familyId);
      expect(raw).not.toContain(B.kids[0].deviceId);
    });

    it("family B's apps appear in NO list family A can ask for", async () => {
      for (const kid of A.kids) {
        const res = await request(http).get(`${V}/children/${kid.childId}/apps`).set(asParent(A));
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(pkg('familyb.secret'));
      }

      // …and family B really can see its own, so the assertion above is about
      // isolation and not about a row that was never written.
      const owner = await request(http).get(`${V}/children/${B.kids[0].childId}/apps`).set(asParent(B));
      expect(owner.status).toBe(200);
      expect(owner.body.items.map((i: any) => i.packageName)).toContain(pkg('familyb.secret'));
    });

    it("a device's report lands on ITS OWN device only — the sibling's catalogue stays empty", async () => {
      const sibling = await request(http).get(`${V}/children/${A.kids[1].childId}/apps`).set(asParent(A));
      expect(sibling.status).toBe(200);
      expect(sibling.body.items).toEqual([]);
      expect(await rowsOnDevice(A.kids[1].deviceId)).toBe(0);

      // The first device has plenty of rows, so "empty" is a fact about the
      // sibling and not about the whole table.
      expect(await rowsOnDevice(A.kids[0].deviceId)).toBeGreaterThan(0);
    });

    it('ids in the BODY buy nothing — the sibling and family B are untouched either way', async () => {
      const bodies: Array<Record<string, unknown>> = [
        {
          apps: [{ packageName: pkg('forged.top'), appName: 'Forged' }],
          deviceId: A.kids[1].deviceId,
          childId: A.kids[1].childId,
          familyId: B.familyId,
        },
        {
          apps: [
            {
              packageName: pkg('forged.nested'),
              appName: 'Forged',
              deviceId: B.kids[0].deviceId,
              familyId: B.familyId,
              childId: B.kids[0].childId,
            },
          ],
        },
      ];

      for (const body of bodies) {
        const res = await request(http).post(`${V}/self/apps`).set(asChild(A.kids[0])).send(body);
        // The declared DTO has no such field, so the global
        // `forbidNonWhitelisted` pipe refuses the request outright. Rejecting
        // and ignoring are the same security answer; this pipeline rejects.
        expect(res.status).toBe(400);
      }

      // The claim that actually matters: nothing was written anywhere but
      // where it belongs — and here, nowhere at all.
      expect(await rowsOnDevice(A.kids[1].deviceId)).toBe(0);
      expect(await rowsOnDevice(B.kids[0].deviceId)).toBe(1);

      const forged = await sys('look for forged rows anywhere', () =>
        prisma.appCatalogEntry.count({
          where: { packageName: { in: [pkg('forged.top'), pkg('forged.nested')] } },
        }),
      );
      expect(forged).toBe(0);
    });

    it("family B's device cannot write into family A even though it holds a valid token", async () => {
      const before = await rowsOnDevice(A.kids[0].deviceId);
      const res = await request(http)
        .post(`${V}/self/apps`)
        .set(asChild(B.kids[0]))
        .send({ apps: [{ packageName: pkg('crosswrite'), appName: 'Cross Write' }] });
      expect([200, 201]).toContain(res.status);

      // It succeeded — into ITS OWN device, in ITS OWN family. There is no
      // channel by which it could have named family A's.
      expect(await rowsOnDevice(A.kids[0].deviceId)).toBe(before);
      const inA = await request(http).get(`${V}/children/${A.kids[0].childId}/apps`).set(asParent(A));
      expect(JSON.stringify(inA.body)).not.toContain(pkg('crosswrite'));
    }, 60000);

    it('a REVOKED device cannot keep filing inventories on a token that has not expired yet', async () => {
      const kid = A.kids[1];
      await sys('revoke the device', () =>
        prisma.device.update({ where: { id: kid.deviceId }, data: { status: 'REVOKED' } }),
      );

      const res = await request(http)
        .post(`${V}/self/apps`)
        .set(asChild(kid))
        .send({ apps: [{ packageName: pkg('revoked'), appName: 'Revoked' }] });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await rowsOnDevice(kid.deviceId)).toBe(0);

      await sys('restore the device', () =>
        prisma.device.update({ where: { id: kid.deviceId }, data: { status: 'ACTIVE' } }),
      );
    }, 60000);
  });

  // =========================================================================
  // 5. ORDERING AND THE CAP
  // =========================================================================

  describe('the order a parent reads, and how much of it', () => {
    it('is most-recently-used first, NULLS LAST, then by name', async () => {
      const kid = A.kids[2];
      const base = Date.now() - 3 * 60 * 60 * 1000;
      const res = await request(http)
        .post(`${V}/self/apps`)
        .set(asChild(kid))
        .send({
          apps: [
            { packageName: pkg('order.older'), appName: 'Older', lastUsedAt: new Date(base).toISOString() },
            {
              packageName: pkg('order.newer'),
              appName: 'Newer',
              lastUsedAt: new Date(base + 60 * 60 * 1000).toISOString(),
            },
            { packageName: pkg('order.zeta'), appName: 'Zeta Never Opened' },
            { packageName: pkg('order.alpha'), appName: 'Alpha Never Opened' },
          ],
        });
      expect([200, 201]).toContain(res.status);

      const read = await request(http).get(`${V}/children/${kid.childId}/apps`).set(asParent(A));
      expect(read.status).toBe(200);
      expect(read.body.items.map((i: any) => i.appName)).toEqual([
        'Newer',
        'Older',
        // PostgreSQL would put these two FIRST on a DESC sort without an
        // explicit NULLS LAST, which is the bug this assertion exists for.
        'Alpha Never Opened',
        'Zeta Never Opened',
      ]);
    }, 60000);

    it(`returns at most ${APP_CATALOG_PARENT_RESULT_CAP} rows, and they are the most recently used ones`, async () => {
      const kid = A.kids[3];
      const total = APP_CATALOG_PARENT_RESULT_CAP + 100;
      const base = Date.now() - 24 * 60 * 60 * 1000;

      // Seeded directly: the cap is a property of the READ, and pushing 600
      // rows through the write route would be measuring the wrong thing (and
      // would take three requests to express, since the write is capped too).
      await sys('seed a device past the cap', () =>
        prisma.appCatalogEntry.createMany({
          data: Array.from({ length: total }, (_, i) => ({
            familyId: A.familyId,
            deviceId: kid.deviceId,
            packageName: `${pkg('cap')}.app${String(i).padStart(4, '0')}`,
            appName: `Cap App ${String(i).padStart(4, '0')}`,
            // i = 0,1,2 never opened; the rest descend, so app0003 is newest.
            lastUsedAt: i < 3 ? null : new Date(base - i * 60_000),
          })),
        }),
      );
      expect(await rowsOnDevice(kid.deviceId)).toBe(total);

      const read = await request(http).get(`${V}/children/${kid.childId}/apps`).set(asParent(A));
      expect(read.status).toBe(200);
      expect(read.body.items).toHaveLength(APP_CATALOG_PARENT_RESULT_CAP);

      // The cap keeps the TOP of the order, not an arbitrary page of it.
      expect(read.body.items[0].appName).toBe('Cap App 0003');
      const times = read.body.items.map((i: any) => new Date(i.lastUsedAt).getTime());
      expect(times).toEqual([...times].sort((x, y) => y - x));
      // …and nothing that was never opened displaced something that was.
      expect(read.body.items.some((i: any) => i.lastUsedAt === null)).toBe(false);
    }, 120000);
  });

  // =========================================================================
  // 6. THE VALIDATION BOUNDARY
  // =========================================================================

  describe('what the child surface refuses', () => {
    const post = (apps: unknown) =>
      request(http).post(`${V}/self/apps`).set(asChild(A.kids[0])).send({ apps });

    it(`refuses more than ${MAX_APPS_PER_INVENTORY_REPORT} apps in one report`, async () => {
      const oversized = Array.from({ length: MAX_APPS_PER_INVENTORY_REPORT + 1 }, (_, i) => ({
        packageName: `${pkg('over')}.app${i}`,
        appName: `Over ${i}`,
      }));
      const res = await post(oversized);
      expect(res.status).toBe(400);
      expect(await rowsOnDevice(A.kids[0].deviceId)).toBeGreaterThan(0);

      const written = await sys('nothing from the oversized report landed', () =>
        prisma.appCatalogEntry.count({ where: { packageName: { startsWith: `${pkg('over')}.` } } }),
      );
      expect(written).toBe(0);
    }, 60000);

    it('refuses an empty report — a device with no apps has nothing to say', async () => {
      expect((await post([])).status).toBe(400);
    });

    it('refuses anything that is not a real Android package name', async () => {
      const bogus = [
        'not a package',
        'com', // one segment
        '1leading.digit',
        'com..double',
        'com.example.',
        '../../etc/passwd',
        "com.example'; DROP TABLE app_catalog_entries;--",
        'com.example.app<script>',
      ];
      for (const packageName of bogus) {
        const res = await post([{ packageName, appName: 'Bogus' }]);
        expect({ packageName, status: res.status }).toEqual({ packageName, status: 400 });
      }
    }, 60000);

    it('refuses an over-long app name and an empty one', async () => {
      expect((await post([{ packageName: pkg('len'), appName: '' }])).status).toBe(400);
      expect((await post([{ packageName: pkg('len'), appName: 'x'.repeat(101) }])).status).toBe(400);
    });

    it('refuses every icon URL scheme but https', async () => {
      const hostile = [
        'javascript:alert(1)',
        'data:image/png;base64,iVBORw0KGgo=',
        'file:///etc/passwd',
        'http://cdn.example.com/icon.png',
        'content://com.android.providers/icon',
        '//cdn.example.com/icon.png',
      ];
      for (const iconUrl of hostile) {
        const res = await post([{ packageName: pkg('icon'), appName: 'Icon', iconUrl }]);
        expect({ iconUrl, status: res.status }).toEqual({ iconUrl, status: 400 });
      }

      const ok = await post([
        { packageName: pkg('icon'), appName: 'Icon', iconUrl: 'https://cdn.example.com/icon.png' },
      ]);
      expect([200, 201]).toContain(ok.status);
    }, 60000);

    it('refuses a lastUsedAt from the future, and stores nothing from that report', async () => {
      const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const res = await post([
        { packageName: pkg('future'), appName: 'Future', lastUsedAt: nextYear },
      ]);
      expect(res.status).toBe(400);

      const written = await sys('the future-dated app was not stored', () =>
        prisma.appCatalogEntry.count({ where: { packageName: pkg('future') } }),
      );
      expect(written).toBe(0);
    }, 60000);

    it('accepts ordinary clock skew and CLAMPS it — no future instant is ever stored', async () => {
      const skewed = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      const res = await post([{ packageName: pkg('skew'), appName: 'Skewed', lastUsedAt: skewed }]);
      expect([200, 201]).toContain(res.status);

      const read = await request(http).get(`${V}/children/${A.kids[0].childId}/apps`).set(asParent(A));
      const stored = read.body.items.find((i: any) => i.packageName === pkg('skew'));
      expect(stored).toBeDefined();
      expect(new Date(stored.lastUsedAt).getTime()).toBeLessThan(new Date(skewed).getTime());
      expect(new Date(stored.lastUsedAt).getTime()).toBeLessThanOrEqual(Date.now());
    }, 60000);

    it('refuses a body with no apps field at all', async () => {
      const res = await request(http).post(`${V}/self/apps`).set(asChild(A.kids[0])).send({});
      expect(res.status).toBe(400);
    });
  });
});
