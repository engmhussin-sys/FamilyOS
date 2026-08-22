/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The generated cross-tenant probe suite (F2 task 5b), generalising A4's
 * `idor-sweep`.
 *
 * What it does, in order:
 *   1. Boots the REAL application (the whole AppModule, real guards, real
 *      Passport strategies, real global TenantContextInterceptor, real
 *      PrismaService with the tenant extension) against a REAL PostgreSQL.
 *   2. Registers two families over HTTP — `POST /auth/register` — so the tokens
 *      are genuine, signed, and carry genuine `familyId` claims.
 *   3. Seeds a REAL ROW OF EVERY RESOURCE TYPE THIS API ADDRESSES BY ID inside
 *      family B — the victim — plus a disposable family C to aim writes at.
 *   4. Enumerates the application's own route table from Nest's metadata and
 *      replays EVERY route against family B, from outside family B.
 *   5. Asserts the answer discloses nothing of family B — by STATUS where the
 *      route takes an id, and by scanning the response body for family B's
 *      identifiers everywhere else.
 *
 * The route list is derived, not hand-written, so a route added tomorrow is
 * probed tomorrow without anyone updating this file.
 *
 * ===========================================================================
 * WHY THIS FILE WAS REWRITTEN: IT WAS GREEN FOR THE WRONG REASON.
 * ===========================================================================
 *
 * The previous version filtered the generated route table down to routes where
 * EVERY path param was one of six names — `childId, habitId, ruleId, goalId,
 * practiceId, familyId` — and then asserted `fillable.length >= 20`. Two holes
 * followed, and both were load-bearing:
 *
 *   1. Routes keyed by `achievementId`, `evidenceId`, `deviceId`, `messageId`,
 *      `redemptionId`, `grantId`, `fulfilmentId`, `taskId`, `catalogItemId`,
 *      `invitationId`, `organizationId`, `programId`, `id` and `userId` were
 *      never probed at all.
 *   2. COLLECTION ROUTES — the ones that take no id — were excluded by
 *      construction, and a collection route is precisely where a cross-tenant
 *      leak hides: it has no id to get wrong, so it either scopes the query or
 *      it returns the whole table.
 *
 * That second hole is not hypothetical. `GET /feature-flags` returned
 * `featureFlag.findMany()` verbatim, `enabled_family_ids` included — a
 * `String[] @db.Uuid` of OTHER FAMILIES' tenant keys — to any authenticated
 * parent, and this suite reported itself exhaustive throughout. The fixture
 * below now seeds a feature flag rolled out to family B, so that exact leak is
 * a red test rather than a paragraph.
 *
 * And `>= 20` was the assertion that let it hide: a floor on a count can only
 * ever say "at least this much was probed", never "nothing was skipped". It is
 * replaced by an EXACT PARTITION of the route table — every route is probed by
 * one of the four sweeps below, or is CLASSIFIED HERE WITH A PER-ENTRY REASON.
 * A route that is neither lands in neither set and fails RULE X1 BY NAME. (The
 * same shape as `test/architecture/notification-producer-chain.guard.spec.ts`.)
 *
 * ===========================================================================
 * THE FOUR SWEEPS.
 * ===========================================================================
 *
 *   TARGETED     a route that takes at least one id this fixture can point at
 *                a real family-B row. Called from family A. Must not be 2xx,
 *                must be 404 rather than 403 (a 403 confirms the resource
 *                exists in another family, which is disclosure in itself), and
 *                must not echo any family-B identifier.
 *   COLLECTION   a GET that takes no id. Called from family A. A 200 is
 *                CORRECT here — it is family A's own list — so the assertion is
 *                on the CONTENT: no identifier belonging to family B may appear
 *                anywhere in the body.
 *   WRITE        a write that takes no id. Called from DISPOSABLE FAMILY C,
 *                never from A or B, so that any write which does go through
 *                lands in a family this suite deletes. Same content assertion.
 *   PLATFORM     a route behind `InternalAdminGuard`. A family token carries no
 *                operator key, so the requirement is that it is refused
 *                outright — the tenant surface and the platform surface do not
 *                meet.
 *
 * Device-surface routes are swept with family A's own genuine DEVICE token
 * rather than a parent token, because "a parent token is the wrong ACTOR TYPE"
 * is a Passport answer, not an isolation answer. A child's device in family A
 * pointed at family B's rows is the isolation question.
 *
 * ===========================================================================
 * THE VALIDATION PIPE IS INSTALLED, AND THAT IS DELIBERATE.
 * ===========================================================================
 *
 * This suite used to boot the app with NO global `ValidationPipe`, so an empty
 * probe body reached the handler. That made a write sweep unsafe (a bodyless
 * write would really execute) and it meant the probe was exercising a looser
 * application than the one `main.ts` deploys. `buildValidationPipe()` — the
 * same factory `global-pipeline.ts` gives production — is installed below. The
 * global exception FILTER and the `api/v1` prefix are deliberately NOT: every
 * assertion here is about an HTTP status and Nest's own exception body, which
 * the filter reshapes, and the prefix would change nothing about isolation.
 * `test/common/error-contract.e2e.spec.ts` owns the response-shape question.
 */
import { INestApplication } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { buildValidationPipe } from '../../src/common/http/global-pipeline';
import { Role } from '../../src/common/authz/principal-role';
import { ROLES_METADATA } from '../../src/common/authz/roles.decorator';
import { PasswordService } from '../../src/modules/auth/application/services/password.service';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { integrationDatabaseUrl } from './prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/**
 * PHASE C. The `/auth/register` throttle counter lives in the REAL Redis and is
 * IP-keyed, so every e2e suite in one `--runInBand` run draws on ONE budget from
 * 127.0.0.1. A suite that consumes without returning makes whichever suite runs
 * after it fail with a 429 that has nothing to do with what it asserts — and
 * this file registers two families AND sweeps `POST /auth/*` in the write
 * sweep. Cleared on the way in and on the way out.
 */
async function clearThrottleCounters(): Promise<void> {
  const Redis = require('ioredis');
  const client = new Redis(process.env.REDIS_URL as string);
  const keys = await client.keys('throttle:*');
  if (keys.length > 0) await client.del(...keys);
  await client.quit();
}

interface Route {
  method: string;
  path: string;
  params: string[];
  /** PHASE C: the roles the route declares, and the guards it carries. */
  roles: string[] | undefined;
  guardNames: string[];
}

function findControllerFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findControllerFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.controller.ts')) acc.push(full);
  }
  return acc;
}

function enumerateRoutes(): Route[] {
  const out: Route[] = [];
  for (const file of findControllerFiles(path.resolve(__dirname, '../../src'))) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(file);
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const base = Reflect.getMetadata(PATH_METADATA, exported);
      if (base === undefined) continue;
      const proto = (exported as any).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        if (sub === undefined) continue;
        const verb = HTTP_METHODS[Reflect.getMetadata(METHOD_METADATA, handler)];
        const full = `/${base}/${sub}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        const classGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, exported) ?? [];
        const methodGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        out.push({
          method: verb,
          path: full,
          params: [...full.matchAll(/:(\w+)/g)].map((m) => m[1]),
          roles:
            (Reflect.getMetadata(ROLES_METADATA, handler) as string[] | undefined) ??
            (Reflect.getMetadata(ROLES_METADATA, exported) as string[] | undefined),
          guardNames: [...classGuards, ...methodGuards].map((g) => g?.name ?? String(g)),
        });
      }
    }
  }
  return out;
}

/** Builds a PrismaService substitute that works in this environment. */
function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require('@prisma/client');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaPg } = require('@prisma/adapter-pg');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client');
  const base = new PrismaClient({
    // PRISMA 7: `datasources` was removed from the constructor — driver
    // adapters are the only mode, so the adapter IS the connection. This
    // branch used to exist to AVOID the adapter; it now builds the same
    // client the branch above does, which is the honest end state: a test
    // must not reach the database through a different engine than
    // production does.
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(
      new (require('pg').Pool)({ connectionString: url }),
    ),
  });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

// ===========================================================================
// THE CLASSIFICATIONS — THE AUDIT TRAIL, NOT A MUTE BUTTON
// ===========================================================================

/**
 * `GLOBAL_CATALOGUE`  the path param names a row in platform configuration — a
 *                     flag key, a market code, a notification-policy key — and
 *                     not a family-owned resource. There is no other family's
 *                     row for the probe to aim at, so a targeted probe would
 *                     assert nothing about isolation.
 * `UNAUTHENTICATED`   the route carries no auth guard at all by design (a
 *                     provider webhook, verified by signature). It has no
 *                     caller identity, therefore no tenant to cross.
 *
 * WHAT IS NOT AN ACCEPTABLE REASON, written down so it cannot be added quietly:
 * "hard to seed", "no fixture yet", "probably covered elsewhere". Every one of
 * those is a route nobody probes, which is how `GET /feature-flags` shipped a
 * table of tenant keys past a suite that called itself generated and complete.
 */
type ProbeClassification = 'GLOBAL_CATALOGUE' | 'UNAUTHENTICATED';

interface ClassifiedRoute {
  /** `METHOD /path`, exactly as the generated table names it. */
  readonly what: string;
  readonly classification: ProbeClassification;
  /** ONE LINE, and it must say something. A reason too short to be a sentence
   * is the same as no reason, and RULE X2 fails it. */
  readonly reason: string;
}

const CLASSIFIED_ROUTES: readonly ClassifiedRoute[] = Object.freeze([
  {
    what: 'GET /feature-flags/:key',
    classification: 'GLOBAL_CATALOGUE',
    reason:
      'A flag key is platform configuration shared by the whole deployment, not a family-owned row, so there is no family-B key to aim at; the route answers one boolean about the CALLER’s own family and its response shape is pinned by test/tenancy/feature-flag-exposure.e2e.spec.ts.',
  },
  {
    what: 'PUT /notifications/policy/:key',
    classification: 'GLOBAL_CATALOGUE',
    reason:
      'The key names a notification TYPE from the engine’s fixed vocabulary, identical in every family; the row it writes is keyed by the caller’s own familyId taken from the token, so no family-B value can be placed in this path at all.',
  },
  {
    what: 'GET /billing/catalogue/:countryCode',
    classification: 'GLOBAL_CATALOGUE',
    reason:
      'An ISO-3166 market code addressing the launch-market price catalogue in the `countries` table — deployment-wide reference data with no family_id column, so there is no family-B row here for the route to disclose.',
  },
  {
    what: 'GET /self/coach/answer/:topicCode',
    classification: 'GLOBAL_CATALOGUE',
    reason:
      'A topic code addressing the coaching CONTENT catalogue that ships with the build; the answer is the same for every child in every family, so pointing it at family B is not a question this route is able to answer differently.',
  },
  {
    what: 'POST /webhooks/payments/:provider',
    classification: 'UNAUTHENTICATED',
    reason:
      'A payment-provider webhook with no auth guard by design: the provider name selects a signature verifier, the caller holds no token and therefore no tenant, and the pipeline that resolves a family from a verified payload is covered by test/billing/payment-webhook.pipeline.spec.ts.',
  },
]);

describeIfDb('R8 — generated cross-tenant probe suite against the real application', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;

  const stamp = Date.now();
  const tokens: Record<'A' | 'B', string> = { A: '', B: '' };
  const familyIds: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
  const userIds: Record<'A' | 'B', string> = { A: '', B: '' };
  /** Resource ids OWNED BY FAMILY B, keyed by the route param name they fill. */
  const bResources: Record<string, string> = {};
  const createdUserIds: string[] = [];
  const createdOrganizationIds: string[] = [];
  const createdFeatureFlagKeys: string[] = [];
  /**
   * PHASE C. Two more principals INSIDE family B, so the same generated route
   * table can be replayed across ROLES and not only across TENANTS:
   *   - `bChildToken`: a genuine paired-device (CHILD) access token;
   *   - `bCoParentToken`: a genuine co-parent (PARENT) access token.
   * Both are minted by the application's own TokenService — the same call the
   * pairing and login paths make — rather than obtained over HTTP, because the
   * `/auth/*` throttle budget is shared across every e2e suite in one run and
   * this suite must not spend more of it than the isolation probe needs.
   */
  let bChildToken = '';
  let bCoParentToken = '';
  let bCoParentUserId = '';
  /** Family A's OWN child and its device — the principal the child surface is
   * swept with, and family A's row for the "can a co-parent in B see it?" test. */
  let aChildToken = '';
  let aChildId = '';
  /** Disposable family C: the only principal this suite aims writes at. */
  let cParentToken = '';
  let cChildToken = '';

  async function register(labelName: 'A' | 'B') {
    const res = await request(http)
      .post('/auth/register')
      .send({
        email: `probe.${labelName.toLowerCase()}.${stamp}@example.com`,
        password: 'Probe-Passw0rd!23',
        fullName: `Probe Parent ${labelName}`,
        familyName: `Probe Family ${labelName}`,
        acceptedTerms: true,
      });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`register(${labelName}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    // `POST /auth/register` returns the profile, not a session — so the token
    // comes from the real login flow, exactly as a client would obtain it.
    const login = await request(http)
      .post('/auth/login')
      .send({
        email: `probe.${labelName.toLowerCase()}.${stamp}@example.com`,
        password: 'Probe-Passw0rd!23',
      });
    if (login.status !== 200) {
      throw new Error(`login(${labelName}) failed: ${login.status} ${JSON.stringify(login.body)}`);
    }
    tokens[labelName] = login.body.tokens?.accessToken ?? login.body.accessToken;
    if (!tokens[labelName]) {
      throw new Error(`login(${labelName}) returned no access token: ${JSON.stringify(login.body)}`);
    }
    const payload = JSON.parse(Buffer.from(tokens[labelName].split('.')[1], 'base64').toString());
    familyIds[labelName] = payload.familyId;
    userIds[labelName] = payload.sub;
    createdUserIds.push(payload.sub);
  }

  const auth = (labelName: 'A' | 'B') => ({ Authorization: `Bearer ${tokens[labelName]}` });

  /**
   * `await fn()` and not `fn`: a PrismaPromise is lazy, so the query only starts
   * when it is awaited — awaiting it OUTSIDE this callback would run it outside
   * the SystemContext and the tenant extension would deny it.
   */
  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `cross-tenant probe fixture: ${what}`, async () => await fn());

  /** A genuine paired CHILD device inside `familyId`, and its access token. */
  async function seedChildDevice(
    what: string,
    familyId: string,
    childId: string,
    tokenService: TokenService,
  ): Promise<{ deviceId: string; token: string }> {
    const device = await sys(what, () =>
      prisma.device.create({
        data: {
          familyId,
          ownerType: 'CHILD',
          childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    const token = (
      await runWithTenant({ familyId, actorType: 'DEVICE', actorId: device.id }, () =>
        tokenService.issueTokenPair({ subjectId: device.id, actorType: 'DEVICE', familyId }),
      )
    ).accessToken;
    return { deviceId: device.id, token };
  }

  beforeAll(async () => {
    await clearThrottleCounters();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    // The SAME ValidationPipe production deploys — see the file docstring.
    app.useGlobalPipes(buildValidationPipe());
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);

    const tokenService = app.get(TokenService);
    const passwordService = app.get(PasswordService);

    await register('A');
    await register('B');

    // --- real resources, created by family B through the real API ---
    const child = await request(http)
      .post('/children')
      .set(auth('B'))
      .send({ firstName: 'Probe Kid B', dateOfBirth: '2015-04-01' });
    expect([200, 201]).toContain(child.status);
    bResources.childId = child.body.id;

    const habit = await request(http)
      .post(`/life-intelligence/habits/${bResources.childId}`)
      .set(auth('B'))
      .send({ title: 'Probe Habit B', category: 'LEARNING' });
    if ([200, 201].includes(habit.status)) bResources.habitId = habit.body.id;

    const rule = await request(http)
      .post(`/children/${bResources.childId}/app-block-rules`)
      .set(auth('B'))
      .send({ packageName: 'com.probe.b', ruleType: 'BLOCK' });
    if ([200, 201].includes(rule.status)) bResources.ruleId = rule.body.id;

    const goal = await request(http)
      .post(`/life-intelligence/learning/${bResources.childId}/goals`)
      .set(auth('B'))
      .send({ subject: 'MATH', title: 'Probe Goal B' });
    if ([200, 201].includes(goal.status)) bResources.goalId = goal.body.id;

    const practice = await request(http)
      .post(`/life-intelligence/faith/${bResources.childId}/practices`)
      .set(auth('B'))
      .send({ type: 'AZKAR', title: 'Probe Practice B' });
    if ([200, 201].includes(practice.status)) bResources.practiceId = practice.body.id;

    // familyId appears as a path param on one route (rewards store).
    bResources.familyId = familyIds.B;

    // --- PHASE C: a CHILD device and a co-parent PARENT, both in family B ---
    const bDevice = await seedChildDevice('device for B', familyIds.B, bResources.childId, tokenService);
    bResources.deviceId = bDevice.deviceId;
    bChildToken = bDevice.token;

    const coParent = await sys('seed co-parent for B', async () =>
      prisma.user.create({
        data: {
          email: `probe.coparent.${stamp}@example.com`,
          passwordHash: await passwordService.hash('Probe-CoParent-Passw0rd!23'),
          fullName: 'Probe Co-Parent B',
          termsAcceptedAt: new Date(),
          termsVersion: 'v1-placeholder',
        },
        select: { id: true },
      }),
    );
    bCoParentUserId = coParent.id;
    createdUserIds.push(coParent.id);
    await sys('seed co-parent membership', () =>
      prisma.familyMember.create({
        data: { familyId: familyIds.B, userId: coParent.id, role: 'PARENT' },
      }),
    );
    bCoParentToken = (
      await runWithTenant(
        { familyId: familyIds.B, actorType: 'USER', actorId: coParent.id },
        () =>
          tokenService.issueTokenPair({
            subjectId: coParent.id,
            actorType: 'USER',
            familyId: familyIds.B,
            familyRole: 'PARENT',
          }),
      )
    ).accessToken;
    // The co-parent is the family-B principal `DELETE /families/members/:userId`
    // addresses — a real row of the `userId` type inside the victim family.
    bResources.userId = bCoParentUserId;

    // =====================================================================
    // ONE REAL ROW OF EVERY REMAINING ID TYPE THIS API ADDRESSES, IN FAMILY B.
    //
    // Seeded through Prisma under a SystemContext rather than driven through
    // multi-step product flows (start an achievement, submit evidence, have a
    // parent approve it, …): the probe's subject is the ROUTE TABLE, and a
    // fixture that depends on six business flows staying green is a fixture
    // that stops seeding the day one of them changes — which is how the
    // uncovered two thirds got uncovered in the first place.
    // =====================================================================
    await sys('family-B rows for every id-taking route', async () => {
      const task = await prisma.smartTask.create({
        data: {
          familyId: familyIds.B,
          childId: bResources.childId,
          title: 'Probe Smart Task B',
          category: 'LEARNING',
          generatedReason: 'probe fixture',
          sourceSignals: {},
          suggestedDate: new Date(),
        },
        select: { id: true },
      });
      bResources.taskId = task.id;

      const message = await prisma.childMessage.create({
        data: {
          familyId: familyIds.B,
          childId: bResources.childId,
          authorType: 'PARENT',
          approvalStatus: 'PENDING',
          category: 'GENERAL',
          title: 'Probe Message B',
          body: 'Probe message body for family B.',
          sourceEventId: `probe-message-${stamp}`,
        },
        select: { id: true },
      });
      bResources.messageId = message.id;

      const catalogItem = await prisma.rewardCatalogItem.create({
        data: {
          familyId: familyIds.B,
          title: 'Probe Reward B',
          costCoins: 10,
          createdByUserId: userIds.B,
        },
        select: { id: true },
      });
      bResources.catalogItemId = catalogItem.id;

      const redemption = await prisma.rewardRedemption.create({
        data: {
          familyId: familyIds.B,
          childId: bResources.childId,
          rewardCatalogItemId: catalogItem.id,
          status: 'REQUESTED',
        },
        select: { id: true },
      });
      bResources.redemptionId = redemption.id;

      const program = await prisma.rewardProgram.create({
        data: {
          familyId: familyIds.B,
          childId: bResources.childId,
          category: 'STUDY',
          activity: 'READING',
          targetSpec: { minutes: 20 },
          targetSummaryAr: 'قراءة عشرين دقيقة',
          durationMinutes: 20,
          verificationLevel: 'PARENT_APPROVAL',
          rewardSpec: { type: 'COINS', amount: 5 },
          createdByUserId: userIds.B,
        },
        select: { id: true },
      });
      bResources.programId = program.id;

      const achievement = await prisma.achievementRequest.create({
        data: {
          familyId: familyIds.B,
          programId: program.id,
          childId: bResources.childId,
          status: 'SUBMITTED',
          localDate: new Date(),
          submittedAt: new Date(),
        },
        select: { id: true },
      });
      bResources.achievementId = achievement.id;

      const evidence = await prisma.achievementEvidence.create({
        data: {
          familyId: familyIds.B,
          achievementId: achievement.id,
          childId: bResources.childId,
          kind: 'PHOTO',
          storageKey: `probe/evidence/${stamp}.jpg`,
          mimeType: 'image/jpeg',
          byteSize: 1024,
          sha256: 'b'.repeat(64),
          retainUntil: new Date(Date.now() + 86_400_000),
        },
        select: { id: true },
      });
      bResources.evidenceId = evidence.id;

      const grant = await prisma.screenTimeRewardGrant.create({
        data: {
          familyId: familyIds.B,
          childId: bResources.childId,
          achievementId: achievement.id,
          ledgerEntryId: randomUUID(),
          minutes: 15,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        select: { id: true },
      });
      bResources.grantId = grant.id;

      const fulfilment = await prisma.rewardFulfilment.create({
        data: {
          familyId: familyIds.B,
          childId: bResources.childId,
          achievementId: achievement.id,
          ledgerEntryId: randomUUID(),
          rewardType: 'PHYSICAL',
          description: 'Probe fulfilment for family B',
        },
        select: { id: true },
      });
      bResources.fulfilmentId = fulfilment.id;

      const notification = await prisma.notification.create({
        data: {
          familyId: familyIds.B,
          userId: userIds.B,
          type: 'PROBE_FIXTURE',
          title: 'Probe Notification B',
          body: 'Probe notification body for family B.',
          sourceEventId: `probe-notification-${stamp}`,
        },
        select: { id: true },
      });
      // The only PARENT-surface route taking a bare `:id` is
      // `PATCH /notifications/:id/read`.
      bResources.id = notification.id;

      // Organizations are a SECOND tenancy axis: they carry no family_id and
      // are joined by membership, so family B's organization is one family A
      // must not be able to read either.
      const organization = await prisma.organization.create({
        data: { type: 'SCHOOL', name: `Probe Org B ${stamp}` },
        select: { id: true },
      });
      createdOrganizationIds.push(organization.id);
      bResources.organizationId = organization.id;
      await prisma.organizationMember.create({
        data: { organizationId: organization.id, userId: userIds.B, role: 'OWNER' },
      });
      const invitation = await prisma.organizationInvitation.create({
        data: {
          organizationId: organization.id,
          email: `probe.invitee.${stamp}@example.com`,
          invitedByUserId: userIds.B,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        select: { id: true },
      });
      bResources.invitationId = invitation.id;

      // THE ROLLOUT ROW THAT NAMES FAMILY B. `GET /feature-flags` returned
      // `enabled_family_ids` verbatim to every parent; without a flag that
      // actually targets the victim, the collection sweep would have had
      // nothing to find.
      const flagKey = `probe_rollout_${stamp}`;
      createdFeatureFlagKeys.push(flagKey);
      await prisma.featureFlag.create({
        data: {
          key: flagKey,
          description: 'Probe rollout flag targeting family B.',
          isEnabledGlobally: false,
          enabledFamilyIds: [familyIds.B],
        },
      });
    });

    // --- family A's own child + device: the principal the child surface is
    //     swept with, so "wrong actor type" cannot stand in for "wrong tenant".
    const aChild = await request(http)
      .post('/children')
      .set(auth('A'))
      .send({ firstName: 'Probe Kid A', dateOfBirth: '2016-02-02' });
    expect([200, 201]).toContain(aChild.status);
    aChildId = aChild.body.id;
    aChildToken = (await seedChildDevice('device for A', familyIds.A, aChildId, tokenService)).token;

    // --- disposable family C: the ONLY principal writes are aimed at ---
    const cFamily = await sys('family C', () =>
      prisma.family.create({ data: { name: `Probe Family C ${stamp}` }, select: { id: true } }),
    );
    familyIds.C = cFamily.id;
    const cUser = await sys('parent C', async () =>
      prisma.user.create({
        data: {
          email: `probe.c.${stamp}@example.com`,
          passwordHash: await passwordService.hash('Probe-C-Passw0rd!23'),
          fullName: 'Probe Parent C',
          termsAcceptedAt: new Date(),
          termsVersion: 'v1-placeholder',
        },
        select: { id: true },
      }),
    );
    createdUserIds.push(cUser.id);
    await sys('membership C', () =>
      prisma.familyMember.create({
        data: { familyId: familyIds.C, userId: cUser.id, role: 'OWNER' },
      }),
    );
    cParentToken = (
      await runWithTenant({ familyId: familyIds.C, actorType: 'USER', actorId: cUser.id }, () =>
        tokenService.issueTokenPair({
          subjectId: cUser.id,
          actorType: 'USER',
          familyId: familyIds.C,
          familyRole: 'OWNER',
        }),
      )
    ).accessToken;
    const cChild = await sys('child C', () =>
      prisma.child.create({
        data: {
          familyId: familyIds.C,
          firstName: 'Probe Kid C',
          dateOfBirth: new Date('2017-03-03'),
        },
        select: { id: true },
      }),
    );
    cChildToken = (await seedChildDevice('device for C', familyIds.C, cChild.id, tokenService)).token;
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      const { runAsSystem } = require('../../src/common/tenancy/system-context');
      await runAsSystem('TEST_FIXTURE', 'Probe-suite teardown removes only the fixtures it created.', async () => {
        await prisma.featureFlag.deleteMany({ where: { key: { in: createdFeatureFlagKeys } } });
        await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
        await prisma.family.deleteMany({
          where: { id: { in: [familyIds.A, familyIds.B, familyIds.C] } },
        });
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      });
    }
    await app?.close();
    await clearThrottleCounters();
  });

  // =========================================================================
  // THE PARTITION — every route is probed, or classified with a reason
  // =========================================================================

  const routes = enumerateRoutes();
  const nameOf = (r: Route): string => `${r.method} ${r.path}`;

  /**
   * The param names this fixture can point at a REAL family-B row. Every entry
   * is seeded in `beforeAll`, and RULE X3 fails if any one of them is not — so
   * a fixture that silently stopped seeding cannot quietly shrink the sweep.
   */
  const VICTIM_PARAMS = [
    'childId',
    'habitId',
    'ruleId',
    'goalId',
    'practiceId',
    'familyId',
    'deviceId',
    'taskId',
    'messageId',
    'catalogItemId',
    'redemptionId',
    'programId',
    'achievementId',
    'evidenceId',
    'grantId',
    'fulfilmentId',
    'organizationId',
    'invitationId',
    'userId',
    'id',
  ] as const;

  const classifiedNames = new Set(CLASSIFIED_ROUTES.map((e) => e.what));
  const isPlatform = (r: Route): boolean => r.guardNames.includes('InternalAdminGuard');
  const isDeviceSurface = (r: Route): boolean => r.guardNames.includes('DeviceJwtAuthGuard');
  /** A route is TARGETABLE when at least one of its params names a family-B row. */
  const isTargetable = (r: Route): boolean =>
    r.params.some((p) => (VICTIM_PARAMS as readonly string[]).includes(p));

  const platform = routes.filter((r) => !classifiedNames.has(nameOf(r)) && isPlatform(r));
  const rest = routes.filter((r) => !classifiedNames.has(nameOf(r)) && !isPlatform(r));
  const targetedAll = rest.filter((r) => r.params.length > 0 && isTargetable(r));
  const collection = rest.filter((r) => r.params.length === 0 && r.method === 'GET');
  const writes = rest.filter((r) => r.params.length === 0 && r.method !== 'GET');
  /** Anything the four sweeps and the classification list both miss. */
  const uncovered = rest.filter(
    (r) => !targetedAll.includes(r) && !collection.includes(r) && !writes.includes(r),
  );

  const FILLER_UUID = '00000000-0000-4000-8000-000000000000';
  const fillParams = (route: Route): string => {
    let url = route.path;
    for (const p of route.params) url = url.replace(`:${p}`, bResources[p] ?? FILLER_UUID);
    return url;
  };
  const send = (route: Route, url: string, token: string) => {
    const verb = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
    return (request(http) as any)[verb](url).set({ Authorization: `Bearer ${token}` }).send({});
  };

  /**
   * Every string that identifies family B. A response containing one of these,
   * to a caller outside family B, has disclosed family B — whatever its status
   * code and whatever field it arrived in. This is the assertion that catches a
   * collection route returning the whole table, which is the class of defect
   * the old shape of this suite could not see.
   */
  const victimNeedles = (): { needle: string; what: string }[] => [
    { needle: familyIds.B, what: 'family B’s tenant id' },
    ...Object.entries(bResources)
      .filter(([, v]) => Boolean(v) && v !== familyIds.B)
      .map(([param, v]) => ({ needle: v, what: `family B’s ${param}` })),
    { needle: `probe.b.${stamp}@example.com`, what: 'family B’s owner email' },
    { needle: `probe.coparent.${stamp}@example.com`, what: 'family B’s co-parent email' },
    { needle: 'Probe Kid B', what: 'family B’s child name' },
    { needle: 'Probe Family B', what: 'family B’s name' },
  ];

  /**
   * `requestUrl` is subtracted from the search on purpose. A 404 body that says
   * «Child <uuid> not found» is echoing the id THE CALLER JUST SENT; treating
   * that as a disclosure would flag every correct refusal in the targeted sweep
   * and drown the real findings. What is still caught is any family-B value the
   * caller did NOT supply — which is the whole of the collection sweep, and on
   * a targeted route is every field of the row itself.
   */
  const disclosuresIn = (res: any, requestUrl = ''): string[] => {
    const text = JSON.stringify(res.body ?? '') + String(res.text ?? '');
    return victimNeedles()
      .filter(({ needle }) => needle && text.includes(needle) && !requestUrl.includes(needle))
      .map(({ needle, what }) => `${what} (${needle})`);
  };

  // =========================================================================
  // THE CROSS-TENANT DEFECT LEDGER — REAL GAPS THE WIDENED SWEEP FOUND
  // =========================================================================

  /**
   * EVERY ENTRY HERE IS A DEFECT, NOT AN EXEMPTION.
   *
   * Each one is a route the widened sweep reached and the narrow one could not,
   * where the answer to an OUTSIDER differs from the answer to the SAME request
   * against an id that does not exist — which is an existence oracle for
   * another tenant's rows. Each is paired with an `it.failing` below, so the
   * day it is fixed this suite goes RED and the entry must be deleted: a ledger
   * that can be satisfied by ignoring it is a scoreboard.
   *
   * They are LEFT UNFIXED here on purpose. The modules they live in are being
   * edited by another work stream this round; a fix landing from two directions
   * at once is a merge conflict in security code, which is worse than a defect
   * that is written down, reproduced by a test, and owned.
   */
  interface LedgerEntry {
    readonly what: string;
    /** Where the evidence is. `file:line`, so a reader can check the claim. */
    readonly evidence: string;
    readonly detail: string;
  }

  const CROSS_TENANT_DEFECT_LEDGER: readonly LedgerEntry[] = Object.freeze([
    // EMPTY, AND THAT IS THE POINT OF THE RATCHET.
    //
    // This ledger held one entry: `POST /organizations/invitations/:invitationId
    // /accept` answered 404 for an unknown id but 403/400 for a real one, so any
    // authenticated parent could enumerate invitation ids platform-wide and read
    // back their status — an existence oracle sitting in front of the email check
    // that was supposed to be the whole control.
    //
    // It was found by WIDENING this suite, not by reading the module: the probe
    // used to filter to routes whose every param was in a six-name whitelist and
    // then assert only `fillable.length >= 20`, which excluded collection routes
    // entirely and covered roughly a third of the id surface. The route is now
    // fixed (`organization.service.ts` checks the recipient FIRST and answers one
    // constant refusal for "unknown" and "not yours" alike, issuing both lookups
    // unconditionally so the two are one timing class), and the entry is deleted
    // in the same breath — because an `it.failing` that is left behind after its
    // defect is closed turns a ratchet back into a scoreboard.
  ]);

  const ledgerNames = new Set(CROSS_TENANT_DEFECT_LEDGER.map((e) => e.what));

  /**
   * The targeted sweep, minus the routes on the ledger. They are not skipped —
   * they are probed by the `it.failing` block at the end of this file, which
   * asserts the CORRECT behaviour and therefore turns red the day the defect is
   * fixed and the entry is not deleted.
   */
  const targeted = targetedAll.filter((r) => !ledgerNames.has(nameOf(r)));

  /** The same route with every id replaced by one that exists nowhere. */
  const nonexistentUrl = (route: Route): string => route.path.replace(/:\w+/g, FILLER_UUID);

  /**
   * THE INDISTINGUISHABILITY RULE.
   *
   * The narrow probe demanded a flat 404 and banned 403 outright, and the
   * reason it gave was right: «a 403 confirms the resource exists in another
   * family». The property being protected is not the number 404 — it is that
   * the answer must not depend on whether family B's row exists.
   *
   * So when a route answers something other than 404, this asks the SAME
   * question about an id that exists nowhere. If the two answers are identical,
   * status and body, the answer is a property of the ROUTE and discloses
   * nothing about family B, and it is admitted with that proof attached. If
   * they differ, the route is an existence oracle and the probe fails — which
   * is exactly how the ledger entry above was found.
   */
  const assertIndistinguishableFromNonexistent = async (
    route: Route,
    token: string,
    actual: any,
  ): Promise<void> => {
    const control = await send(route, nonexistentUrl(route), token);
    expect({ status: actual.status, body: actual.body }).toEqual({
      status: control.status,
      body: control.body,
    });
  };

  it('RULE X1 — every route is probed by one of the four sweeps, or classified with a reason', () => {
    // THE RATCHET. A route added tomorrow with no probe and no classification
    // lands in `uncovered` and fails HERE, BY NAME. There is no count to
    // satisfy by adding routes, and no floor that can be cleared while two
    // thirds of the surface goes unprobed.
    expect(uncovered.map(nameOf)).toEqual([]);

    // And no classification names a route that no longer exists.
    const live = new Set(routes.map(nameOf));
    expect(CLASSIFIED_ROUTES.map((e) => e.what).filter((w) => !live.has(w))).toEqual([]);

    // The four sweeps plus the classifications account for the table EXACTLY.
    expect(
      targetedAll.length + collection.length + writes.length + platform.length + CLASSIFIED_ROUTES.length,
    ).toBe(routes.length);

    // Every ledger entry names a live route, and one the targeted sweep would
    // otherwise have covered — a ledger that drifts off the route table is a
    // ledger nobody has to satisfy.
    expect(CROSS_TENANT_DEFECT_LEDGER.map((e) => e.what).filter((w) => !live.has(w))).toEqual([]);
    const targetable = new Set(targetedAll.map(nameOf));
    expect(CROSS_TENANT_DEFECT_LEDGER.map((e) => e.what).filter((w) => !targetable.has(w))).toEqual([]);
  });

  it('RULE X2 — every classification carries a class and a real one-line reason', () => {
    for (const entry of CLASSIFIED_ROUTES) {
      expect(['GLOBAL_CATALOGUE', 'UNAUTHENTICATED']).toContain(entry.classification);
      // A reason short enough to be nothing IS nothing.
      expect(`${entry.what}:${entry.reason.trim().length > 80}`).toBe(`${entry.what}:true`);
      expect(entry.reason).not.toMatch(/\n/);
    }
    const named = CLASSIFIED_ROUTES.map((e) => e.what);
    expect(named).toHaveLength(new Set(named).size);
  });

  it('RULE X3 — the fixture really seeded a family-B row for every id the sweep claims to fill', () => {
    const missing = VICTIM_PARAMS.filter((p) => !bResources[p]);
    expect(missing).toEqual([]);

    // Non-vacuity: no sweep is empty, and the targeted sweep covers materially
    // more than the six-name whitelist it replaced.
    expect(targetedAll.length).toBeGreaterThanOrEqual(90);
    expect(collection.length).toBeGreaterThanOrEqual(30);
    expect(writes.length).toBeGreaterThanOrEqual(30);
    expect(platform.length).toBeGreaterThanOrEqual(20);
  });

  it('seeded three distinct families with real tokens and real resources', () => {
    expect(familyIds.A).toBeTruthy();
    expect(familyIds.B).toBeTruthy();
    expect(familyIds.C).toBeTruthy();
    expect(new Set([familyIds.A, familyIds.B, familyIds.C]).size).toBe(3);
    expect(aChildToken).toBeTruthy();
    expect(cParentToken).toBeTruthy();
    expect(cChildToken).toBeTruthy();
  });

  /**
   * Routes whose probe cannot decide the isolation question, WITH the reason.
   * Anything not in this map must answer 404. The map is asserted to be exact —
   * a route that starts or stops being inconclusive fails the build.
   */
  const INCONCLUSIVE: Record<string, string> = {
    'GET /ai-core/recommendation/:childId':
      'Requires a ?deviceId= query param that is typed as `string` but never validated; omitting it reaches prisma.device.findUnique({where:{id: undefined}}) and answers 500 for the OWNER too. A pre-existing input-validation defect (not an isolation defect) — see F2 report.',
    'GET /ai-core/behavioral-trend/:childId': 'Same missing ?deviceId= validation as recommendation/:childId.',
    'GET /ai-core/insights/:childId':
      'ai-platform.controller.ts composes the two routes above in one Promise.all, so it inherits the same unvalidated ?deviceId= and answers 500 for the OWNER too. Newly visible because the widened sweep reaches it; the same input-validation defect, not an isolation one.',
  };

  // =========================================================================
  // SWEEP 1 — TARGETED: family A, pointed at a real family-B row
  // =========================================================================

  it.each(targeted.map((r) => [nameOf(r), r] as const))(
    "%s — family A must NOT reach family B's resource",
    async (routeLabel, route) => {
      const url = fillParams(route);
      // The child surface is swept with family A's OWN device token: a parent
      // token there is the wrong ACTOR TYPE, which Passport answers before any
      // handler runs and which says nothing about tenancy.
      const token = isDeviceSurface(route) ? aChildToken : tokens.A;
      const res = await send(route, url, token);

      // ---- nothing of family B in the body, whatever the status ---------
      // The single assertion that no widening can weaken: a value belonging to
      // family B that the caller did not itself supply is a leak, full stop.
      expect(disclosuresIn(res, url)).toEqual([]);

      // ---- inconclusive, with a written reason ---------------------------
      if (INCONCLUSIVE[routeLabel]) {
        // Prove it really is the route and not the tenant: the OWNER of the
        // resource fares no better on the identical request. Not exact status
        // parity — `insights/:childId` rejects from whichever of its two
        // Promise.all arms loses the race, so the exact code is not stable —
        // but the owner failing too is what rules the tenant out as the cause.
        const owner = await send(route, url, tokens.B);
        expect(owner.status).toBeGreaterThanOrEqual(400);
        return;
      }

      // ---- the strong requirement ---------------------------------------
      // 404, never 403: a 403 confirms the resource exists in another family.
      // 400 is accepted only on write verbs, where DTO validation rejects the
      // empty probe body before ownership is consulted; the dedicated
      // valid-body test below closes that hole for the representative case.
      const verb = route.method.toLowerCase();
      const acceptable = verb === 'get' || verb === 'delete' ? [404] : [400, 404];
      if (acceptable.includes(res.status)) return;

      // Anything else — a 2xx, a 403, a 500 — is admissible ONLY with the
      // indistinguishability proof: the same request against an id that exists
      // nowhere must produce the identical answer. That is what turns "this
      // route answers 403" into "this route answers 403 to everyone, so it says
      // nothing about family B", and it is what caught the ledger entry above.
      // eslint-disable-next-line no-console
      console.log('PROBE-NON-404', routeLabel, res.status, JSON.stringify(res.body).slice(0, 200));
      await assertIndistinguishableFromNonexistent(route, token, res);
      // And a 2xx still has to be empty of family B, which `disclosuresIn`
      // above already decided over the whole body.
    },
    30_000,
  );

  // =========================================================================
  // THE DEFECT LEDGER, ONE `it.failing` PER ENTRY
  //
  // `it.failing` PASSES while the body throws and FAILS the day it stops — so
  // the entry cannot outlive the defect, and the defect cannot be forgotten.
  // =========================================================================

  describe('the cross-tenant defect ledger', () => {
    it('every entry names its evidence and says what leaks', () => {
      for (const entry of CROSS_TENANT_DEFECT_LEDGER) {
        expect(`${entry.what}:${entry.detail.trim().length > 120}`).toBe(`${entry.what}:true`);
        expect(entry.evidence).toMatch(/^src\/.+:\d/);
      }
      const named = CROSS_TENANT_DEFECT_LEDGER.map((e) => e.what);
      expect(named).toHaveLength(new Set(named).size);
    });

    if (CROSS_TENANT_DEFECT_LEDGER.length === 0) {
      it('is EMPTY — every id-taking route answers an outsider the same way it answers a stranger', () => {
        expect(CROSS_TENANT_DEFECT_LEDGER).toEqual([]);
      });
    } else {
      it.failing.each(CROSS_TENANT_DEFECT_LEDGER.map((e) => [e.what, e.detail] as const))(
        '%s — STILL AN EXISTENCE ORACLE (this test passes while the defect exists)',
        async (what) => {
          const route = routes.find((r) => nameOf(r) === what);
          expect(route).toBeDefined();
          const token = isDeviceSurface(route!) ? aChildToken : tokens.A;
          const real = await send(route!, fillParams(route!), token);
          await assertIndistinguishableFromNonexistent(route!, token, real);
        },
        30_000,
      );
    }
  });

  it('the inconclusive list is exact — no stale entries, no silent growth', () => {
    const liveTargets = new Set(targetedAll.map(nameOf));
    expect(Object.keys(INCONCLUSIVE).filter((k) => !liveTargets.has(k))).toEqual([]);
    expect(Object.keys(INCONCLUSIVE)).toHaveLength(3);
  });

  // =========================================================================
  // SWEEP 2 — COLLECTION: the routes that take no id at all
  //
  // THE SWEEP THIS SUITE DID NOT HAVE, AND THE ONE THAT WOULD HAVE CAUGHT
  // `GET /feature-flags`. A 200 is the CORRECT answer here — it is family A's
  // own list — so the question is not the status, it is whether family B is in
  // the body.
  // =========================================================================

  it.each(collection.map((r) => [nameOf(r), r] as const))(
    '%s — family A’s list must contain nothing of family B',
    async (_routeLabel, route) => {
      const token = isDeviceSurface(route) ? aChildToken : tokens.A;
      const url = fillParams(route);
      const res = await send(route, url, token);
      expect(disclosuresIn(res, url)).toEqual([]);
    },
    30_000,
  );

  // =========================================================================
  // SWEEP 3 — WRITES with no id, aimed at DISPOSABLE FAMILY C
  //
  // Aimed at C and never at A or B, so that a write which really does execute
  // lands in a family this suite deletes. The probe body is empty, so the
  // ValidationPipe refuses most of these before the handler — which is exactly
  // why it is installed. What is still decided: no write echoes another
  // family's rows back to its caller.
  // =========================================================================

  it.each(writes.map((r) => [nameOf(r), r] as const))(
    '%s — a write from outside family B must not echo family B',
    async (_routeLabel, route) => {
      const token = isDeviceSurface(route) ? cChildToken : cParentToken;
      const url = fillParams(route);
      const res = await send(route, url, token);
      expect(disclosuresIn(res, url)).toEqual([]);
    },
    30_000,
  );

  // =========================================================================
  // SWEEP 4 — PLATFORM: a family token has no business on the operator surface
  // =========================================================================

  it.each(platform.map((r) => [nameOf(r), r] as const))(
    '%s — a family token carries no operator key and must be refused',
    async (_routeLabel, route) => {
      const url = fillParams(route);
      const res = await send(route, url, tokens.A);
      expect([200, 201, 202, 204]).not.toContain(res.status);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(disclosuresIn(res, url)).toEqual([]);
    },
    30_000,
  );

  it("a valid-bodied write against family B's child is still 404, not 400-by-accident", async () => {
    const res = await request(http)
      .post(`/life-intelligence/habits/${bResources.childId}`)
      .set(auth('A'))
      .send({ title: 'Cross-tenant habit', category: 'LEARNING' });
    expect(res.status).toBe(404);

    // And nothing was written into family B.
    const { runAsSystem } = require('../../src/common/tenancy/system-context');
    const planted = await runAsSystem('TEST_FIXTURE', 'Verifying the probe wrote nothing across tenants.', async () =>
      prisma.habit.count({ where: { title: 'Cross-tenant habit' } }),
    );
    expect(planted).toBe(0);
  }, 30_000);

  it("family B can still reach its OWN resources — the probe is not just breaking everything", async () => {
    const res = await request(http).get(`/children/${bResources.childId}`).set(auth('B'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(bResources.childId);
  }, 30_000);

  it('the collection sweep is not vacuous — the needle scan really does detect family B', async () => {
    // Without this, every assertion in SWEEP 2 would pass just as well against
    // an API that answered 500 to everything, or against a needle list of
    // strings that appear nowhere.
    const res = await request(http).get('/children').set(auth('B'));
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.id)).toContain(bResources.childId);
    expect(disclosuresIn(res).length).toBeGreaterThan(0);
  }, 30_000);

  // =========================================================================
  // PHASE C / P3 — THE CROSS-ROLE SWEEP
  //
  // The tenant probe above replays the route table across FAMILIES. A4 §SA-005
  // showed the second axis was wide open: inside ONE family, every principal
  // had every permission. This replays the SAME derived route table across
  // ROLES, in the direction that is safe to execute — every call below is one
  // the system must REFUSE, so nothing is written and no fixture is mutated by
  // sweeping.
  //
  // Generated, not hand-written: a route added tomorrow is swept tomorrow.
  // =========================================================================

  /** Every route the CHILD surface does NOT include, and that is not public. */
  const notChildRoutes = routes.filter(
    (r) => (r.roles ?? []).length > 0 && !(r.roles ?? []).includes(Role.CHILD),
  );

  it('the cross-role sweep has a meaningful number of routes to probe', () => {
    expect(notChildRoutes.length).toBeGreaterThanOrEqual(140);
    expect(routes.filter((r) => (r.roles ?? []).includes(Role.CHILD)).length).toBeGreaterThanOrEqual(30);
  });

  it.each(notChildRoutes.map((r) => [nameOf(r), r] as const))(
    "%s — a CHILD's device token must NOT reach it",
    async (_routeLabel, route) => {
      const res = await send(route, fillParams(route), bChildToken);
      // Not 2xx is the whole requirement. The status will be 401 on the parent
      // surface (the `jwt` strategy rejects a `device-jwt` actor before any
      // handler runs) and 404 on the platform surface; both are refusals, and
      // asserting the exact one would be asserting an implementation detail of
      // Passport rather than the security property.
      expect([200, 201, 202, 204]).not.toContain(res.status);
      expect(res.status).toBeGreaterThanOrEqual(400);
    },
    30_000,
  );

  /** Routes reserved for the family OWNER. Derived, so the list cannot drift. */
  const ownerOnlyRoutes = routes.filter(
    (r) => JSON.stringify(r.roles) === JSON.stringify([Role.OWNER]),
  );

  it('the OWNER-only surface is non-empty — otherwise the sweep below is vacuous', () => {
    expect(ownerOnlyRoutes.length).toBeGreaterThanOrEqual(5);
  });

  it.each(ownerOnlyRoutes.map((r) => [nameOf(r), r] as const))(
    '%s — a CO-PARENT (PARENT) must be refused with 403 ROLE_NOT_PERMITTED',
    async (_routeLabel, route) => {
      const res = await send(route, fillParams(route), bCoParentToken);
      expect(res.status).toBe(403);
      // 403 and not 404 here is deliberate and argued in `authz.errors.ts`: the
      // caller is a PROVEN member of this tenant, so there is no existence to
      // conceal — only a permission to report, with a code the app can branch
      // on. The guard also runs BEFORE the ValidationPipe, which is why an
      // empty body does not turn this into a 400.
      expect(res.body.code).toBe('ROLE_NOT_PERMITTED');
      expect(res.body.requiredRoles).toEqual([Role.OWNER]);
      expect(res.body.heldRole).toBe(Role.PARENT);
    },
    30_000,
  );

  it('the co-parent is NOT locked out of the ordinary parenting surface', () => {
    // Without this the sweep above would pass just as well if PARENT had been
    // denied everything, which would be a different bug wearing the same green.
    return request(http)
      .get('/children')
      .set({ Authorization: `Bearer ${bCoParentToken}` })
      .expect(200)
      .then((res: any) => {
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.map((c: any) => c.id)).toContain(bResources.childId);
      });
  }, 30_000);

  it("a co-parent still cannot reach family A — role and tenant are independent locks", async () => {
    expect(bCoParentUserId).toBeTruthy();
    expect(aChildId).toBeTruthy();
    // Family A's real child — created in `beforeAll` through the real API — must
    // not appear in family B's co-parent's list. (It used to be created here;
    // the fixture now needs it earlier, to pair family A's probing device.)
    const res = await request(http)
      .get('/children')
      .set({ Authorization: `Bearer ${bCoParentToken}` });
    expect(res.status).toBe(200);
    expect(res.body.map((c: any) => c.id)).not.toContain(aChildId);
    // And family A really can see it, so the assertion above is not passing
    // because the child does not exist.
    const owner = await request(http).get('/children').set(auth('A'));
    expect(owner.status).toBe(200);
    expect(owner.body.map((c: any) => c.id)).toContain(aChildId);
  }, 30_000);
});
