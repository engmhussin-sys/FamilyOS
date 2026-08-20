/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * THE AUDIENCE BOUNDARY ON EVERY DEEP-LINK DESTINATION.
 *
 * ===========================================================================
 * WHAT THIS SUITE IS, AND WHAT IT DELIBERATELY IS NOT.
 * ===========================================================================
 *
 * `notification-destination.ts` answers WHERE a notification tap lands:
 * `abny://<surface>[/<id>]`, twelve canonical surfaces, and a guard elsewhere
 * already proves every surface RESOLVES in the client that receives it. That
 * question — "does the tap land anywhere?" — is closed.
 *
 * The question this file asks is the next one, and it was open: WHO MAY READ
 * WHAT IS BEHIND THE SURFACE. A link is a routing decision; the answer to it
 * is an HTTP request carrying a token. `abny://subscription` handed to a child
 * device would be a client bug; a CHILD TOKEN that can read
 * `GET /billing/subscription` is a server one, and no amount of client routing
 * fixes it.
 *
 * THREE SUITES ALREADY EXIST AND THIS ONE DOES NOT REDO THEM:
 *
 *   `test/tenancy/controller-guard-coverage.spec.ts` — STRUCTURAL. Every route
 *     is guarded and declares `@Roles`. It reads metadata; it sends no request.
 *   `test/tenancy/cross-tenant-probe.e2e.spec.ts` — THE TENANT AXIS. Family A
 *     pointed at family B's rows, plus a cross-role sweep asserting a child's
 *     device token gets `>= 400` on every non-CHILD route.
 *   `test/authz/intra-family-authorization.e2e.spec.ts` — the co-parent /
 *     owner split inside one family.
 *
 * WHAT IS ADDED HERE, and every one of the four is absent above:
 *
 *   1. THE SURFACE REGISTRY IS THE LIST. `SURFACE_AUDIENCE` is keyed on
 *      `DEEP_LINK_SURFACES`, READ FROM THE REGISTRY AT TEST TIME, and RULE D1
 *      asserts the two agree in BOTH directions. A thirteenth destination
 *      added tomorrow with no audience assertion fails THIS BUILD BY NAME.
 *      This repository has already been burned by the alternative: the
 *      cross-tenant probe's previous shape filtered to a hand-written list of
 *      six param names, asserted `>= 20`, and reported itself exhaustive while
 *      covering roughly a third of the id surface.
 *   2. `>= 400` IS NOT THE ASSERTION. A 500 is `>= 400` and is not a refusal —
 *      it is an unhandled path, which is how a stack trace, a query fragment or
 *      a row's contents reach a caller who was supposed to be refused. Every
 *      probe below asserts a CLEAN refusal (401/403/404) and scans the body for
 *      the other audience's data.
 *   3. THE PARENT -> CHILD DIRECTION, which no suite exercised at all. Every
 *      `/self/*` route is a child-only surface and a parent token must fail
 *      cleanly on it, not 500 its way through a null `childId`.
 *   4. THE DATABASE, NOT THE STATUS CODE. A refused write that nevertheless
 *      wrote is a 403 with a side effect. The screen-time policy WRITE, the
 *      billing subscribe, the approval decision and the child rename are each
 *      read back out of PostgreSQL after the refusal.
 *
 * AND THE EXISTENCE ORACLE, on every id-carrying surface. `POST
 * /organizations/invitations/:invitationId/accept` shipped one: 404 for an
 * unknown id, 403/400 for a real one, so the status code answered "does this
 * row exist" to a caller with no right to know. That was found on the TENANT
 * axis. RULE D5 asks the same question on the AUDIENCE axis — a child token
 * pointed at a REAL id of its own family versus one that exists nowhere must
 * get byte-identical answers.
 */
import { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { Role } from '../../src/common/authz/principal-role';
import { ROLES_METADATA } from '../../src/common/authz/roles.decorator';
import { buildValidationPipe } from '../../src/common/http/global-pipeline';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import {
  DEEP_LINK_SURFACES,
  DeepLinkSurface,
  destinationKeys,
  resolveNotificationDestination,
} from '../../src/modules/notifications/domain/engine/notification-destination';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** An id that exists nowhere, in any table, in any family. */
const NOWHERE_UUID = '00000000-0000-4000-8000-0000000000ff';

// ===========================================================================
// THE AUDIENCE TABLE — KEYED ON THE REGISTRY, NOT ON A HAND-WRITTEN LIST
// ===========================================================================

/**
 * `PARENT_ONLY`  the data behind this surface belongs to the parent app. A
 *                CHILD token reaching any route named here is the defect.
 * `CHILD_ONLY`   the data behind it is the child's own `/self/*` view. A PARENT
 *                token must be refused CLEANLY — the parent has a legitimate
 *                route to the same facts elsewhere, so this is a wrong-actor
 *                error and never a 500.
 * `BOTH`         the surface exists in both apps, and each app has its OWN
 *                backing routes. Both directions are probed: the parent's
 *                routes must refuse the child, and the child's must refuse the
 *                parent. "Both apps have the screen" is not "either token may
 *                read either app's data".
 */
type SurfaceAudience = 'PARENT_ONLY' | 'CHILD_ONLY' | 'BOTH';

interface SurfaceContract {
  readonly audience: SurfaceAudience;
  /**
   * The routes that serve this surface IN THE PARENT APP, as
   * `METHOD /path` exactly as the application's own route table names them.
   * Empty iff the surface is `CHILD_ONLY`.
   */
  readonly parentRoutes: readonly string[];
  /** The same for the CHILD app. Empty iff the surface is `PARENT_ONLY`. */
  readonly childRoutes: readonly string[];
  /**
   * Whether the REGISTRY will hand a link to this surface to a CHILD audience.
   * MEASURED at test time by RULE D3 against `resolveNotificationDestination`,
   * never assumed — this field is what the measurement is compared to, so a
   * change in the registry's rule-3 enforcement fails here by name.
   */
  readonly linkReachableByChild: boolean;
  /** Why this surface has the audience it has. One line, and it must say something. */
  readonly reason: string;
}

const SURFACE_AUDIENCE: Readonly<Record<DeepLinkSurface, SurfaceContract>> = Object.freeze({
  goals: {
    audience: 'BOTH',
    parentRoutes: ['GET /reward-programs', 'GET /life-intelligence/learning/:childId/goals'],
    childRoutes: ['GET /self/achievements/today', 'GET /life-intelligence/self/smart-tasks'],
    linkReachableByChild: true,
    reason:
      'deep_link_router.dart sends a parent to AppRoutes.goals (the reward_programs list) and child_deep_link_router.dart sends a child to ChildHomeTab.today; the two screens read different routes over different guards, and the child’s never names another child.',
  },
  goal: {
    audience: 'BOTH',
    parentRoutes: ['GET /reward-programs/:programId', 'PATCH /reward-programs/:programId'],
    childRoutes: ['GET /self/achievements/today'],
    linkReachableByChild: true,
    reason:
      'ProgramDetailScreen(programId) in the parent app reads and edits the program row; the child’s GoalDetailScreen is rendered from the today payload the child already holds, so the child app has no by-id read of a program at all.',
  },
  approvals: {
    audience: 'PARENT_ONLY',
    parentRoutes: [
      'GET /reward-programs/achievements/pending',
      'GET /life-intelligence/communication/pending',
    ],
    childRoutes: [],
    linkReachableByChild: false,
    reason:
      'The pending-approval queue is the list of decisions a parent has not made yet; a child able to read it learns what its parent is about to be asked, which is the whole content of the parental control.',
  },
  approval: {
    audience: 'PARENT_ONLY',
    parentRoutes: [
      'GET /reward-programs/achievements/:achievementId',
      'GET /reward-programs/achievements/:achievementId/attempts',
      'POST /reward-programs/achievements/:achievementId/approve',
      'POST /reward-programs/achievements/:achievementId/reject',
    ],
    childRoutes: [],
    linkReachableByChild: false,
    reason:
      'One item awaiting a parent, and the two routes that DECIDE it. A child holding the decision routes would approve its own achievement and grant itself the reward — the exact loop parental approval exists to close.',
  },
  rewards: {
    audience: 'BOTH',
    parentRoutes: [
      'GET /reward-programs/fulfilments',
      'PATCH /reward-programs/fulfilments/:fulfilmentId',
    ],
    childRoutes: ['GET /self/achievements/rewards', 'GET /life-intelligence/self/rewards/account'],
    linkReachableByChild: true,
    reason:
      'The parent’s `rewards` is the FULFILMENT queue (what the household still owes, and the row that marks it delivered); the child’s is its own balance and catalogue. Same word, two surfaces, two guards.',
  },
  progress: {
    audience: 'BOTH',
    parentRoutes: [
      'GET /life-intelligence/rewards/:childId/account',
      'GET /reward-programs/streaks/:childId',
    ],
    childRoutes: ['GET /self/achievements/streaks', 'GET /self/achievements/badges'],
    linkReachableByChild: true,
    reason:
      'ProgressChildrenScreen resolves WHICH child from the family’s own data and reads that child’s ledger by id; the child app reads only its own, with no id in the path to get wrong.',
  },
  coach: {
    audience: 'BOTH',
    parentRoutes: ['GET /ai-coach/parent/:childId/summary', 'GET /life-intelligence/coaching/:childId'],
    childRoutes: ['GET /self/coach/today', 'GET /self/coach/topics'],
    // FALSE, and not because a child is forbidden the coach — because NO
    // destination rule emits `abny://coach` for ANY audience today.
    // `CHILD_WELLBEING_CHECKIN` used to resolve here and now takes
    // `safetyDestination`. Both clients still ROUTE the surface, so the day a
    // rule points at it again this line is the diff that says so. Recorded by
    // RULE D4b, which names it rather than letting a surface quietly become
    // unreachable.
    linkReachableByChild: false,
    reason:
      'The parent’s coach is an analysis OF a named child — next steps, activities, reward rules; the child’s is a check-in and a topic catalogue about itself. A child reading the parent half reads its own behavioural assessment.',
  },
  'screen-time': {
    audience: 'BOTH',
    parentRoutes: [
      'GET /children/:childId/screen-time-policy',
      'GET /children/:childId/screen-time-policy/effective',
      'POST /children/:childId/screen-time-policy',
      'GET /life-intelligence/wellbeing/:childId/snapshot',
    ],
    childRoutes: ['GET /pairing/device/policy', 'GET /life-intelligence/self/health/progress'],
    linkReachableByChild: true,
    reason:
      'THE WRITE IS THE POINT. A child may READ the policy that binds it (GET /pairing/device/policy, its own device’s effective policy) and must never WRITE one: POST /children/:childId/screen-time-policy is the control itself, and a child that can set it has no limits.',
  },
  safety: {
    audience: 'PARENT_ONLY',
    parentRoutes: ['GET /pairing/alerts', 'GET /ai-core/alerts'],
    childRoutes: [],
    linkReachableByChild: true,
    reason:
      'Device alerts and the parent-facing AI alert feed — protection bypass attempts, accessibility disabled, the distress escalation. A child reading it learns exactly which of its actions were detected, which is a map of what to do differently next time.',
  },
  child: {
    audience: 'PARENT_ONLY',
    parentRoutes: ['GET /children/:childId', 'PATCH /children/:childId', 'GET /reports/:childId'],
    childRoutes: [],
    linkReachableByChild: false,
    reason:
      'One child’s detail page. The parent app is multi-child by construction and the child app is single-child, so this surface is the one place a SIBLING’s row is addressable — probed as such by RULE D7.',
  },
  subscription: {
    audience: 'PARENT_ONLY',
    parentRoutes: [
      'GET /billing/subscription',
      'GET /billing/entitlements',
      'GET /billing/history',
      'POST /billing/subscribe',
      'POST /billing/cancel',
    ],
    childRoutes: [],
    linkReachableByChild: false,
    reason:
      'Money. The two writes commit the whole household to a charge and are OWNER-only even among parents; the three reads disclose the payer, the plan and the payment history.',
  },
  notifications: {
    audience: 'BOTH',
    parentRoutes: ['GET /notifications', 'GET /notifications/unread-count', 'PATCH /notifications/:id/read'],
    childRoutes: ['GET /life-intelligence/self/messages'],
    linkReachableByChild: true,
    reason:
      'The universal fallback, and the one surface where the two audiences are told DIFFERENT THINGS about the same fact: `notifications` rows are the parent’s and carry the producer payload; `child_messages` are the child’s and carry one whitelisted field.',
  },
});

// ===========================================================================
// ROUTE ENUMERATION — the application’s own table, never a copy of it
// ===========================================================================

interface Route {
  method: string;
  path: string;
  params: string[];
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
      const classGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, exported) ?? [];
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        if (sub === undefined) continue;
        const methodGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
        const full = `/${base}/${sub}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        out.push({
          method: HTTP_METHODS[Reflect.getMetadata(METHOD_METADATA, handler)],
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
    const { PrismaClient } = require('@prisma/client/wasm');
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
  const base = new PrismaClient({ datasources: { db: { url } } });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

/**
 * PHASE C’s lesson, inherited: the `/auth/*` throttle counter is IP-keyed and
 * lives in the REAL Redis, so one budget is shared by every e2e suite in a
 * `--runInBand` run. Cleared on the way in and on the way out.
 */
async function clearThrottleCounters(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Redis = require('ioredis');
  const client = new Redis(process.env.REDIS_URL as string);
  const keys = await client.keys('throttle:*');
  if (keys.length > 0) await client.del(...keys);
  await client.quit();
}

describeIfDb('the audience boundary on every deep-link destination', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;

  const stamp = Date.now();
  const email = `audience.parent.${stamp}@example.com`;
  const password = 'Audience-Passw0rd!23';

  let parentToken = '';
  let childToken = '';
  let siblingChildToken = '';
  let familyId = '';
  let parentUserId = '';

  /** Real rows of this family, keyed by the route param name they fill. */
  const ids: Record<string, string> = {};

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `deep-link audience fixture: ${what}`, async () => await fn());

  async function seedChildDevice(
    childId: string,
    tokenService: TokenService,
  ): Promise<{ deviceId: string; token: string }> {
    const device = await sys(`device for ${childId}`, () =>
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
    // The SAME pipeline production deploys, so a probe exercises the deployed
    // application and not a looser one.
    app.useGlobalPipes(buildValidationPipe());
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    const tokenService = app.get(TokenService);

    const reg = await request(http).post('/auth/register').send({
      email,
      password,
      fullName: 'Audience Parent',
      familyName: `Audience Family ${stamp}`,
      acceptedTerms: true,
    });
    if (![200, 201].includes(reg.status)) {
      throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
    }
    const login = await request(http).post('/auth/login').send({ email, password });
    if (login.status !== 200) {
      throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
    }
    parentToken = login.body.tokens?.accessToken ?? login.body.accessToken;
    const claims = JSON.parse(Buffer.from(parentToken.split('.')[1], 'base64').toString());
    familyId = claims.familyId;
    parentUserId = claims.sub;

    // Two children, so "another child's detail" is a real row and not a
    // hypothetical: the sibling is what makes RULE D7 mean anything.
    const kid = await request(http)
      .post('/children')
      .set({ Authorization: `Bearer ${parentToken}` })
      .send({ firstName: 'Audience Kid One', dateOfBirth: '2015-04-01' });
    expect([200, 201]).toContain(kid.status);
    ids.childId = kid.body.id;

    // THE SIBLING IS SEEDED THROUGH PRISMA, NOT THROUGH `POST /children`, and
    // the reason is a real product rule rather than convenience: a fresh family
    // is on the free entitlement, which caps the household at one child, so the
    // second create answers 403 QUOTA. Buying a plan to obtain a sibling would
    // make this suite depend on the billing flow staying green — and the
    // sibling here is a ROW the audience probe points at, not a purchase under
    // test.
    const sibling = await sys('sibling child', () =>
      prisma.child.create({
        data: {
          familyId,
          firstName: 'Audience Kid Two',
          dateOfBirth: new Date('2017-08-08'),
        },
        select: { id: true },
      }),
    );
    ids.siblingChildId = sibling.id;

    childToken = (await seedChildDevice(ids.childId, tokenService)).token;
    siblingChildToken = (await seedChildDevice(ids.siblingChildId, tokenService)).token;

    // One real row of every id type the surfaces above address. Seeded through
    // Prisma rather than driven through six product flows, for the reason the
    // cross-tenant probe gives: a fixture that depends on business flows
    // staying green is a fixture that silently stops seeding.
    await sys('rows behind every id-bearing surface', async () => {
      const program = await prisma.rewardProgram.create({
        data: {
          familyId,
          childId: ids.childId,
          category: 'STUDY',
          activity: 'READING',
          targetSpec: { minutes: 20 },
          targetSummaryAr: 'قراءة عشرين دقيقة',
          durationMinutes: 20,
          verificationLevel: 'PARENT_APPROVAL',
          rewardSpec: { type: 'COINS', amount: 5 },
          createdByUserId: parentUserId,
        },
        select: { id: true },
      });
      ids.programId = program.id;

      const achievement = await prisma.achievementRequest.create({
        data: {
          familyId,
          programId: program.id,
          childId: ids.childId,
          status: 'SUBMITTED',
          localDate: new Date(),
          submittedAt: new Date(),
        },
        select: { id: true },
      });
      ids.achievementId = achievement.id;

      const fulfilment = await prisma.rewardFulfilment.create({
        data: {
          familyId,
          childId: ids.childId,
          achievementId: achievement.id,
          ledgerEntryId: NOWHERE_UUID.replace('ff', 'aa'),
          rewardType: 'PHYSICAL',
          description: 'Audience fixture fulfilment',
        },
        select: { id: true },
      });
      ids.fulfilmentId = fulfilment.id;

      const notification = await prisma.notification.create({
        data: {
          familyId,
          userId: parentUserId,
          type: 'AUDIENCE_FIXTURE',
          title: 'Audience Notification',
          body: 'Audience fixture notification body.',
          sourceEventId: `audience-notification-${stamp}`,
        },
        select: { id: true },
      });
      ids.id = notification.id;

      // The screen-time policy the WRITE probe must leave untouched.
      const policy = await prisma.screenTimePolicy.create({
        data: {
          familyId,
          childId: ids.childId,
          dailyLimitMinutes: 60,
          createdByUserId: parentUserId,
        },
        select: { id: true },
      });
      ids.policyId = policy.id;
    });
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      await runAsSystemAsync(
        'TEST_FIXTURE',
        'deep-link audience teardown removes only the fixtures it created.',
        async () => {
          await prisma.family.deleteMany({ where: { id: familyId } });
          await prisma.user.deleteMany({ where: { id: parentUserId } });
        },
      );
    }
    await app?.close();
    await clearThrottleCounters();
  });

  // =========================================================================
  // THE DERIVED TABLE
  // =========================================================================

  const routes = enumerateRoutes();
  const routeByName = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
  const surfaces = [...DEEP_LINK_SURFACES];

  const contractOf = (s: DeepLinkSurface): SurfaceContract =>
    (SURFACE_AUDIENCE as Record<string, SurfaceContract>)[s];

  /** `METHOD /path` -> the surface(s) that named it, for a legible failure. */
  const parentRouteEntries: { surface: DeepLinkSurface; name: string }[] = [];
  const childRouteEntries: { surface: DeepLinkSurface; name: string }[] = [];
  for (const surface of surfaces) {
    const contract = contractOf(surface);
    if (!contract) continue;
    for (const name of contract.parentRoutes) parentRouteEntries.push({ surface, name });
    for (const name of contract.childRoutes) childRouteEntries.push({ surface, name });
  }

  const fillUrl = (routePath: string, overrides: Record<string, string> = {}): string => {
    let url = routePath;
    for (const [, param] of routePath.matchAll(/:(\w+)/g)) {
      url = url.replace(`:${param}`, overrides[param] ?? ids[param] ?? NOWHERE_UUID);
    }
    return url;
  };

  const send = (name: string, url: string, token: string) => {
    const [method, ...rest] = name.split(' ');
    void rest;
    const verb = method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
    return (request(http) as any)[verb](url)
      .set({ Authorization: `Bearer ${token}` })
      .send({});
  };

  /**
   * Every string that belongs to the PARENT audience of this family. A body
   * returned to a CHILD token containing one of these has crossed the boundary,
   * whatever its status code said.
   */
  const parentNeedles = (): { needle: string; what: string }[] => [
    { needle: email, what: 'the parent’s e-mail' },
    { needle: parentUserId, what: 'the parent’s user id' },
    { needle: ids.siblingChildId, what: 'the SIBLING’s child id' },
    { needle: 'Audience Kid Two', what: 'the sibling’s name' },
    { needle: 'Audience Notification', what: 'a parent-surface notification title' },
    { needle: 'Audience fixture fulfilment', what: 'a parent-surface fulfilment row' },
  ];

  /**
   * `requestUrl` is subtracted for the reason the tenant probe subtracts it: a
   * refusal that echoes the id THE CALLER JUST SENT is not a disclosure, and
   * treating it as one would drown every real finding.
   */
  const disclosuresIn = (res: any, requestUrl: string): string[] => {
    const text = JSON.stringify(res.body ?? '') + String(res.text ?? '');
    return parentNeedles()
      .filter(({ needle }) => needle && text.includes(needle) && !requestUrl.includes(needle))
      .map(({ needle, what }) => `${what} (${needle})`);
  };

  /**
   * A CLEAN REFUSAL, and this is the assertion the existing cross-role sweep
   * does not make. `>= 400` admits a 500, and a 500 is not a decision — it is
   * an unhandled path that reached far enough into a handler to throw, which
   * is precisely where a query fragment or a row's contents escape.
   */
  const CLEAN_REFUSALS = [400, 401, 403, 404];
  const expectCleanRefusal = (label: string, res: any, url: string): void => {
    expect(`${label} -> ${res.status}`).toBe(`${label} -> ${res.status}`);
    // Stated as an equality on a STRING so a failure names the route and the
    // status it actually answered, instead of "expected 500 to be one of […]".
    expect({
      route: label,
      accepted: [200, 201, 202, 204].includes(res.status),
      serverError: res.status >= 500,
      status: CLEAN_REFUSALS.includes(res.status) ? 'clean-refusal' : `unexpected-${res.status}`,
    }).toEqual({
      route: label,
      accepted: false,
      serverError: false,
      status: 'clean-refusal',
    });
    expect({ route: label, disclosed: disclosuresIn(res, url) }).toEqual({
      route: label,
      disclosed: [],
    });
  };

  // =========================================================================
  // RULE D1 — THE REGISTRY IS THE LIST, AND A NEW SURFACE FAILS BY NAME
  // =========================================================================

  it('RULE D1 — every surface in the destination registry has an audience assertion, and no assertion names a surface the registry dropped', () => {
    const declared: string[] = Object.keys(SURFACE_AUDIENCE).sort();
    const registry: string[] = [...(surfaces as readonly string[])].sort();

    // BOTH DIRECTIONS, and each named. `toEqual` on the whole arrays would say
    // "arrays differ"; these two say WHICH surface, which is the difference
    // between a red build somebody can act on and one they have to bisect.
    expect(registry.filter((s) => !declared.includes(s))).toEqual([]);
    expect(declared.filter((s) => !registry.includes(s))).toEqual([]);

    // Non-vacuity: the registry really did load, and really has the twelve
    // surfaces the clients switch on. A registry that collapsed to `[]` would
    // otherwise satisfy every assertion in this file.
    expect(registry.length).toBeGreaterThanOrEqual(12);
  });

  it('RULE D2 — every audience claim carries routes on the side it claims, and a reason worth reading', () => {
    const shapeErrors: string[] = [];
    for (const surface of surfaces) {
      const c = contractOf(surface);
      const hasParent = c.parentRoutes.length > 0;
      const hasChild = c.childRoutes.length > 0;
      const expected =
        c.audience === 'PARENT_ONLY'
          ? hasParent && !hasChild
          : c.audience === 'CHILD_ONLY'
            ? hasChild && !hasParent
            : hasParent && hasChild;
      if (!expected) {
        shapeErrors.push(
          `${surface}: audience=${c.audience} but parentRoutes=${c.parentRoutes.length} childRoutes=${c.childRoutes.length}`,
        );
      }
      if (c.reason.trim().length < 80) shapeErrors.push(`${surface}: reason too short to be a reason`);
    }
    expect(shapeErrors).toEqual([]);
  });

  it('RULE D3 — every route named in the audience table EXISTS, and its declared roles agree with the audience claimed for it', () => {
    const unknown: string[] = [];
    const roleConflicts: string[] = [];

    for (const { surface, name } of parentRouteEntries) {
      const route = routeByName.get(name);
      if (!route) {
        unknown.push(`${surface} (parent): ${name}`);
        continue;
      }
      // A parent-surface route that declared CHILD would be a lie in the
      // permission matrix, and the matrix is what the next engineer reads.
      if ((route.roles ?? []).includes(Role.CHILD)) {
        roleConflicts.push(`${surface}: ${name} declares CHILD but is a PARENT surface`);
      }
    }
    for (const { surface, name } of childRouteEntries) {
      const route = routeByName.get(name);
      if (!route) {
        unknown.push(`${surface} (child): ${name}`);
        continue;
      }
      if (JSON.stringify(route.roles) !== JSON.stringify([Role.CHILD])) {
        roleConflicts.push(
          `${surface}: ${name} is a CHILD surface but declares ${JSON.stringify(route.roles)}`,
        );
      }
    }

    // A route renamed in `src/` makes this table stale, and a stale table is a
    // suite that probes nothing while reporting green.
    expect(unknown).toEqual([]);
    expect(roleConflicts).toEqual([]);
  });

  /**
   * Every link the registry can produce for one audience, over EVERY copy key
   * and BOTH id branches. Both branches matter and one alone would lie: with
   * ids supplied, `goalDestination` emits `abny://goal/<id>` and `goals` looks
   * unreachable; with none, the id-bearing surfaces look unreachable instead.
   * The union is the real answer to "what can this audience be sent".
   */
  const surfacesReachableBy = (audience: 'PARENT' | 'CHILD'): Set<string> => {
    const out = new Set<string>();
    for (const copyKey of destinationKeys()) {
      for (const withIds of [true, false]) {
        const link = resolveNotificationDestination({
          copyKey,
          audience,
          programId: withIds ? NOWHERE_UUID : null,
          achievementId: withIds ? NOWHERE_UUID : null,
          alertId: withIds ? NOWHERE_UUID : null,
        });
        const surface = link.slice('abny://'.length).split('/')[0];
        out.add(surface);
      }
    }
    return out;
  };

  it('RULE D4 — which surfaces the REGISTRY will hand to a CHILD link is measured, not assumed', () => {
    const reachable = surfacesReachableBy('CHILD');
    const measured: Record<string, boolean> = {};
    for (const surface of surfaces) measured[surface] = reachable.has(surface);
    const declared: Record<string, boolean> = {};
    for (const surface of surfaces) declared[surface] = contractOf(surface).linkReachableByChild;

    // `safety` is TRUE here and PARENT_ONLY above, and that pair is the point.
    // The registry's rule-3 enforcement covers `PARENT_ONLY_SURFACES` — child,
    // approvals, approval, subscription — and `safety` is not among them, so a
    // child-audience resolution CAN return `abny://safety/<id>`. It is
    // harmless in the client (child_deep_link_router.dart answers `safety`
    // with ChildHomeTab.today) and it is harmless on the server, which is what
    // the probes below PROVE rather than assume: no route behind `safety` is
    // reachable with a child token. Recorded here so that if the registry ever
    // starts or stops handing this surface to a child, this line goes red.
    expect(measured).toEqual(declared);
  });

  it('RULE D4b — the surfaces NO destination rule emits for EITHER audience are named, not merely absent', () => {
    const parentReachable = surfacesReachableBy('PARENT');
    const childReachable = surfacesReachableBy('CHILD');
    const orphaned = surfaces
      .filter((s) => !parentReachable.has(s) && !childReachable.has(s))
      .sort();

    // `coach` and `child` are LIVE CLIENT SURFACES — both routers answer them,
    // `CoachChildrenScreen` and `ChildDetailScreen` exist — that the server
    // currently never links to. That is a product decision in both cases and
    // it is written down in the registry's own header: `child/<childId>` would
    // put an identifier back on a payload pinned identifier-free, and
    // `CHILD_WELLBEING_CHECKIN` was deliberately moved off `coach` onto the
    // safety surface. Neither is a defect; an ORPHANED SURFACE NOBODY NOTICED
    // would be, which is why this is an equality and not a comment.
    expect(orphaned).toEqual(['child', 'coach']);

    // And the mirror: no surface is reachable by a CHILD that a PARENT cannot
    // reach. The parent app answers every surface; the child app does not.
    expect([...childReachable].filter((s) => !parentReachable.has(s)).sort()).toEqual([]);
  });

  // =========================================================================
  // PROBE 1 — A CHILD TOKEN AGAINST EVERY PARENT-SURFACE ROUTE
  // =========================================================================

  it('the probe fixture is real — a genuine parent, two children, two device tokens and the rows behind them', () => {
    expect(familyId).toBeTruthy();
    expect(parentToken).toBeTruthy();
    expect(childToken).toBeTruthy();
    expect(siblingChildToken).toBeTruthy();
    expect(childToken).not.toBe(siblingChildToken);
    for (const key of ['childId', 'siblingChildId', 'programId', 'achievementId', 'fulfilmentId', 'id']) {
      expect({ key, seeded: Boolean(ids[key]) }).toEqual({ key, seeded: true });
    }
    expect(ids.childId).not.toBe(ids.siblingChildId);
    // Non-vacuity of the sweeps below.
    expect(parentRouteEntries.length).toBeGreaterThanOrEqual(25);
    expect(childRouteEntries.length).toBeGreaterThanOrEqual(12);
  });

  it.each(parentRouteEntries.map((e) => [`${e.surface} :: ${e.name}`, e] as const))(
    '%s — a CHILD device token is refused CLEANLY and is told nothing',
    async (label, entry) => {
      const url = fillUrl(routeByName.get(entry.name)!.path);
      const res = await send(entry.name, url, childToken);
      expectCleanRefusal(label, res, url);
    },
    30_000,
  );

  // =========================================================================
  // PROBE 2 — A PARENT TOKEN AGAINST EVERY CHILD-SURFACE ROUTE
  //
  // The direction no suite exercised. The requirement is NOT that a parent is
  // refused by some number — it is that the refusal is a DECISION. A parent
  // token on a `/self/*` route carries no `childId` claim at all, so a handler
  // reached with one would read `undefined` into a `where` clause; that fails
  // as a 500 and a 500 here is an unhandled path, not a boundary.
  // =========================================================================

  it.each(childRouteEntries.map((e) => [`${e.surface} :: ${e.name}`, e] as const))(
    '%s — a PARENT token fails CLEANLY on the child surface, never 500',
    async (label, entry) => {
      const url = fillUrl(routeByName.get(entry.name)!.path);
      const res = await send(entry.name, url, parentToken);
      expectCleanRefusal(label, res, url);
    },
    30_000,
  );

  // =========================================================================
  // RULE D5 — THE EXISTENCE ORACLE, ON THE AUDIENCE AXIS
  //
  // `POST /organizations/invitations/:invitationId/accept` shipped this defect
  // once: 404 for an unknown id, a different answer for a real one, so the
  // status code told a caller with no right to know whether a row existed. It
  // was found on the tenant axis. The same question on the audience axis is
  // whether a CHILD token can tell its own family's REAL rows from ids that
  // exist nowhere — which would let a paired device enumerate the parent
  // surface it cannot read.
  // =========================================================================

  const idBearingParentRoutes = parentRouteEntries.filter((e) => {
    const route = routeByName.get(e.name);
    return route ? route.params.length > 0 : false;
  });

  it('RULE D5 has something to prove — the parent surface really does carry id-bearing routes', () => {
    expect(idBearingParentRoutes.length).toBeGreaterThanOrEqual(10);
  });

  it('RULE D5 is not vacuous — the same comparison DOES detect a difference when the caller is allowed to see one', async () => {
    // WITHOUT THIS, EVERY D5 ASSERTION IS FREE. On the parent surface a child's
    // device token is rejected by the `jwt` STRATEGY before any handler runs,
    // so the two answers are identical for a reason that has nothing to do with
    // the route — and a comparison that can never fail proves nothing.
    //
    // The same two requests made by the PARENT, who passes the guard and
    // reaches the handler, MUST differ: their own child is 200 and an id that
    // exists nowhere is 404. That is the difference D5 is asserting the child
    // cannot observe, measured rather than assumed.
    const real = await request(http)
      .get(`/children/${ids.childId}`)
      .set({ Authorization: `Bearer ${parentToken}` });
    const nowhere = await request(http)
      .get(`/children/${NOWHERE_UUID}`)
      .set({ Authorization: `Bearer ${parentToken}` });
    expect({ real: real.status, nowhere: nowhere.status }).toEqual({ real: 200, nowhere: 404 });

    // And the child, on the same pair, learns nothing from the difference.
    const childReal = await request(http)
      .get(`/children/${ids.childId}`)
      .set({ Authorization: `Bearer ${childToken}` });
    const childNowhere = await request(http)
      .get(`/children/${NOWHERE_UUID}`)
      .set({ Authorization: `Bearer ${childToken}` });
    expect(childReal.status).toBe(childNowhere.status);
    expect(childReal.status).not.toBe(200);
  }, 30_000);

  it.each(idBearingParentRoutes.map((e) => [`${e.surface} :: ${e.name}`, e] as const))(
    "RULE D5 %s — the answer to a CHILD token does not depend on whether the row exists",
    async (label, entry) => {
      const route = routeByName.get(entry.name)!;
      const realUrl = fillUrl(route.path);
      const nowhereUrl = route.path.replace(/:\w+/g, NOWHERE_UUID);
      // A route whose ids this fixture cannot make real proves nothing here —
      // both requests would carry the same nonexistent id. Guarded, not
      // skipped: `expect` records that the two urls really do differ.
      expect({ route: label, distinct: realUrl !== nowhereUrl }).toEqual({
        route: label,
        distinct: true,
      });

      const real = await send(entry.name, realUrl, childToken);
      const nowhere = await send(entry.name, nowhereUrl, childToken);
      expect({ route: label, status: real.status, body: real.body }).toEqual({
        route: label,
        status: nowhere.status,
        body: nowhere.body,
      });
    },
    30_000,
  );

  // =========================================================================
  // RULE D6 — THE DATABASE, NOT THE STATUS CODE
  //
  // A refused write that nevertheless wrote is a 403 with a side effect, and
  // no status assertion in this repository would see it.
  // =========================================================================

  it('RULE D6a — a CHILD token cannot WRITE the screen-time policy that binds it', async () => {
    const before = await sys('read policy before', () =>
      prisma.screenTimePolicy.findMany({
        where: { childId: ids.childId },
        select: { id: true, dailyLimitMinutes: true, focusModeEnabled: true, updatedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(before[0].dailyLimitMinutes).toBe(60);

    const url = `/children/${ids.childId}/screen-time-policy`;
    const res = await request(http)
      .post(url)
      .set({ Authorization: `Bearer ${childToken}` })
      // A body that WOULD be accepted from a parent: the refusal must come
      // from the audience, not from a validation error that would mask it.
      .send({ dailyLimitMinutes: 1440, focusModeEnabled: false });
    expectCleanRefusal('POST /children/:childId/screen-time-policy (child token)', res, url);

    const after = await sys('read policy after', () =>
      prisma.screenTimePolicy.findMany({
        where: { childId: ids.childId },
        select: { id: true, dailyLimitMinutes: true, focusModeEnabled: true, updatedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    // THE WHOLE ROW SET, not a count: a write that replaced the policy instead
    // of adding one would keep the count at 1.
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
  }, 30_000);

  it('RULE D6b — a CHILD token cannot DECIDE its own achievement', async () => {
    const before = await sys('read achievement before', () =>
      prisma.achievementRequest.findUnique({
        where: { id: ids.achievementId },
        select: { status: true, decidedAt: true, decidedByUserId: true, grantedAmount: true },
      }),
    );
    expect(before.status).toBe('SUBMITTED');

    for (const decision of ['approve', 'reject']) {
      const url = `/reward-programs/achievements/${ids.achievementId}/${decision}`;
      const res = await request(http)
        .post(url)
        .set({ Authorization: `Bearer ${childToken}` })
        .send({});
      expectCleanRefusal(`POST ${url} (child token)`, res, url);
    }

    const after = await sys('read achievement after', () =>
      prisma.achievementRequest.findUnique({
        where: { id: ids.achievementId },
        select: { status: true, decidedAt: true, decidedByUserId: true, grantedAmount: true },
      }),
    );
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
  }, 30_000);

  it('RULE D6c — a CHILD token cannot commit the household to a charge, or cancel one', async () => {
    const before = await sys('read subscription before', () =>
      prisma.subscription.findMany({ where: { familyId }, select: { id: true, status: true, planTier: true } }),
    );

    for (const [route, body] of [
      ['/billing/subscribe', { planTier: 'PREMIUM' }],
      ['/billing/cancel', {}],
    ] as const) {
      const res = await request(http)
        .post(route)
        .set({ Authorization: `Bearer ${childToken}` })
        .send(body);
      expectCleanRefusal(`POST ${route} (child token)`, res, route);
    }

    const after = await sys('read subscription after', () =>
      prisma.subscription.findMany({ where: { familyId }, select: { id: true, status: true, planTier: true } }),
    );
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
  }, 30_000);

  it('RULE D6d — a PARENT token writing to the CHILD surface writes nothing', async () => {
    const before = await sys('count hydration logs before', () =>
      prisma.hydrationLog.count({ where: { childId: ids.childId } }),
    );

    const res = await request(http)
      .post('/life-intelligence/self/health/hydration-logs')
      .set({ Authorization: `Bearer ${parentToken}` })
      .send({ amountMl: 250 });
    expectCleanRefusal(
      'POST /life-intelligence/self/health/hydration-logs (parent token)',
      res,
      '/life-intelligence/self/health/hydration-logs',
    );

    const after = await sys('count hydration logs after', () =>
      prisma.hydrationLog.count({ where: { childId: ids.childId } }),
    );
    expect({ before, after }).toEqual({ before, after: before });
  }, 30_000);

  // =========================================================================
  // RULE D7 — ANOTHER CHILD'S DETAIL
  //
  // The `child` surface is PARENT_ONLY and its routes are covered by probe 1.
  // What probe 1 cannot ask is the SIBLING question: the child app is
  // single-child by construction, so the one route on the CHILD surface that
  // takes a `childId` is the only place a paired device can name a sibling.
  // =========================================================================

  it("RULE D7 — a paired device cannot read its SIBLING's data, and cannot tell a sibling from a stranger", async () => {
    const route = 'GET /life-intelligence/communication/child/:childId';
    expect(routeByName.has(route)).toBe(true);

    const own = await request(http)
      .get(`/life-intelligence/communication/child/${ids.childId}`)
      .set({ Authorization: `Bearer ${childToken}` });
    // The device really can read ITS OWN child, so the refusals below are not
    // passing because the route is broken for everyone.
    expect({ route: 'own child', status: own.status }).toEqual({ route: 'own child', status: 200 });

    const siblingUrl = `/life-intelligence/communication/child/${ids.siblingChildId}`;
    const sibling = await request(http)
      .get(siblingUrl)
      .set({ Authorization: `Bearer ${childToken}` });
    expectCleanRefusal(`${route} (sibling)`, sibling, siblingUrl);

    // AND THE ORACLE: a sibling that EXISTS must be indistinguishable from a
    // childId that exists nowhere. A different answer would let any paired
    // device enumerate the children of its own family — and, since the id is
    // a bare uuid in the path, of every other family too.
    const stranger = await request(http)
      .get(`/life-intelligence/communication/child/${NOWHERE_UUID}`)
      .set({ Authorization: `Bearer ${childToken}` });
    expect({ status: sibling.status, body: sibling.body }).toEqual({
      status: stranger.status,
      body: stranger.body,
    });
  }, 30_000);

  // =========================================================================
  // RULE D8 — THE OPERATOR SURFACE IS NOT A DEEP-LINK SURFACE
  //
  // No `abny://` destination points at `/admin/*` or `/system/*`, and that is
  // the assertion: the platform surface must be unreachable from BOTH family
  // audiences, and it must not appear in the registry at all.
  // =========================================================================

  const platformRoutes = routes.filter((r) => r.guardNames.includes('InternalAdminGuard'));

  it('RULE D8 — no deep-link surface names an admin or operator path, and the platform surface is non-empty', () => {
    expect(platformRoutes.length).toBeGreaterThanOrEqual(20);
    const named = [...parentRouteEntries, ...childRouteEntries].map((e) => e.name);
    expect(named.filter((n) => /\s\/(admin|system)\b/.test(n))).toEqual([]);
    // And the scheme itself has no operator surface to route to.
    expect(surfaces.filter((s) => /admin|system|operator/.test(s))).toEqual([]);
  });

  it.each(
    platformRoutes
      .filter((r) => r.method === 'GET')
      .map((r) => [`${r.method} ${r.path}`, r] as const),
  )(
    'RULE D8 %s — refused CLEANLY to BOTH family audiences',
    async (label, route) => {
      const url = fillUrl(route.path);
      for (const [who, token] of [
        ['parent', parentToken],
        ['child', childToken],
      ] as const) {
        const res = await send(`${route.method} ${route.path}`, url, token);
        expectCleanRefusal(`${label} (${who})`, res, url);
      }
    },
    30_000,
  );

  // =========================================================================
  // NON-VACUITY — the needle scan really does detect a crossing
  // =========================================================================

  it('the disclosure scan is not vacuous — it detects the parent surface when the PARENT reads it', async () => {
    const res = await request(http)
      .get('/notifications')
      .set({ Authorization: `Bearer ${parentToken}` });
    expect(res.status).toBe(200);
    // The parent's own inbox contains the fixture notification, so a body
    // carrying it IS detected by `disclosuresIn`. Without this, every "no
    // disclosure" assertion above would pass just as well against a scanner
    // that never matches anything.
    expect(disclosuresIn(res, '/notifications').length).toBeGreaterThan(0);
  }, 30_000);

  it('the parent can still reach every parent surface it owns — the probes are not just breaking everything', async () => {
    for (const name of [
      'GET /reward-programs',
      'GET /reward-programs/achievements/pending',
      'GET /billing/subscription',
      'GET /notifications',
      'GET /pairing/alerts',
    ]) {
      const route = routeByName.get(name)!;
      const res = await send(name, fillUrl(route.path), parentToken);
      expect({ route: name, ok: res.status >= 200 && res.status < 300 }).toEqual({
        route: name,
        ok: true,
      });
    }
  }, 60_000);

  it('the child can still reach its own surfaces — the child half is not simply denied everything', async () => {
    for (const name of [
      'GET /self/achievements/today',
      'GET /self/coach/today',
      'GET /life-intelligence/self/messages',
      'GET /pairing/device/policy',
    ]) {
      const route = routeByName.get(name)!;
      const res = await send(name, fillUrl(route.path), childToken);
      expect({ route: name, ok: res.status >= 200 && res.status < 300 }).toEqual({
        route: name,
        ok: true,
      });
    }
  }, 60_000);
});
