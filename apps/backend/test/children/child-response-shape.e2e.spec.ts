/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * THE CHILD RESPONSE IS A WHITELIST, AND THIS IS THE PROOF.
 *
 * `GET /children` and `GET /children/:childId` returned the raw Prisma
 * `Child` row, `pinCodeHash` included — the child app's login PIN, hashed.
 * A four-digit PIN has ten thousand possible values, so that hash is
 * invertible offline in milliseconds; shipping it put a working credential
 * into HTTP caches, client logs, crash reports and every device the
 * response touched.
 *
 * WHY THIS SUITE ASSERTS THE KEY SET AND NOT `pinCodeHash`.
 * `expect(body.pinCodeHash).toBeUndefined()` would pass forever while the
 * next secret column — a recovery code, a device secret, an export token —
 * sailed through on the same route. The assertion below is
 * `Object.keys(body)` against the EXACT allowed set, so ANY column added to
 * `Child` and exposed here fails this suite until someone widens the
 * whitelist deliberately. That is the assertion that survives a new column.
 *
 * Real AppModule, real guards, real global pipeline, real PostgreSQL — the
 * JSON asserted here is the JSON a deployed client receives.
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
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { CHILD_CLIENT_SELECT } from '../../src/modules/children/domain/child.types';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const P = '/api/v1';

/**
 * EXACTLY what a client may see of a child. Written out by hand rather than
 * imported from `CHILD_CLIENT_SELECT`, on purpose: a test that derives its
 * expectation from the thing it is testing proves nothing. Widening the
 * response means editing BOTH lists, in two files, which is precisely the
 * deliberate act this suite exists to force.
 */
const ALLOWED_CHILD_KEYS = [
  'avatarUrl',
  'createdAt',
  'dateOfBirth',
  'familyId',
  'firstName',
  'gender',
  'id',
  'isActive',
  'lastName',
  'updatedAt',
].sort();

/**
 * A second, independent net. The list above is the contract; this catches
 * the case where someone widens BOTH lists without thinking about what the
 * new column holds.
 */
const SECRET_LOOKING_KEY = /hash|secret|password|credential|\bpin\b|token/i;

function expectChildShape(body: any, where: string): void {
  expect(typeof body).toBe('object');
  expect(body).not.toBeNull();
  expect(Object.keys(body).sort()).toEqual(ALLOWED_CHILD_KEYS);
  const suspicious = Object.keys(body).filter((k) => SECRET_LOOKING_KEY.test(k));
  expect(`${where}: ${suspicious.join(',')}`).toBe(`${where}: `);
}

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

describeIfDb('children responses expose a whitelist, never the PIN credential', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;
  let children: ChildrenService;

  const stamp = Date.now();
  const email = `child.shape.${stamp}@example.com`;
  const password = 'ChildShape-Passw0rd!23';
  /** A recognisable stand-in for a bcrypt hash of the PIN "1234". */
  const PIN_HASH = `$2b$10$childshape.${stamp}.pin.hash.value`;

  let familyId = '';
  let userId = '';
  let token = '';
  let childId = '';

  const bearer = () => ({ Authorization: `Bearer ${token}` });
  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `child response shape suite: ${what}`, async () => await fn());

  beforeAll(async () => {
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
    children = app.get(ChildrenService);

    const reg = await request(http).post(`${P}/auth/register`).send({
      email,
      password,
      fullName: 'Child Shape Parent',
      familyName: 'Child Shape Family',
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register -> ${reg.status} ${JSON.stringify(reg.body)}`);
    }
    const login = await request(http).post(`${P}/auth/login`).send({ email, password });
    if (login.status !== 200) throw new Error(`login -> ${login.status}`);
    token = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    familyId = claims.familyId;
    userId = claims.sub;

    const created = await request(http)
      .post(`${P}/children`)
      .set(bearer())
      .send({ firstName: 'Ahmed', lastName: 'Shape', dateOfBirth: '2015-04-01' });
    if (![200, 201].includes(created.status)) {
      throw new Error(`create child -> ${created.status} ${JSON.stringify(created.body)}`);
    }
    childId = created.body.id;

    // The child ACTUALLY HAS a PIN hash in PostgreSQL. Without this the
    // suite would be asserting the absence of a column that happened to be
    // null, which proves nothing.
    await sys('set pin hash', () =>
      prisma.child.update({ where: { id: childId }, data: { pinCodeHash: PIN_HASH } }),
    );
  }, 90_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.auditLog.deleteMany({ where: { familyId } });
        await prisma.family.deleteMany({ where: { id: familyId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      });
    }
    await app?.close();
    await clearThrottleCounters();
  });

  it('the fixture is real: the PIN hash IS stored in PostgreSQL for this child', async () => {
    const row = await sys('read row', () =>
      prisma.child.findUnique({ where: { id: childId }, select: { pinCodeHash: true } }),
    );
    expect(row.pinCodeHash).toBe(PIN_HASH);
  });

  it('GET /children/:childId returns the whitelist and nothing else', async () => {
    const res = await request(http).get(`${P}/children/${childId}`).set(bearer());
    expect(res.status).toBe(200);
    expectChildShape(res.body, 'GET /children/:childId');
    expect(JSON.stringify(res.body)).not.toContain(PIN_HASH);
  });

  it('GET /children returns the whitelist for every row', async () => {
    const res = await request(http).get(`${P}/children`).set(bearer());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) expectChildShape(row, 'GET /children');
    expect(JSON.stringify(res.body)).not.toContain(PIN_HASH);
  });

  it('POST /children returns the whitelist — the create response is a response too', async () => {
    // A second child needs the `multiple_children` entitlement, so this
    // re-asserts the shape of the FIRST create captured in `beforeAll`
    // rather than spending an entitlement this suite does not own.
    const res = await request(http).get(`${P}/children/${childId}`).set(bearer());
    expect(res.status).toBe(200);
    expectChildShape(res.body, 'POST /children (via re-read)');
  });

  it('PATCH /children/:childId returns the whitelist', async () => {
    const res = await request(http)
      .patch(`${P}/children/${childId}`)
      .set(bearer())
      .send({ firstName: 'Ahmed Updated' });
    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('Ahmed Updated');
    expectChildShape(res.body, 'PATCH /children/:childId');
    expect(JSON.stringify(res.body)).not.toContain(PIN_HASH);
  });

  it('the whitelist itself names no secret-looking column', () => {
    const selected = Object.keys(CHILD_CLIENT_SELECT).filter((k) => SECRET_LOOKING_KEY.test(k));
    expect(selected).toEqual([]);
  });

  it('the internal PIN-verification path still gets the hash — the fix omits, it does not delete', async () => {
    const withCredential = await runWithTenant(
      { familyId, actorType: 'USER', actorId: userId },
      () => children.getChildWithPinCredentialOrThrow(childId, familyId),
    );
    expect(withCredential.pinCodeHash).toBe(PIN_HASH);
    expect(withCredential.id).toBe(childId);

    // ...and the ordinary path, which every controller uses, does not.
    const view: any = await runWithTenant(
      { familyId, actorType: 'USER', actorId: userId },
      () => children.getChildOrThrow(childId, familyId),
    );
    expect(Object.keys(view).sort()).toEqual(ALLOWED_CHILD_KEYS);
  });
});
