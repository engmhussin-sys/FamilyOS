/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE GOLDEN WORLD — the shared stage the eight golden scenarios act on.
 * ============================================================================
 *
 * WHAT THIS FILE IS. Every golden scenario needs the same three sentences of
 * setup before its story can start: boot the REAL application, register a REAL
 * household over REAL HTTP, and give the child a REAL paired device. This file
 * says those three sentences once so that each scenario file is nothing but its
 * narrative.
 *
 * WHAT THIS FILE IS NOT. It is NOT a second harness. Everything here delegates:
 *
 *   the Prisma client      -> `test/tenancy/prisma-test-client.ts`
 *   the HTTP contract      -> `src/common/http/global-pipeline.ts`, the SAME
 *                             function `main.ts` calls, so the prefix, the
 *                             ValidationPipe, the GlobalExceptionFilter and the
 *                             error JSON are the deployed ones (PA-B-022)
 *   the app graph          -> `src/app.module.ts`, unmodified
 *   the tokens             -> the real `TokenService`
 *   the events             -> the real `OutboxRelay`
 *
 * Nothing in the request path is stubbed anywhere in this suite. Where a
 * scenario must substitute something (only E2E-07 does, and only Apple's HTTP
 * responses and Apple's key material), it says so at the substitution site and
 * the report names it.
 *
 * ON `rawBody`. `createNestApplication({ rawBody: true })` mirrors `main.ts`,
 * because `POST /webhooks/payments/:provider` verifies a provider signature
 * over the EXACT BYTES. A test app without it would 400 on every webhook for a
 * reason that has nothing to do with the product.
 *
 * ON THE THROTTLE RESET. `/auth/register` allows 5 per minute per IP and the
 * counters live in the REAL Redis, shared by every suite in a `--runInBand`
 * run. Eight more suites registering households would otherwise fail on a
 * fixture with a 429 that looks like a product defect and is not — the same
 * reason, and the same three lines, as `reward-engine.e2e.spec.ts`.
 */
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { OutboxRelay } from '../../src/modules/events/application/outbox.relay';
import { createTestPrismaService, integrationDatabaseUrl } from '../tenancy/prisma-test-client';

/** The prefix a deployed client actually talks to. */
export const P = '/api/v1';

/** Every golden scenario is skipped, loudly and by name, without a database. */
export const describeGolden = integrationDatabaseUrl() ? describe : describe.skip;

export interface GoldenHousehold {
  readonly label: string;
  familyId: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerPassword: string;
  /** The OWNER parent's access token. */
  parentToken: string;
  childId: string;
  childName: string;
  childDateOfBirth: string;
  deviceId: string;
  /** The CHILD's device-bound token — a different Passport strategy. */
  deviceToken: string;
}

export interface GoldenWorld {
  readonly app: INestApplication;
  readonly http: any;
  readonly prisma: any;
  readonly relay: OutboxRelay;
  readonly tokens: TokenService;
  /**
   * Runs a fixture read/write outside any tenant, with a recorded reason.
   *
   * `Promise<any>` rather than a generic, and stated rather than apologised
   * for: the Prisma client this suite drives is the WASM one, obtained through
   * `require` because its native engine cannot be downloaded here (F1's 403),
   * so every model accessor is already `any` and a generic would infer
   * `unknown` and be worse than useless at the call site. Same shape as the
   * five existing e2e suites' own `sys`.
   */
  sys(what: string, fn: () => Promise<any>): Promise<any>;
  /** Raw SQL, for the assertions that must read the row and not the object. */
  raw<T>(sql: string, ...params: unknown[]): Promise<T>;
  /** Turns the outbox until it is empty; returns what it published. */
  drainOutbox(maxPasses?: number): Promise<{ published: number; failed: number }>;
  /** A full household: parent over HTTP, child over HTTP, device token. */
  register(label: string, options?: RegisterOptions): Promise<GoldenHousehold>;
  close(): Promise<void>;
}

export interface RegisterOptions {
  /** Defaults to a 12-year-old, the age band the product's copy is written for. */
  readonly childDateOfBirth?: string;
  readonly childName?: string;
  readonly familyTimeZone?: string;
}

export async function clearThrottleCounters(): Promise<void> {
  const Redis = require('ioredis');
  const client = new Redis(process.env.REDIS_URL as string);
  const keys = await client.keys('throttle:*');
  if (keys.length > 0) await client.del(...keys);
  await client.quit();
}

/**
 * Boots the application exactly as `main.ts` does, minus the transport-only
 * middleware (helmet/compression/CORS) that shapes no JSON.
 *
 * `configure` is the ONE seam a scenario may use to substitute a provider. It
 * receives the real builder, so a scenario's substitution is visible in the
 * scenario file rather than hidden here.
 */
export async function bootGoldenWorld(
  suiteName: string,
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<GoldenWorld> {
  await clearThrottleCounters();

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(createTestPrismaService());
  if (configure) builder = configure(builder);

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  applyGlobalHttpPipeline(app);
  await app.init();

  const http = app.getHttpServer();
  const prisma: any = app.get(PrismaService);
  const relay = app.get(OutboxRelay);
  const tokens = app.get(TokenService);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  /**
   * `async () => await fn()` and NOT `fn`, and the difference is load-bearing.
   *
   * `runAsSystem` establishes the context for the SYNCHRONOUS execution of its
   * callback. A Prisma model call returns a lazy `PrismaPromise` — the query is
   * dispatched by `.then()`, not by the call — so handing `fn` straight through
   * would return an unexecuted promise, the context would unwind, and the query
   * would run outside it and be denied by the tenant extension. Awaiting INSIDE
   * keeps the dispatch inside the scope. Same three characters, same reason, as
   * the five existing e2e suites.
   */
  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `${suiteName}: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys(`raw sql`, async () => await prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  async function drainOutbox(maxPasses = 12): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;
    for (let pass = 0; pass < maxPasses; pass++) {
      const tick = await relay.tick();
      published += tick.published;
      failed += tick.failed;
      if (tick.claimed === 0) break;
    }
    return { published, failed };
  }

  async function register(label: string, options: RegisterOptions = {}): Promise<GoldenHousehold> {
    const email = `golden.${label}.${stamp}@example.com`.toLowerCase();
    const password = 'Golden-Passw0rd!23';
    const childName = options.childName ?? 'محمد';
    const childDateOfBirth = options.childDateOfBirth ?? '2013-04-01';

    // 1. THE PARENT. `/auth/register` creates the User, the Family and the
    //    OWNER membership in one call — there is no tenant before it returns.
    const registered = await request(http).post(`${P}/auth/register`).send({
      email,
      password,
      fullName: `Golden Parent ${label}`,
      familyName: `Golden Family ${label}`,
      acceptedTerms: true,
    });
    if (![200, 201].includes(registered.status)) {
      throw new Error(`register(${label}) -> ${registered.status} ${JSON.stringify(registered.body)}`);
    }

    const loggedIn = await request(http).post(`${P}/auth/login`).send({ email, password });
    const parentToken: string = loggedIn.body.tokens?.accessToken ?? loggedIn.body.accessToken;
    if (!parentToken) throw new Error(`login(${label}) -> ${JSON.stringify(loggedIn.body)}`);
    const claims = JSON.parse(Buffer.from(parentToken.split('.')[1], 'base64').toString());

    const household: GoldenHousehold = {
      label,
      familyId: claims.familyId,
      ownerUserId: claims.sub,
      ownerEmail: email,
      ownerPassword: password,
      parentToken,
      childId: '',
      childName,
      childDateOfBirth,
      deviceId: '',
      deviceToken: '',
    };

    if (options.familyTimeZone) {
      await sys('set the family timezone', () =>
        prisma.family.update({
          where: { id: household.familyId },
          data: { timezone: options.familyTimeZone },
        }),
      );
    }

    // 2. THE CHILD, over HTTP, because a parent adding a child is J2 and the
    //    entitlement gate on the SECOND child is part of the product.
    const child = await request(http)
      .post(`${P}/children`)
      .set(asParent(household))
      .send({ firstName: childName, dateOfBirth: childDateOfBirth });
    if (child.status !== 201) {
      throw new Error(`createChild(${label}) -> ${child.status} ${JSON.stringify(child.body)}`);
    }
    household.childId = child.body.id;

    // 3. THE DEVICE. Seeded directly and stated plainly: the real pairing flow
    //    (`/pairing/*`) needs a second physical actor to redeem a code, which no
    //    single-process test can be. The row written here is byte-identical to
    //    the one `PairingOrchestratorService` writes, and the TOKEN is minted by
    //    the REAL `TokenService` — so every guard the child hits downstream is
    //    the real one, reading a real device-bound claim set.
    const device = await sys('seed the paired device', () =>
      prisma.device.create({
        data: {
          familyId: household.familyId,
          ownerType: 'CHILD',
          childId: household.childId,
          platform: 'ANDROID',
          status: 'ACTIVE',
          pairedAt: new Date(),
        },
        select: { id: true },
      }),
    );
    household.deviceId = device.id;
    const pair = await runWithTenant(
      { familyId: household.familyId, actorType: 'DEVICE', actorId: device.id },
      () =>
        tokens.issueTokenPair({
          subjectId: device.id,
          actorType: 'DEVICE',
          familyId: household.familyId,
        }),
    );
    household.deviceToken = pair.accessToken;

    return household;
  }

  return {
    app,
    http,
    prisma,
    relay,
    tokens,
    sys,
    raw,
    drainOutbox,
    register,
    close: async () => {
      await app.close();
    },
  };
}

/**
 * ============================================================================
 * THE CLOCK
 * ============================================================================
 *
 * WHY A GOLDEN SCENARIO OWNS `Date`. Two product rules are functions of the
 * wall clock, and both of them change what a scenario observes:
 *
 *   QUIET HOURS (21:00–07:00 family-local). A reward granted at 03:00 is
 *   DEFERRED, not delivered — correctly. A suite that ran on the real clock
 *   would assert "one parent notification" and be green in the afternoon and
 *   red at night, which is worse than either answer.
 *
 *   THE FAMILY BUSINESS DAY. `maxPerDay`, streaks and the growth cohort are all
 *   counted on the family's calendar day.
 *
 * ONLY `Date` IS FAKED. Every timer stays real, because the PostgreSQL driver,
 * Redis and supertest all need working timers — the same `doNotFake` list, for
 * the same reason, as `reward-engine.e2e.spec.ts`.
 *
 * AND THE FAKE DAY IS ONE DAY BEHIND THE REAL ONE. Prisma generates
 * `@default(now())` CLIENT-side (so a row written under the fake clock carries
 * the fake instant) while the outbox relay's own SQL uses PostgreSQL's REAL
 * `now()`. A fake day in the future would leave every message with
 * `next_attempt_at` in the future and nothing would ever be relayed.
 */
export const GOLDEN_DAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
export const goldenAt = (hhmm: string): Date => new Date(`${GOLDEN_DAY}T${hhmm}:00.000Z`);
/** Midday: comfortably outside quiet hours in both launch markets. */
export const GOLDEN_NOON = goldenAt('12:00');

export function freezeGoldenClock(at: Date = GOLDEN_NOON): void {
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  jest.setSystemTime(at);
}

/**
 * Makes a freshly registered household look like a family that has been using
 * the product for a few hours rather than a few milliseconds.
 *
 * THIS IS NOT COSMETIC. `evaluateActivation` GATE 3 rejects a completion that
 * happens within `minMinutesAfterChildCreated` (60) of the child row being
 * created, because "a parent who adds a child and ticks a goal in the same
 * minute is showing the app to somebody". A test household is exactly that
 * shape, so without this the activation metric would never move and a scenario
 * asserting that it does would be asserting a bug into existence.
 */
export async function ageTheHousehold(
  world: GoldenWorld,
  h: GoldenHousehold,
  createdAt: Date,
): Promise<void> {
  await world.sys('back-date the household so it is not a demo', async () => {
    await world.prisma.family.update({ where: { id: h.familyId }, data: { createdAt } });
    await world.prisma.child.update({ where: { id: h.childId }, data: { createdAt } });
  });
}

export const asParent = (h: GoldenHousehold) => ({ Authorization: `Bearer ${h.parentToken}` });
export const asChild = (h: GoldenHousehold) => ({ Authorization: `Bearer ${h.deviceToken}` });
export const asBearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * THE FOUR NUMBERS EVERY REWARD SCENARIO ASSERTS, read from the four tables
 * that CONTEXT §5's chain ends in.
 *
 * They are counted together, in one helper, on purpose: the invariant is not
 * "one ledger row" — it is "one ledger row AND one timeline entry AND one
 * parent notification AND one child message", and a scenario that checked them
 * in four separate places would let three of them drift.
 */
export interface LoopCounts {
  readonly ledger: number;
  readonly timeline: number;
  readonly parentNotifications: number;
  readonly childMessages: number;
}

export async function countTheLoop(world: GoldenWorld, h: GoldenHousehold): Promise<LoopCounts> {
  return world.sys('count the loop', async () => {
    const [ledger, timeline, parentNotifications, childMessages] = await Promise.all([
      world.prisma.rewardsLedgerEntry.count({
        where: { familyId: h.familyId, childId: h.childId, type: 'EARN' },
      }),
      world.prisma.lifeTimelineEvent.count({
        where: { familyId: h.familyId, childId: h.childId, eventType: 'reward_granted' },
      }),
      world.prisma.notification.count({
        where: { familyId: h.familyId, childId: h.childId, type: 'REWARD_GRANTED' },
      }),
      world.prisma.childMessage.count({ where: { familyId: h.familyId, childId: h.childId } }),
    ]);
    return { ledger, timeline, parentNotifications, childMessages };
  });
}

/** Wipes everything a completed loop wrote, so a scenario can tell a second story. */
export async function resetLoop(world: GoldenWorld, h: GoldenHousehold): Promise<void> {
  await world.sys('reset the loop', async () => {
    const where = { where: { familyId: h.familyId } };
    await world.prisma.notification.deleteMany(where);
    await world.prisma.childMessage.deleteMany(where);
    await world.prisma.lifeTimelineEvent.deleteMany(where);
    await world.prisma.notificationDecision.deleteMany(where);
    await world.prisma.screenTimeRewardGrant.deleteMany(where);
    await world.prisma.rewardFulfilment.deleteMany(where);
    await world.prisma.rewardsLedgerEntry.deleteMany(where);
    await world.prisma.rewardsAccount.deleteMany(where);
    await world.prisma.consumedMessage.deleteMany(where);
    await world.prisma.outboxMessage.deleteMany(where);
    await world.prisma.domainEvent.deleteMany(where);
    await world.prisma.verificationAttempt.deleteMany(where);
    await world.prisma.achievementRequest.deleteMany(where);
  });
}
