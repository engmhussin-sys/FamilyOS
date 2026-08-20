/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * THE BADGE THE CHILD WAS NEVER TOLD ABOUT — AND THE INVARIANT THAT SAYS THE
 * PARENT MUST NOT KNOW SOMETHING THE CHILD DOES NOT.
 * ============================================================================
 *
 * WHAT WAS MEASURED BEFORE THE FIX, read out of `notification_decisions`
 * against a real PostgreSQL. One twelve-year-old, one afternoon, the shipped
 * `maxPerHour = 3`. A hydration crossing at 12:00 spent the child's whole hour:
 *
 *   BADGE_EARNED          aud=CHILD  SEND     score=42  fatigue  0      today=0/6 hour=0/3
 *   REWARD_GRANTED_CHILD  aud=CHILD  SEND     score=30  fatigue −8.33   today=1/6 hour=1/3
 *   DAILY_GOAL_COMPLETED  aud=CHILD  SEND     score=26  fatigue −16.67  today=2/6 hour=2/3
 *
 * and an activity crossing five minutes later arrived into a full one:
 *
 *   BADGE_EARNED          aud=CHILD  SUPPRESS SCORE_BELOW_FLOOR   score=17
 *                                    fatigue −25     today=3/6 hour=3/3 category=1/2
 *   BADGE_EARNED_PARENT   aud=PARENT SEND     SCORE_IN_DEFER_BAND score=25
 *                                    fatigue −16.67  today=2/6 hour=2/3 category=1/2
 *
 * SAME `source_event_id`. SAME badge. `first_activity_goal` — a row of
 * `badge_definitions` this child can earn exactly once in their life, because
 * `child_badge_awards (child_id, badge_id)` is UNIQUE — was decided SUPPRESS
 * for the child and SEND for the parent, and the only difference between the
 * two rows was that the CHILD's own inbox had been the busier one that hour.
 *
 * A DAILY RECEIPT LOSING TO VOLUME IS RIGHT AND STAYS RIGHT. `DAILY_GOAL_COMPLETED`
 * and `REWARD_GRANTED_CHILD` arriving into that same full hour are still
 * suppressed, in the SAME RUN, and §2 is the control that proves the exemption
 * is narrow rather than a loosened cap.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE EXECUTES. The real chain with no test double in it: the real
 * `HealthEngineService` over real `hydration_logs` / `activity_logs`, the real
 * platform Reward Rules and badge catalogue from the migrations, the real
 * `RewardsEngineService`, the real `SmartNotificationEngineService`, the real
 * decision provider and the real delivery pipeline. EVERY COUNT IS READ BACK
 * OUT OF POSTGRESQL WITH SQL, never from a returned object.
 *
 *   §0  THE PREMISE. The clock is frozen; the exemption table's every entry
 *       names a UNIQUE constraint and a lifetime ceiling; the types that were
 *       CONSIDERED AND REFUSED are still absent.
 *   §1  THE REPRODUCTION. The hour is filled, the once-ever badge follows, and
 *       the CHILD IS TOLD — asserted from `child_messages`, with the persisted
 *       `FATIGUE_PENALTY` note showing the hour really was full.
 *   §2  THE CONTROL. A repeatable type in the identical position is STILL
 *       suppressed, with a real non-zero fatigue penalty.
 *   §3  THE ASYMMETRY INVARIANT, over the persisted rows, plus a NEGATIVE
 *       CONTROL built from the exact pre-fix rows quoted above — because an
 *       invariant that has never been seen to fail is not known to work.
 *   §4  QUIET HOURS. Still DEFERRED, never suppressed and never promoted to a
 *       2 a.m. alarm, asserted at a frozen quiet instant and at midday.
 *   §5  REPLAY, BY REPLAYING.
 *
 * SCOPED TO ITS OWN COHORT. Every assertion is `WHERE family_id = <a family
 * this file created>`.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { HealthEngineService } from '../../src/modules/life-intelligence/application/services/health-engine.service';
