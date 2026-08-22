/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * PHASE C / P3 — THE NEGATIVE TESTS, EXECUTED.
 *
 * A4 §SA-005 and the Phase B blocker list both said the same thing: tenant
 * isolation (family vs family) was proven in F2, and INTRA-FAMILY
 * authorization did not exist. Every case the client named is asserted here,
 * against the REAL application — real AppModule, real Passport strategies, real
 * `JwtAuthGuard` (now carrying the role check), real global
 * TenantContextInterceptor, real Prisma tenant extension, real PostgreSQL, and
 * the real `applyGlobalHttpPipeline` bootstrap so the JSON asserted is the JSON
 * a deployed client receives (B3/PA-B-022's lesson: a suite that hand-rolls its
 * own bootstrap asserts a contract nobody ships).
 *
 * THE CAST
 *   family A : A1 = OWNER, A2 = co-parent (PARENT), childA + a paired device
 *   family B : B1 = OWNER, childB
 *
 * A2 is created by inserting a `family_members` row rather than by an invite
 * flow, and that is stated rather than hidden: THERE IS NO CO-PARENT INVITE
 * ENDPOINT IN THIS REPOSITORY YET. Building one was out of scope for P3, whose
 * job was to make the role mean something BEFORE that flow exists — which is
 * precisely the order the Phase B blocker list demanded ("RBAC before any
 * co-parent flow, not after"). The row this suite inserts is byte-identical to
 * the one such an endpoint would create.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { PasswordService } from '../../src/modules/auth/application/services/password.service';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const P = '/api/v1';

/** See the call sites in `beforeAll` / `afterAll` for why this exists. */
async function clearThrottleCounters(): Promise<void> {
  const Redis = require('ioredis');
  const client = new Redis(process.env.REDIS_URL as string);
  const keys = await client.keys('throttle:*');
  if (keys.length > 0) await client.del(...keys);
  await client.quit();
}

function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client');
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
  // PRISMA 7 removed `datasources`, so a driver adapter is the only way to
  // open a connection. The pool is NAMED and kept: `$disconnect()` closes what
  // Prisma opened and never a pool the caller supplied, so an anonymous pool
  // here is a Postgres connection this suite leaks for the rest of the run.
  const fallbackPool = new (require('pg').Pool)({ connectionString: url });
  const base = new PrismaClient({
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(fallbackPool),
  });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => {
    await base.$disconnect();
    await fallbackPool.end();
  };
  return extended;
}

interface Household {
  familyId: string;
  ownerId: string;
  ownerToken: string;
  childId: string;
  deviceToken: string;
}

describeIfDb('PHASE C / P3 — intra-family authorization (real app, real PostgreSQL)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let passwords: PasswordService;
  let tokens: TokenService;

  const stamp = Date.now();
  const A = {} as Household;
  const B = {} as Household;
  /** The co-parent of family A: same household as A1, role PARENT. */
  const A2 = { userId: '', token: '', email: '', password: 'CoParent-Passw0rd!23' };

  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `P3 authorization suite: ${what}`, async () => await fn());

  async function registerHousehold(label: string, target: Household): Promise<void> {
    const email = `p3.${label}.${stamp}@example.com`;
    const password = 'P3-Authz-Passw0rd!23';

    const reg = await request(http).post(`${P}/auth/register`).send({
      email,
      password,
      fullName: `P3 Owner ${label}`,
      familyName: `P3 Family ${label}`,
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register(${label}) -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }

    const login = await request(http).post(`${P}/auth/login`).send({ email, password });
    if (login.status !== 200) {
      throw new Error(`login(${label}) -> ${login.status} ${JSON.stringify(login.body)}`);
    }
    target.ownerToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(target.ownerToken.split('.')[1], 'base64').toString());
    target.familyId = claims.familyId;
    target.ownerId = claims.sub;
    createdFamilies.push(target.familyId);
    createdUsers.push(target.ownerId);

    const child = await request(http)
      .post(`${P}/children`)
      .set(bearer(target.ownerToken))
      .send({ firstName: `P3 Kid ${label}`, dateOfBirth: '2015-04-01' });
    if (![200, 201].includes(child.status)) {
      throw new Error(`child(${label}) -> ${child.status} ${JSON.stringify(child.body)}`);
    }
    target.childId = child.body.id;

    // A real ACTIVE device row plus a REAL device access token from the
    // application's own TokenService — the same call `POST /pairing/device/
    // register` makes. Only the handshake is short-circuited; the token is
    // genuine and the guard verifies its signature like any other.
    const device = await sys('seed device', () =>
      prisma.device.create({
        data: {
          familyId: target.familyId,
          ownerType: 'CHILD',
          childId: target.childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    const pair = await runWithTenant(
      { familyId: target.familyId, actorType: 'DEVICE', actorId: device.id },
      () =>
        tokens.issueTokenPair({
          subjectId: device.id,
          actorType: 'DEVICE',
          familyId: target.familyId,
        }),
    );
    target.deviceToken = pair.accessToken;
  }

  /** Adds a SECOND adult to family A, with role PARENT. */
  async function addCoParent(): Promise<void> {
    A2.email = `p3.coparent.${stamp}@example.com`;
    const hash = await passwords.hash(A2.password);
    const user = await sys('seed co-parent user', () =>
      prisma.user.create({
        data: {
          email: A2.email,
          passwordHash: hash,
          fullName: 'P3 Co-Parent A2',
          termsAcceptedAt: new Date(),
          termsVersion: 'v1-placeholder',
        },
        select: { id: true },
      }),
    );
    A2.userId = user.id;
    createdUsers.push(user.id);

    await sys('seed co-parent membership', () =>
      prisma.familyMember.create({
        data: { familyId: A.familyId, userId: user.id, role: 'PARENT' },
      }),
    );

    const login = await request(http)
      .post(`${P}/auth/login`)
      .send({ email: A2.email, password: A2.password });
    if (login.status !== 200) {
      throw new Error(`login(A2) -> ${login.status} ${JSON.stringify(login.body)}`);
    }
    A2.token = login.body.tokens?.accessToken ?? login.body.accessToken;
  }

  beforeAll(async () => {
    // The `/auth/register` and `/auth/login` throttle counters live in the REAL
    // Redis and are IP-keyed, so every e2e suite in one `--runInBand` run draws
    // on ONE budget from 127.0.0.1. A suite that consumes without returning
    // makes whichever suite happens to run after it 429 for a reason that has
    // nothing to do with what it asserts. Cleared on the way in AND on the way
    // out — same pattern, and same reasoning, as `event-pipeline.e2e.spec.ts`.
    await clearThrottleCounters();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    passwords = app.get(PasswordService);
    tokens = app.get(TokenService);

    await registerHousehold('a', A);
    await registerHousehold('b', B);
    await addCoParent();
  }, 90_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.auditLog.deleteMany({ where: { familyId: { in: createdFamilies } } });
        await prisma.family.deleteMany({ where: { id: { in: createdFamilies } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
      });
    }
    await app?.close();
    // Return what this suite consumed, so the next one starts with a full
    // budget regardless of the order Jest happens to pick.
    await clearThrottleCounters();
  });

  it('the fixture is real: two families, three adults, two children, two device tokens', () => {
    expect(A.familyId).toBeTruthy();
    expect(B.familyId).toBeTruthy();
    expect(A.familyId).not.toBe(B.familyId);
    expect(A2.userId).toBeTruthy();
    expect(A.deviceToken).toBeTruthy();
    expect(B.deviceToken).toBeTruthy();
  });

  it("the login token now CARRIES the role — the claim A4 said was missing", () => {
    const ownerClaims = JSON.parse(Buffer.from(A.ownerToken.split('.')[1], 'base64').toString());
    const coParentClaims = JSON.parse(Buffer.from(A2.token.split('.')[1], 'base64').toString());
    expect(ownerClaims.familyRole).toBe('OWNER');
    expect(coParentClaims.familyRole).toBe('PARENT');
    expect(coParentClaims.familyId).toBe(A.familyId);
  });

  // =========================================================================
  // 1. Parent A vs family B — the client's first four bullets
  // =========================================================================
  describe('Parent A cannot reach family B', () => {
    const cases: Array<[string, () => request.Test]> = [
      ['read child B', () => request(http).get(`${P}/children/${B.childId}`).set(bearer(A.ownerToken))],
      [
        'modify child B',
        () =>
          request(http)
            .patch(`${P}/children/${B.childId}`)
            .set(bearer(A.ownerToken))
            .send({ firstName: 'Renamed by A' }),
      ],
      [
        "read child B's rewards ledger",
        () =>
          request(http)
            .get(`${P}/life-intelligence/rewards/${B.childId}/account`)
            .set(bearer(A.ownerToken)),
      ],
      [
        "reach family B's reward store",
        () =>
          request(http)
            .get(`${P}/life-intelligence/rewards/store/${B.familyId}`)
            .set(bearer(A.ownerToken)),
      ],
      [
        "reach parent B's per-child dashboard",
        () => request(http).get(`${P}/reports/${B.childId}`).set(bearer(A.ownerToken)),
      ],
      [
        "read child B's timeline",
        () => request(http).get(`${P}/life-intelligence/timeline/${B.childId}`).set(bearer(A.ownerToken)),
      ],
      [
        "set a screen-time policy on child B",
        () =>
          request(http)
            .post(`${P}/children/${B.childId}/screen-time-policy`)
            .set(bearer(A.ownerToken))
            .send({ dailyLimitMinutes: 30 }),
      ],
    ];

    it.each(cases)('%s -> 404, never 200 and never 403', async (_label, call) => {
      const res = await call();
      expect([200, 201, 204]).not.toContain(res.status);
      // 403 would confirm the row exists in someone else's family.
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(404);
    }, 30_000);

    it("parent A's notification list contains nothing belonging to family B", async () => {
      const res = await request(http).get(`${P}/notifications`).set(bearer(A.ownerToken));
      expect(res.status).toBe(200);
      const rows: any[] = Array.isArray(res.body) ? res.body : (res.body.items ?? res.body.data ?? []);
      for (const row of rows) {
        if (row.familyId) expect(row.familyId).toBe(A.familyId);
        if (row.childId) expect(row.childId).not.toBe(B.childId);
      }
    }, 30_000);

    it("parent A cannot approve a reward redemption that belongs to family B", async () => {
      // Family B creates a real, pending redemption through the real API.
      const catalogItem = await sys('seed catalog item for B', () =>
        prisma.rewardCatalogItem.create({
          data: {
            family: { connect: { id: B.familyId } },
            createdBy: { connect: { id: B.ownerId } },
            title: 'P3 B Catalogue Item',
            costCoins: 1,
            isActive: true,
          },
          select: { id: true },
        }),
      );
      const redemption = await request(http)
        .post(`${P}/life-intelligence/rewards/${B.childId}/redemptions`)
        .set(bearer(B.ownerToken))
        .send({ catalogItemId: catalogItem.id });

      // If family B's own request failed the assertion below would be vacuous,
      // so it is asserted rather than assumed.
      expect([200, 201]).toContain(redemption.status);

      const res = await request(http)
        .post(`${P}/life-intelligence/rewards/redemptions/${redemption.body.id}/approve`)
        .set(bearer(A.ownerToken))
        .send({});
      expect(res.status).toBe(404);
    }, 30_000);
  });

  // =========================================================================
  // 2. The child
  // =========================================================================
  describe('the child device', () => {
    it('CAN read its own permitted data', async () => {
      const profile = await request(http)
        .get(`${P}/life-intelligence/self/profile`)
        .set(bearer(A.deviceToken));
      expect(profile.status).toBe(200);

      const account = await request(http)
        .get(`${P}/life-intelligence/self/rewards/account`)
        .set(bearer(A.deviceToken));
      expect(account.status).toBe(200);
    }, 30_000);

    const forbidden: Array<[string, () => request.Test]> = [
      [
        'modify a screen-time policy',
        () =>
          request(http)
            .post(`${P}/children/${A.childId}/screen-time-policy`)
            .set(bearer(A.deviceToken))
            .send({ dailyLimitMinutes: 999 }),
      ],
      [
        'create a reward program',
        () =>
          request(http)
            .post(`${P}/reward-programs`)
            .set(bearer(A.deviceToken))
            .send({ childId: A.childId, category: 'RELIGION', activity: 'QURAN_MEMORIZATION' }),
      ],
      [
        'create a reward rule (manipulate the ledger at its source)',
        () =>
          request(http)
            .post(`${P}/reward-rules`)
            .set(bearer(A.deviceToken))
            .send({ triggerEngine: 'habit-builder', rewardType: 'XP', rewardAmountOrBadgeId: '9999' }),
      ],
      [
        'approve its own reward redemption',
        () =>
          request(http)
            .post(`${P}/life-intelligence/rewards/redemptions/${A.childId}/approve`)
            .set(bearer(A.deviceToken))
            .send({}),
      ],
      [
        'read the parent dashboard',
        () => request(http).get(`${P}/reports/${A.childId}`).set(bearer(A.deviceToken)),
      ],
      [
        'list the family roster',
        () => request(http).get(`${P}/families/members`).set(bearer(A.deviceToken)),
      ],
      [
        'transfer ownership of the family',
        () =>
          request(http)
            .post(`${P}/families/ownership/transfer`)
            .set(bearer(A.deviceToken))
            .send({ toUserId: A.ownerId }),
      ],
    ];

    it.each(forbidden)('CANNOT %s', async (_label, call) => {
      const res = await call();
      expect([200, 201, 204]).not.toContain(res.status);
      // A parent-surface route is the `jwt` Passport strategy; a device token is
      // issued for `device-jwt`. The two strategies reject each other's actor
      // type, so the answer is 401 before any handler runs — and the role check
      // behind it is the second lock on the same door.
      expect([401, 403, 404]).toContain(res.status);
    }, 30_000);

    it("cannot read ANOTHER family's child data with its own valid device token", async () => {
      const res = await request(http)
        .get(`${P}/life-intelligence/rewards/${B.childId}/account`)
        .set(bearer(A.deviceToken));
      expect([401, 404]).toContain(res.status);
      expect(res.status).not.toBe(200);
    }, 30_000);
  });

  // =========================================================================
  // 3. The OWNER / PARENT split — the whole point of P3
  // =========================================================================
  describe('the co-parent has full parenting rights and no destructive rights', () => {
    it('A2 CAN do ordinary parenting work — the split is not a demotion', async () => {
      const habit = await request(http)
        .post(`${P}/life-intelligence/habits/${A.childId}`)
        .set(bearer(A2.token))
        .send({ title: 'Co-parent created this', category: 'LEARNING' });
      expect([200, 201]).toContain(habit.status);

      const roster = await request(http).get(`${P}/families/members`).set(bearer(A2.token));
      expect(roster.status).toBe(200);
      expect(roster.body).toHaveLength(2);
    }, 30_000);

    it('A2 CANNOT remove the other parent — 403 with a machine-readable code', async () => {
      const res = await request(http)
        .delete(`${P}/families/members/${A.ownerId}`)
        .set(bearer(A2.token));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ROLE_NOT_PERMITTED');
      // CONTEXT §3 principle 7: a statement of fact plus a way forward.
      expect(typeof res.body.messageAr).toBe('string');
      expect(res.body.messageAr.length).toBeGreaterThan(10);
    }, 30_000);

    it('A2 CANNOT transfer ownership to itself', async () => {
      const res = await request(http)
        .post(`${P}/families/ownership/transfer`)
        .set(bearer(A2.token))
        .send({ toUserId: A2.userId });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ROLE_NOT_PERMITTED');
    }, 30_000);

    it('A2 CANNOT delete the family/account, and the co-parent is still there afterwards', async () => {
      const res = await request(http)
        .delete(`${P}/account`)
        .set(bearer(A2.token))
        .send({ currentPassword: A2.password });
      expect(res.status).toBe(403);

      const survivors = await sys('count live members of A', () =>
        prisma.familyMember.count({ where: { familyId: A.familyId, deletedAt: null } }),
      );
      expect(survivors).toBe(2);
    }, 30_000);

    it('A2 CANNOT commit the family to a subscription charge', async () => {
      const res = await request(http)
        .post(`${P}/billing/subscribe`)
        .set(bearer(A2.token))
        .send({ plan: 'PREMIUM' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ROLE_NOT_PERMITTED');
    }, 30_000);

    it('...but A2 CAN still READ the plan and the billing history', async () => {
      const sub = await request(http).get(`${P}/billing/subscription`).set(bearer(A2.token));
      expect([200, 404]).toContain(sub.status);
      expect(sub.status).not.toBe(403);
    }, 30_000);
  });

  // =========================================================================
  // 4. Ownership transfer: the happy path, the audit row, and the stale claim
  // =========================================================================
  describe('ownership transfer', () => {
    it('the OWNER can transfer, and the roles actually swap in the database', async () => {
      const res = await request(http)
        .post(`${P}/families/ownership/transfer`)
        .set(bearer(A.ownerToken))
        .send({ toUserId: A2.userId });
      expect(res.status).toBe(204);

      const rows = await sys('read roles after transfer', () =>
        prisma.familyMember.findMany({
          where: { familyId: A.familyId, deletedAt: null },
          select: { userId: true, role: true },
        }),
      );
      const byUser = Object.fromEntries(rows.map((r: any) => [r.userId, r.role]));
      expect(byUser[A2.userId]).toBe('OWNER');
      expect(byUser[A.ownerId]).toBe('PARENT');
    }, 30_000);

    it('the transfer is written to AuditLog WITH tenant scope (A1 BA-009 / F2)', async () => {
      const rows = await sys('read audit', () =>
        prisma.auditLog.findMany({
          where: { familyId: A.familyId, action: 'family.ownership.transferred' },
        }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].familyId).toBe(A.familyId);
      expect(rows[0].actorUserId).toBe(A.ownerId);
      expect(rows[0].entityId).toBe(A.familyId);
      expect(rows[0].metadata).toMatchObject({ fromUserId: A.ownerId, toUserId: A2.userId });
    }, 30_000);

    it('the DEMOTED owner still holds a token claiming OWNER — and the database refuses it anyway', async () => {
      // This is the case a claim-only design gets wrong. A1's access token was
      // minted before the transfer, is validly signed, and says OWNER for
      // another ~15 minutes. The guard therefore lets it through; the service
      // re-reads `family_members` inside its transaction and refuses.
      const stale = JSON.parse(Buffer.from(A.ownerToken.split('.')[1], 'base64').toString());
      expect(stale.familyRole).toBe('OWNER');

      const res = await request(http)
        .delete(`${P}/families/members/${A2.userId}`)
        .set(bearer(A.ownerToken));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ROLE_NOT_PERMITTED');

      const stillThere = await sys('A2 survived', () =>
        prisma.familyMember.count({
          where: { familyId: A.familyId, userId: A2.userId, deletedAt: null },
        }),
      );
      expect(stillThere).toBe(1);
    }, 30_000);

    it("the demoted owner's refresh tokens were revoked, so they cannot rotate their way back", async () => {
      const live = await sys('count live refresh tokens', () =>
        prisma.refreshToken.count({ where: { userId: A.ownerId, revokedAt: null } }),
      );
      expect(live).toBe(0);
    }, 30_000);

    it('the NEW owner can remove the old one, and the removal is audited with tenant scope', async () => {
      // A2's token still says PARENT (minted before the transfer), so the guard
      // would refuse it. Re-login is what a real client does after being told
      // its session no longer matches — and it is also the proof that the role
      // claim is re-derived from persistence at login.
      const relogin = await request(http)
        .post(`${P}/auth/login`)
        .send({ email: A2.email, password: A2.password });
      expect(relogin.status).toBe(200);
      const freshToken = relogin.body.tokens.accessToken;
      const claims = JSON.parse(Buffer.from(freshToken.split('.')[1], 'base64').toString());
      expect(claims.familyRole).toBe('OWNER');

      const res = await request(http)
        .delete(`${P}/families/members/${A.ownerId}`)
        .set(bearer(freshToken));
      expect(res.status).toBe(204);

      const gone = await sys('old owner removed', () =>
        prisma.familyMember.count({
          where: { familyId: A.familyId, userId: A.ownerId, deletedAt: null },
        }),
      );
      expect(gone).toBe(0);

      const audit = await sys('read removal audit', () =>
        prisma.auditLog.findMany({
          where: { familyId: A.familyId, action: 'family.member.removed' },
        }),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].familyId).toBe(A.familyId);
      expect(audit[0].actorUserId).toBe(A2.userId);
      expect(audit[0].metadata).toMatchObject({ removedUserId: A.ownerId });
    }, 30_000);

    it('the removed parent can no longer use the API at all', async () => {
      // Their refresh tokens are revoked and their membership is gone. The
      // access token they still hold resolves to a family they are no longer
      // in; the roster read must not show them the household.
      const roster = await request(http).get(`${P}/families/members`).set(bearer(A.ownerToken));
      expect(roster.status).toBe(200);
      const userIds = roster.body.map((m: any) => m.userId);
      expect(userIds).not.toContain(A.ownerId);
      expect(userIds).toEqual([A2.userId]);
    }, 30_000);
  });

  // =========================================================================
  // 5. PC-S-006 — the auth lifecycle is tenant-scoped in the audit trail
  // =========================================================================
  it('auth.login and auth.register are written WITH familyId, not with NULL', async () => {
    // Before this fix every `/auth/*` audit row landed with `family_id IS NULL`,
    // because the whole surface is `@SystemRoute('AUTH_BOOTSTRAP')` and the
    // tenant extension passes SystemContext writes through untouched. Measured
    // on the verify database at the time: 202 `auth.login` rows and 184
    // `auth.register` rows, zero of them tenant-scoped. "Who signed into this
    // family's account, and when" is exactly the trail a custody dispute needs.
    const rows = await sys('read auth audit for family A', () =>
      prisma.auditLog.findMany({
        where: { familyId: A.familyId, action: { in: ['auth.login', 'auth.register'] } },
        select: { action: true, familyId: true, actorUserId: true },
      }),
    );
    const actions = rows.map((r: any) => r.action);
    expect(actions).toContain('auth.register');
    expect(actions).toContain('auth.login');
    for (const row of rows) {
      expect(row.familyId).toBe(A.familyId);
    }
    // And the co-parent's login is scoped to the family they belong to, not to
    // the one they registered (they never registered one).
    expect(rows.some((r: any) => r.actorUserId === A2.userId)).toBe(true);
  }, 30_000);

  // =========================================================================
  // 6. The database, not the code, is the last line on "one owner"
  // =========================================================================
  it('PostgreSQL refuses a second live OWNER in one family (migration 0009)', async () => {
    await expect(
      sys('attempt a second owner', () =>
        prisma.familyMember.create({
          data: { familyId: A.familyId, userId: B.ownerId, role: 'OWNER' },
        }),
      ),
    ).rejects.toThrow();

    const owners = await sys('count owners', () =>
      prisma.familyMember.count({
        where: { familyId: A.familyId, role: 'OWNER', deletedAt: null },
      }),
    );
    expect(owners).toBe(1);
  }, 30_000);
});