import { RewardsEngineService } from '../../src/modules/life-intelligence/application/services/rewards-engine.service';
import {
  ONCE_EVER_TYPES,
  ONCE_EVER_COOLDOWN_EXEMPTIONS,
  COOLDOWN_EXEMPT_TYPES,
  DEFAULT_NOTIFICATION_POLICY,
  isOnceEverType,
} from '../../src/modules/notifications/domain/engine/notification-policy';
import {
  ACHIEVEMENT_BASELINE_BY_TYPE,
} from '../../src/modules/notifications/domain/engine/notification-scoring';
import {
  audienceOutcomeOf,
  findAudienceAsymmetries,
  type AudienceDecisionRow,
} from '../../src/modules/notifications/domain/engine/notification-audience-symmetry';
import { hasEnumOrPlaceholderLeak } from '../../src/modules/notifications/domain/engine/notification-copy';
import { quietHoursClassOf } from '../../src/shared/notifications/notification-class';
import { PLATFORM_BADGES, findPlatformBadge } from '../../src/shared/rewards/badge-catalogue';
import { composeIdempotencyKey } from '../../src/shared/events/idempotency';
import { getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { freezeGoldenClock } from '../golden/golden-world';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
/** 12:00 Cairo, in the PAST relative to any real run — the same frozen midday
 * its sibling suites use, for the reason their headers give: the notification
 * door reads `new Date()`, so a suite that leaves the wall clock alone asserts
 * what time CI happened to run. */
const NOON = new Date('2026-01-15T10:00:00.000Z');
/** 22:30 Cairo on the same day — inside the 21:00–07:00 window. */
const QUIET_NIGHT = new Date('2026-01-15T20:30:00.000Z');
const BUSINESS_DAY = '2026-01-15';
const QUIET_HOURS_START = '21:00';
const QUIET_HOURS_END = '07:00';

/** A twelve-year-old's hydration target is 2100 ml (the `9-13` band); 2200
 * crosses it in ONE log, so «the crossing» is a single unambiguous event. The
 * activity target is 60 minutes; 70 crosses it the same way. */
const CROSSING_ML = 2200;
const CROSSING_MINUTES = 70;

const ARABIC_LETTERS = /[؀-ۿ]/;
const PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/;

const HYDRATION_BADGE = findPlatformBadge('first_hydration_goal');
const ACTIVITY_BADGE = findPlatformBadge('first_activity_goal');

/** The same offline client every other integration suite in this repo builds. */
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

interface Household {
  readonly familyId: string;
  readonly childId: string;
  readonly userId: string;
}

describeIfDb('ONCE-EVER — a badge must not lose to arrival order (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let health: HealthEngineService;
  let rewards: RewardsEngineService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `once-ever badge suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  // -- READ-BACK HELPERS: SQL against the real database, every one of them ----

  const decisions = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const childMessages = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const parentNotifications = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const badgeAwards = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT a."id", a."badge_id", b."key" FROM "child_badge_awards" a
         JOIN "badge_definitions" b ON b."id" = a."badge_id"
        WHERE a."family_id" = $1::uuid ORDER BY b."key"`,
      familyId,
    );

  /** The persisted decision rows, in the shape the pure invariant takes. The
   * mapping is columns-to-fields and nothing else — no derivation happens here,
   * so what the invariant sees is what PostgreSQL holds. */
  const symmetryRows = async (familyId: string): Promise<AudienceDecisionRow[]> =>
    (await decisions(familyId)).map((d) => ({
      sourceEventId: String(d.source_event_id),
      targetAudience: d.target_audience as 'PARENT' | 'CHILD',
      eventType: String(d.event_type),
      decision: d.decision as 'SEND' | 'DEFER' | 'SUPPRESS',
      reason: d.reason === null ? null : String(d.reason),
      outcome: d.outcome === null ? null : (d.outcome as 'SEND' | 'DEFER' | 'SUPPRESS'),
      outcomeReason: d.outcome_reason === null ? null : String(d.outcome_reason),
    }));

  /** One named component out of a decision's own persisted arithmetic. */
  const componentOf = (decision: any, name: string): any => {
    const found = (decision.explanation as any[]).find((c) => c.name === name);
    expect(`${name} present:${found !== undefined}`).toBe(`${name} present:true`);
    return found;
  };

  /** The single decision row for one event type and one badge cause. */
  const badgeDecision = async (familyId: string, eventType: string, badgeId: string): Promise<any> => {
    const rows = (await decisions(familyId)).filter(
      (d) => d.event_type === eventType && String(d.source_event_id).endsWith(badgeId),
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  // -- fixtures --------------------------------------------------------------

  async function createHousehold(label: string): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({
        data: { name: `once-ever ${label} ${stamp}`, timezone: CAIRO },
        select: { id: true },
      }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `onceever.${label}.${stamp}@example.test`, passwordHash: 'x', fullName: 'Once Parent' },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    // Born June 2013 — twelve on every instant in this file, so the hydration
    // target is 2100 and the tone band `11-13`.
    const child = await sys('create child', () =>
      prisma.child.create({
        data: { familyId: family.id, firstName: 'محمد', dateOfBirth: new Date('2013-06-01T00:00:00.000Z') },
        select: { id: true },
      }),
    );

    return { familyId: family.id, childId: child.id, userId: user.id };
  }

  const asFamily = <T>(familyId: string, fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'once-ever-test' }, fn);

  /** The REAL engine method a child's own device calls. No instant argument
   * exists — it stands at the moment the child logged a glass of water and
   * reads the wall clock, which is why this file freezes it. */
  const logHydration = (h: Household) =>
    asFamily(h.familyId, () => health.logHydration(h.childId, h.familyId, { amountMl: CROSSING_ML } as any));

  const logActivity = (h: Household) =>
    asFamily(h.familyId, () =>
      health.logActivity(h.childId, h.familyId, {
        date: BUSINESS_DAY,
        activityType: 'running',
        durationMinutes: CROSSING_MINUTES,
        socialContext: 'SOLO',
      } as any),
    );

  /**
   * THE SCENARIO, ONCE. A hydration crossing that spends the hour, then five
   * minutes later an activity crossing carrying the child's second first-ever
   * badge. Five minutes is deliberate: it is INSIDE the rolling hour the cap
   * counts over and inside `defaultCooldownMinutes` (30), so both the ranking
   * term and the delivery gate are genuinely under test.
   */
  async function theTwoCrossings(h: Household, at: Date): Promise<void> {
    jest.setSystemTime(at);
    await logHydration(h);
    jest.setSystemTime(new Date(at.getTime() + 5 * 60_000));
    await logActivity(h);
  }

  beforeAll(async () => {
    // BEFORE THE APP IS BUILT, so every client-side `@default(now())` this suite
    // writes carries the instant the notification door will read.
    freezeGoldenClock(NOON);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    health = app.get(HealthEngineService);
    rewards = app.get(RewardsEngineService);
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(() => undefined);
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(() => undefined);
      }
    }
    await app?.close();
    jest.useRealTimers();
  }, 180_000);

  // ==========================================================================
  // 0. THE PREMISE THIS SUITE IS WRITTEN ON
  // ==========================================================================
  describe('0. the premise, asserted rather than assumed', () => {
    it('THE CLOCK IS FROZEN AT MIDDAY, outside quiet hours', () => {
      expect(new Date().toISOString()).toBe(NOON.toISOString());
      const local = getBusinessTimeHHMM(new Date(), CAIRO);
      expect(local).toBe('12:00');
      expect(local > QUIET_HOURS_END && local < QUIET_HOURS_START).toBe(true);
    });

    it('THE CAPS ARE THE SHIPPED ONES — this is not a suite that loosened them to pass', () => {
      // The fix must hold at `maxPerHour = 3`. Raising it was the explicitly
      // rejected alternative, and this line is what would notice if it were
      // raised later and this suite silently stopped testing anything.
      expect(DEFAULT_NOTIFICATION_POLICY.maxPerHour).toBe(3);
      expect(DEFAULT_NOTIFICATION_POLICY.maxPerDay).toBe(6);
      expect(DEFAULT_NOTIFICATION_POLICY.categoryMaxPerDay).toBe(2);
      expect(DEFAULT_NOTIFICATION_POLICY.defaultCooldownMinutes).toBe(30);
      expect(DEFAULT_NOTIFICATION_POLICY.scoring.thresholdLow).toBe(25);
      expect(DEFAULT_NOTIFICATION_POLICY.scoring.penaltyFatigue).toBe(25);
    });

    it('EVERY ENTRY IN THE EXEMPTION TABLE NAMES A UNIQUE CONSTRAINT AND A LIFETIME CEILING', () => {
      const entries = Object.entries(ONCE_EVER_TYPES);
      expect(entries.length).toBeGreaterThan(0);

      for (const [type, guarantee] of entries) {
        // A REASON PER ENTRY, and it has to be a real one. This is the property
        // that keeps the table from growing by copy-paste.
        expect(guarantee.reason.length).toBeGreaterThan(80);
        // AND THE REASON HAS TO BE THIS TYPE'S OWN, not the previous row's.
        const others = entries.filter(([t]) => t !== type).map(([, g]) => g.reason);
        expect(others).not.toContain(guarantee.reason);
        // The guarantee is a DATABASE FACT — the constraint is named, and it is
        // named as a UNIQUE one.
        expect(guarantee.enforcedBy).toContain('UNIQUE');
        expect(guarantee.enforcedBy).toContain('child_badge_awards');
      }
    });

    it('THE LIFETIME CEILING IS THE CATALOGUE, so the exemption is bounded by the same constraint that earned it', () => {
      // `child_badge_awards (child_id, badge_id)` UNIQUE × the number of rows in
      // `badge_definitions`. Not a number typed twice: if a badge is added to
      // the catalogue, this line moves the table rather than letting the stated
      // ceiling quietly become a lie.
      for (const guarantee of Object.values(ONCE_EVER_TYPES)) {
        expect(guarantee.lifetimeMaxPerChild).toBe(PLATFORM_BADGES.length);
      }
      // AND IT IS SMALL. Nine messages per audience in a childhood is the whole
      // anti-spam cost of this exemption.
      expect(PLATFORM_BADGES.length).toBeLessThanOrEqual(20);
      // Every badge in the catalogue is a FIRST-TIME milestone, which is what
      // makes the ceiling true — a counter badge would break the guarantee, and
      // this line is what would notice one being added.
      for (const badge of PLATFORM_BADGES) expect(badge.criteria.occurrence).toBe('FIRST');
    });

    it('THE TYPES THAT WERE CONSIDERED AND REFUSED ARE STILL ABSENT — the exemption is by name, not by worth', () => {
      // Each of these CAN recur, so none of them has the guarantee. `LEVEL_UP`
      // is the important one: it carries the SAME achievement baseline as
      // `BADGE_EARNED`, so a predicate over «high achievement value» would have
      // swallowed it — and then everything else.
      for (const type of [
        'LEVEL_UP',
        'STREAK_ACHIEVED',
        'LEARNING_GOAL_ACHIEVED',
        'DAILY_GOAL_COMPLETED',
        'ACHIEVEMENT_VERIFIED',
        'REWARD_GRANTED',
        'REWARD_GRANTED_CHILD',
      ]) {
        expect(isOnceEverType(type)).toBe(false);
      }
      expect(ACHIEVEMENT_BASELINE_BY_TYPE.LEVEL_UP).toBe(ACHIEVEMENT_BASELINE_BY_TYPE.BADGE_EARNED);
      expect(isOnceEverType('BADGE_EARNED')).toBe(true);
      expect(isOnceEverType('BADGE_EARNED_PARENT')).toBe(true);

      // AND THE TWO TABLES STAY DISTINCT. `DAILY_GOAL_COMPLETED` is cooldown-
      // exempt for a different reason (two goals in one day) and is NOT
      // once-ever; the once-ever types are cooldown-exempt as a CONSEQUENCE.
      expect(Object.keys(COOLDOWN_EXEMPT_TYPES)).toEqual(['DAILY_GOAL_COMPLETED']);
      expect(Object.keys(ONCE_EVER_COOLDOWN_EXEMPTIONS).sort()).toEqual(Object.keys(ONCE_EVER_TYPES).sort());
      for (const minutes of Object.values(ONCE_EVER_COOLDOWN_EXEMPTIONS)) expect(minutes).toBe(0);
    });

    it('THE BADGE CAUSES THIS SUITE DRIVES ARE THE CATALOGUE’S, never literals typed here', () => {
      expect(HYDRATION_BADGE?.criteria.eventType).toBe('HYDRATION_GOAL_COMPLETED');
      expect(ACTIVITY_BADGE?.criteria.eventType).toBe('ACTIVITY_GOAL_COMPLETED');
      // TWO DIFFERENT BADGES. That is the fact the whole scenario turns on: the
      // second `BADGE_EARNED` of the afternoon is not a repeat of the first.
      expect(HYDRATION_BADGE?.key).not.toBe(ACTIVITY_BADGE?.key);
      expect(HYDRATION_BADGE?.copy.ar.title).toMatch(ARABIC_LETTERS);
      expect(ACTIVITY_BADGE?.copy.ar.title).toMatch(ARABIC_LETTERS);
    });
  });

  // ==========================================================================
  // 1. THE REPRODUCTION — the hour is filled, and the child is still told
  // ==========================================================================
  describe('1. a full hour, then a once-ever badge', () => {
    let home: Household;

    beforeAll(async () => {
      home = await createHousehold('act-one');
      await theTwoCrossings(home, NOON);
    }, 180_000);

    it('THE HYDRATION CROSSING SPENT THE HOUR — three CHILD sends, the last of them at hour=2/3', async () => {
      const rows = await decisions(home.familyId);

      // The three CHILD candidates the first crossing produced. Identified by
      // their causes rather than by position: the badge's key names the badge,
      // and the reward's and the receipt's both name `hydration`.
      const hydrationChild = rows.filter(
        (d) =>
          d.target_audience === 'CHILD' &&
          (String(d.source_event_id).toLowerCase().includes('hydration') ||
            (d.event_type === 'BADGE_EARNED' && Number(d.score) === 42 && d.decision === 'SEND')),
      );
      expect(hydrationChild.length).toBeGreaterThanOrEqual(3);
      for (const row of hydrationChild.slice(0, 3)) expect(row.decision).toBe('SEND');

      // THE RECEIPT IS THE THIRD ONE, and its own persisted note says the hour
      // was at 2 of 3 when it arrived — so the hour is spent from here on. This
      // is what makes §1's «hour=3/3» a real reading rather than a hoped-for one.
      const receipt = rows.find(
        (d) =>
          d.event_type === 'DAILY_GOAL_COMPLETED' &&
          String(d.source_event_id).toUpperCase().includes('HYDRATION'),
      );
      expect(receipt).toBeDefined();
      expect(receipt.decision).toBe('SEND');
      expect(componentOf(receipt, 'FATIGUE_PENALTY').note).toContain(
        `hour=2/${DEFAULT_NOTIFICATION_POLICY.maxPerHour}`,
      );
    }, 60_000);

    it('THE CHILD IS TOLD ABOUT THE ONCE-EVER BADGE, and the persisted note shows the hour was full', async () => {
      const awards = await badgeAwards(home.familyId);
      // Two DIFFERENT badges were genuinely awarded — the premise of the whole
      // scenario, read from `child_badge_awards` rather than assumed.
      expect(awards.map((a) => a.key).sort()).toEqual(['first_activity_goal', 'first_hydration_goal']);
      const activityAward = awards.find((a) => a.key === 'first_activity_goal');

      const row = await badgeDecision(home.familyId, 'BADGE_EARNED', String(activityAward.badge_id));

      // THE VERDICT. Pre-fix this row read `SUPPRESS / SCORE_BELOW_FLOOR / 17`.
      expect(row.decision).not.toBe('SUPPRESS');
      expect(row.reason).not.toBe('SCORE_BELOW_FLOOR');
      expect(Number(row.score)).toBeGreaterThanOrEqual(DEFAULT_NOTIFICATION_POLICY.scoring.thresholdLow);

      // THE ARITHMETIC. The penalty is waived, and the note still carries the
      // three REAL counts — an explanation that hid the household's actual load
      // would stop reconciling with the row beside it.
      const fatigue = componentOf(row, 'FATIGUE_PENALTY');
      expect(fatigue.contribution).toBe(0);
      expect(fatigue.note).toContain('once-ever');
      // THE HOUR WAS FULL. This is the line that makes the test non-vacuous: the
      // child had 3 of 3 when this badge arrived, and was told anyway.
      expect(fatigue.note).toContain(`hour=3/${DEFAULT_NOTIFICATION_POLICY.maxPerHour}`);

      // AND THE EXPLANATION STILL RECONCILES TO THE STORED TOTAL.
      const sum = (row.explanation as any[]).reduce((acc, c) => acc + Number(c.contribution), 0);
      expect(Number(row.score)).toBe(Math.max(0, Math.min(100, Math.round(sum))));
    }, 60_000);

    it('AND IT REACHED THE CHILD’S OWN TABLE — two badges, two causal keys, two sentences', async () => {
      const badgeMessages = (await childMessages(home.familyId)).filter(
        (m) => String(m.category) === 'BADGE_EARNED',
      );
      expect(badgeMessages).toHaveLength(2);

      // TWO ROWS THE DATABASE WOULD KEEP APART, not one counted twice.
      const keys = badgeMessages.map((m) => String(m.source_event_id));
      expect(new Set(keys).size).toBe(2);
      for (const key of keys) expect(key.endsWith(':child')).toBe(true);

      // AND EACH NAMES ITS OWN BADGE. A second message that arrives saying the
      // wrong thing is not an improvement on one that never arrives.
      const bodies = badgeMessages.map((m) => String(m.body));
      expect(bodies.some((b) => b.includes(HYDRATION_BADGE!.copy.ar.title))).toBe(true);
      expect(bodies.some((b) => b.includes(ACTIVITY_BADGE!.copy.ar.title))).toBe(true);

      for (const body of bodies) {
        expect(body).toMatch(ARABIC_LETTERS);
        expect(body).not.toMatch(PLACEHOLDER);
        expect(hasEnumOrPlaceholderLeak(body)).toBe(false);
        // NEVER SHAMING. A once-ever celebration least of all.
        for (const word of ['فشل', 'كسول', 'مقصر', 'إهمال', 'عقاب', 'خسرت']) {
          expect(body).not.toContain(word);
        }
      }
    }, 60_000);

    // ========================================================================
    // 2. THE CONTROL — the exemption is narrow, proved in the same run
    // ========================================================================
    it('2. A REPEATABLE TYPE IN THE IDENTICAL POSITION IS STILL SUPPRESSED', async () => {
      const rows = await decisions(home.familyId);

      // The activity crossing's OTHER two child candidates arrived in the same
      // instant, into the same full hour, through the same provider.
      const repeatables = rows.filter(
        (d) =>
          d.target_audience === 'CHILD' &&
          (String(d.source_event_id).includes('activity') || String(d.source_event_id).includes('ACTIVITY')) &&
          d.event_type !== 'BADGE_EARNED',
      );
      // NOT VACUOUS: there really are controls to check.
      expect(repeatables.length).toBeGreaterThanOrEqual(2);
      expect(repeatables.map((d) => String(d.event_type)).sort()).toEqual([
        'DAILY_GOAL_COMPLETED',
        'REWARD_GRANTED_CHILD',
      ]);

      for (const row of repeatables) {
        expect(isOnceEverType(String(row.event_type))).toBe(false);
        // STILL SUPPRESSED. A daily receipt losing to volume is right, and the
        // anti-spam limit that was long inert still bites.
        expect(row.decision).toBe('SUPPRESS');
        expect(row.reason).toBe('SCORE_BELOW_FLOOR');
        // AND IT IS THE FATIGUE PENALTY THAT DID IT — a real, full, negative one.
        const fatigue = componentOf(row, 'FATIGUE_PENALTY');
        expect(fatigue.contribution).toBeLessThan(0);
        expect(fatigue.note).not.toContain('once-ever');
        expect(fatigue.raw).toBe(1);
      }

      // AND NOTHING ELSE GOT THROUGH. The child's inbox holds exactly what the
      // fix intended to add and nothing more.
      const messageTypes = (await childMessages(home.familyId)).map((m) => String(m.category)).sort();
      expect(messageTypes).toEqual([
        'BADGE_EARNED',
        'BADGE_EARNED',
        'DAILY_GOAL_COMPLETED',
        'REWARD_GRANTED_CHILD',
      ]);
    }, 60_000);

    // ========================================================================
    // 3a. THE ASYMMETRY INVARIANT over the rows this run actually wrote
    // ========================================================================
    it('3a. NO CAUSE LEFT THE CHILD IN THE DARK WHILE THE PARENT WAS TOLD', async () => {
      const rows = await symmetryRows(home.familyId);
      // NOT VACUOUS: this cohort really does contain causes that reached both
      // audiences, which is the only shape the invariant can fire on.
      const bothAudienceCauses = [...new Set(rows.map((r) => r.sourceEventId))].filter(
        (key) =>
          rows.some((r) => r.sourceEventId === key && r.targetAudience === 'CHILD') &&
          rows.some((r) => r.sourceEventId === key && r.targetAudience === 'PARENT'),
      );
      expect(bothAudienceCauses.length).toBeGreaterThanOrEqual(2);

      const violations = findAudienceAsymmetries(rows);
      expect(violations.map((v) => v.detail)).toEqual([]);
    }, 60_000);
  });

  // ==========================================================================
  // 3b. THE NEGATIVE CONTROL — the invariant is known to fail when it should
  // ==========================================================================
  describe('3b. the asymmetry invariant, proved against the rows that made it necessary', () => {
    /** THE EXACT PRE-FIX ROWS, transcribed from the persisted
     * `notification_decisions` of the reproduction run quoted in this file's
     * header. Not an invented shape — the defect, as the database held it. */
    const BADGE_CAUSE = 'badge:c3b29797-67ed-4ce4-bc9f-7e7c147bc64f:00000000-0000-4b41-8000-000000000004';
    const PRE_FIX_CHILD: AudienceDecisionRow = {
      sourceEventId: BADGE_CAUSE,
      targetAudience: 'CHILD',
      eventType: 'BADGE_EARNED',
      decision: 'SUPPRESS',
      reason: 'SCORE_BELOW_FLOOR',
      outcome: null,
      outcomeReason: null,
    };
    const PRE_FIX_PARENT: AudienceDecisionRow = {
      sourceEventId: BADGE_CAUSE,
      targetAudience: 'PARENT',
      eventType: 'BADGE_EARNED_PARENT',
      decision: 'SEND',
      reason: 'SCORE_IN_DEFER_BAND',
      outcome: 'SEND',
      outcomeReason: null,
    };

    it('IT FIRES on the pre-fix rows — an invariant never seen to fail is not known to work', () => {
      const violations = findAudienceAsymmetries([PRE_FIX_CHILD, PRE_FIX_PARENT]);
      expect(violations).toHaveLength(1);
      expect(violations[0].sourceEventId).toBe(BADGE_CAUSE);
      expect(violations[0].childEventType).toBe('BADGE_EARNED');
      expect(violations[0].parentEventType).toBe('BADGE_EARNED_PARENT');
      expect(violations[0].parentOutcome).toBe('TOLD');
      // The report has to be actionable: it names the cause and both sides.
      expect(violations[0].detail).toContain(BADGE_CAUSE);
      expect(violations[0].detail).toContain('BADGE_EARNED_PARENT');
      expect(violations[0].detail).toContain('SCORE_BELOW_FLOOR');
    });

    it('IT ALSO FIRES when the child is lost at the DELIVERY gate rather than at the score', () => {
      // The other half of the same defect class: the verdict said SEND and the
      // pipeline refused it with a cap. An invariant reading only `decision`
      // would have called this a success.
      const child: AudienceDecisionRow = {
        ...PRE_FIX_CHILD,
        decision: 'SEND',
        reason: 'SCORE_ABOVE_SEND_THRESHOLD',
        outcome: 'SUPPRESS',
        outcomeReason: 'HOURLY_MAX',
      };
      const violations = findAudienceAsymmetries([child, PRE_FIX_PARENT]);
      expect(violations).toHaveLength(1);
      expect(violations[0].childReason).toBe('HOURLY_MAX');
    });

    it('IT DOES NOT FIRE on the five shapes that are not this defect', () => {
      // 1. DEFERRAL IS NOT LOSS. A badge held until 07:00 is still told.
      expect(
        findAudienceAsymmetries([
          { ...PRE_FIX_CHILD, decision: 'DEFER', reason: 'QUIET_HOURS_ACTIVE' },
          { ...PRE_FIX_PARENT, decision: 'DEFER', outcome: 'DEFER' },
        ]),
      ).toEqual([]);

      // 2. «ALREADY KNOWN» IS NOT LOSS. A redelivered cause refused by the
      //    unique index is the system working.
      expect(
        findAudienceAsymmetries([
          { ...PRE_FIX_CHILD, decision: 'SEND', outcome: 'SUPPRESS', outcomeReason: 'ALREADY_NOTIFIED' },
          PRE_FIX_PARENT,
        ]),
      ).toEqual([]);

      // 3. THE MIRROR IS NOT FLAGGED, deliberately: many causes legitimately
      //    notify only the child, and `DAILY_GOAL_COMPLETED` is classed CHILD
      //    precisely so the parent is NOT told.
      expect(
        findAudienceAsymmetries([
          { ...PRE_FIX_CHILD, decision: 'SEND', outcome: 'SEND' },
          { ...PRE_FIX_PARENT, decision: 'SUPPRESS', outcome: null },
        ]),
      ).toEqual([]);

      // 4. A CAUSE WITH ONLY ONE AUDIENCE cannot be asymmetric.
      expect(findAudienceAsymmetries([PRE_FIX_CHILD])).toEqual([]);
      expect(findAudienceAsymmetries([PRE_FIX_PARENT])).toEqual([]);

      // 5. TWO DIFFERENT CAUSES are not each other's asymmetry, however similar.
      expect(
        findAudienceAsymmetries([
          PRE_FIX_CHILD,
          { ...PRE_FIX_PARENT, sourceEventId: `${BADGE_CAUSE}-other` },
        ]),
      ).toEqual([]);
    });

    it('a cause the child heard on ANY of its rows is not a loss', () => {
      // One cause, two child candidates, one delivered. The child was told.
      expect(
        findAudienceAsymmetries([
          PRE_FIX_CHILD,
          { ...PRE_FIX_CHILD, eventType: 'REWARD_GRANTED_CHILD', decision: 'SEND', outcome: 'SEND' },
          PRE_FIX_PARENT,
        ]),
      ).toEqual([]);
    });

    it('the three outcome states are folded from the row, not guessed', () => {
      expect(audienceOutcomeOf(PRE_FIX_CHILD)).toBe('LOST');
      expect(audienceOutcomeOf(PRE_FIX_PARENT)).toBe('TOLD');
      expect(audienceOutcomeOf({ ...PRE_FIX_PARENT, decision: 'DEFER', outcome: 'DEFER' })).toBe('HELD');
      // A store that was unreachable told nobody anything — never «already known».
      expect(
        audienceOutcomeOf({ ...PRE_FIX_PARENT, outcome: 'SUPPRESS', outcomeReason: 'DELIVERY_ERROR' }),
      ).toBe('LOST');
      expect(
        audienceOutcomeOf({ ...PRE_FIX_PARENT, outcome: 'SUPPRESS', outcomeReason: 'DUPLICATE' }),
      ).toBe('TOLD');
    });
  });

  // ==========================================================================
  // 4. QUIET HOURS — deferral is not loss, and a badge is not an alarm
  // ==========================================================================
  describe('4. quiet hours still hold a once-ever badge, and never delete one', () => {
    it('THE CLASSES ARE UNCHANGED — the exemption did not promote a badge to a 2 a.m. alarm', () => {
      // Waking a nine-year-old to say «you earned a badge» is the exact harm the
      // window exists to prevent. Both badge types stay DEFER, and neither is on
      // the override list.
      for (const type of Object.keys(ONCE_EVER_TYPES)) {
        expect(quietHoursClassOf(type)).toBe('DEFER');
        expect(DEFAULT_NOTIFICATION_POLICY.priorityOverrideTypes).not.toContain(type);
      }
    });

    it('AT A FROZEN QUIET INSTANT (22:30 Cairo) the badge is DEFERRED, not suppressed', async () => {
      const night = await createHousehold('act-four-night');
      expect(getBusinessTimeHHMM(QUIET_NIGHT, CAIRO)).toBe('22:30');
      await theTwoCrossings(night, QUIET_NIGHT);

      const awards = await badgeAwards(night.familyId);
      expect(awards.map((a) => a.key).sort()).toEqual(['first_activity_goal', 'first_hydration_goal']);
      const activityAward = awards.find((a) => a.key === 'first_activity_goal');
      const row = await badgeDecision(night.familyId, 'BADGE_EARNED', String(activityAward.badge_id));

      // HELD, NOT LOST. That is the whole decision: a badge told at 07:00 is
      // still told; a badge suppressed at 22:35 is gone.
      expect(row.decision).toBe('DEFER');
      expect(row.reason).toBe('QUIET_HOURS_ACTIVE');

      // THE QUIET-HOURS PENALTY STILL APPLIES IN FULL. The once-ever exemption
      // is about VOLUME, and the hour of the night is not volume.
      const quiet = componentOf(row, 'QUIET_HOURS_PENALTY');
      expect(quiet.raw).toBe(1);
      expect(quiet.contribution).toBe(-DEFAULT_NOTIFICATION_POLICY.scoring.penaltyQuietHours);

      // And the fatigue term is still the exempt one — both rules applied at
      // once, neither cancelling the other.
      expect(componentOf(row, 'FATIGUE_PENALTY').contribution).toBe(0);

      // NOTHING WAS WRITTEN TO THE CHILD'S TABLE YET, which is what a deferral
      // means. The release path is `QuietHoursReleaseService`'s and is measured
      // by `quiet-hours-deferral.e2e.spec.ts`; what this suite owns is that the
      // fact was HELD rather than deleted.
      const badgeMessages = (await childMessages(night.familyId)).filter(
        (m) => String(m.category) === 'BADGE_EARNED',
      );
      expect(badgeMessages).toHaveLength(0);

      // AND THE INVARIANT HOLDS AT NIGHT TOO.
      expect(findAudienceAsymmetries(await symmetryRows(night.familyId))).toEqual([]);
    }, 180_000);

    it('AT MIDDAY the same crossings SEND rather than defer', async () => {
      const day = await createHousehold('act-four-day');
      await theTwoCrossings(day, NOON);

      const awards = await badgeAwards(day.familyId);
      const activityAward = awards.find((a) => a.key === 'first_activity_goal');
      const row = await badgeDecision(day.familyId, 'BADGE_EARNED', String(activityAward.badge_id));

      expect(row.decision).toBe('SEND');
      expect(row.outcome).toBe('SEND');
      expect(componentOf(row, 'QUIET_HOURS_PENALTY').contribution).toBe(0);
      expect(
        (await childMessages(day.familyId)).filter((m) => String(m.category) === 'BADGE_EARNED'),
      ).toHaveLength(2);
    }, 180_000);
  });

  // ==========================================================================
  // 5. REPLAY — proved by replaying
  // ==========================================================================
  describe('5. the identical causes driven twice are still one of everything', () => {
    it('REPLAY IS REFUSED BY THE UNIQUE INDEXES, not by an `if`', async () => {
      const home = await createHousehold('act-five');
      await theTwoCrossings(home, NOON);

      const before = {
        awards: (await badgeAwards(home.familyId)).length,
        decisions: (await decisions(home.familyId)).length,
        parent: (await parentNotifications(home.familyId)).length,
        child: (await childMessages(home.familyId)).length,
      };
      expect(before.awards).toBe(2);
      expect(before.child).toBe(4);
      const awardIds = (await badgeAwards(home.familyId)).map((a) => String(a.id)).sort();

      /**
       * THE ONLY WAY TO REACH THE ANNOUNCER TWICE. `rewards_ledger_entries
       * (child_id, idempotency_key)` stops the second grant before it starts,
       * so the ledger rows are deleted and the identical triggers are re-driven
       * — the same technique `first-completion-badge-and-reward.e2e.spec.ts §4`
       * uses. `child_badge_awards` is NOT deleted, because it is the constraint
       * under test: the badge must not be re-awarded even when the ledger no
       * longer remembers paying for it.
       */
      await sys('clear the ledger so the announcer can be reached again', () =>
        prisma.$executeRawUnsafe(
          `DELETE FROM "rewards_ledger_entries" WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      );

      for (const cause of ['HYDRATION_GOAL_COMPLETED', 'ACTIVITY_GOAL_COMPLETED'] as const) {
        await asFamily(home.familyId, () =>
          rewards.trigger(home.childId, home.familyId, {
            engine: 'health',
            type: cause,
            payload: { metric: cause === 'HYDRATION_GOAL_COMPLETED' ? 'hydration' : 'activity', verifiedBy: 'SELF' },
            idempotencyKey: composeIdempotencyKey(cause as any, {
              childId: home.childId,
              localDate: BUSINESS_DAY,
            }),
          } as any),
        );
      }

      const after = {
        awards: (await badgeAwards(home.familyId)).length,
        decisions: (await decisions(home.familyId)).length,
        parent: (await parentNotifications(home.familyId)).length,
        child: (await childMessages(home.familyId)).length,
      };
      expect(after).toEqual(before);
      // The SAME rows, not replaced ones.
      expect((await badgeAwards(home.familyId)).map((a) => String(a.id)).sort()).toEqual(awardIds);

      // No badge was re-paid: the replay found the award already there.
      const badgeLedger = await raw<any[]>(
        `SELECT COUNT(*)::int AS n FROM "rewards_ledger_entries"
          WHERE "family_id" = $1::uuid AND "reward_type" = 'BADGE'`,
        home.familyId,
      );
      expect(Number(badgeLedger[0].n)).toBe(0);

      // AND THE INVARIANT STILL HOLDS AFTER THE REPLAY.
      expect(findAudienceAsymmetries(await symmetryRows(home.familyId))).toEqual([]);
    }, 240_000);
  });
});
