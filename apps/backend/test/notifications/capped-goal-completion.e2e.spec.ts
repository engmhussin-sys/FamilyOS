/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * SPRINT F1 (DECISION 2) — THE COMPLETION THAT PAID NOTHING AND STILL HAPPENED.
 * ============================================================================
 *
 * WHAT WAS MEASURED. `GOAL_COMPLETED_PARENT` — «{childName} أكمل هدفه في
 * {goalTitle}، وهذه {weekCount} مرة هذا الأسبوع» — has carried copy in two
 * languages, a quiet-hours class, an urgency weight, an achievement baseline
 * and a deep-link destination since `F6-002`, and NOTHING IN `src/` PRODUCED
 * IT. It was not missing data: `weekCount` is a rolling seven-day count of
 * `achievement_requests.status = 'VERIFIED'` by `local_date`, which the
 * database has held all along. It was a CONFLICT — on the paid path this would
 * be a SECOND parent notification for a cause already served by
 * `REWARD_GRANTED_WITH_GOAL`, and `e2e-01` / `e2e-13` forbid exactly that.
 *
 * THE ONE HONEST NICHE IS THE UNPAID COMPLETION, and filling it changes a
 * written rule: CONTEXT §5's «no grant ⇒ no notification». The reasoning for
 * changing it is at the producer (`RewardsEngineService.announceCappedCompletion`)
 * and is one sentence: a child who completed their goal completed it, and a cap
 * is a REWARD POLICY rather than a reason to hide the child's effort from the
 * parent who set the goal.
 *
 * WHAT THIS SUITE EXECUTES, and there is no test double anywhere in it: real
 * `RewardProgramService`, real `RewardRuleService`, real `AchievementService`,
 * a real `OutboxRelay`, the real `RewardsCompletionConsumer`, the real Rewards
 * Engine and its real cap machinery, the real `SmartNotificationEngineService`,
 * the real decision provider, the REAL `ChildSafetyFilterService` and the real
 * delivery pipeline. EVERY COUNT AND EVERY SENTENCE IS READ BACK OUT OF
 * POSTGRESQL WITH SQL.
 *
 *   1  POSITIVE   a second verified completion, refused by the family's own
 *                 `maxPerDay`, tells the parent — once, with the goal named and
 *                 the week counted, and WITHOUT implying a reward was paid.
 *   2  NEGATIVE   the PAID completion says nothing extra (the `e2e-01` /
 *                 `e2e-13` invariant), a capped completion with no nameable
 *                 goal stays silent, and a completion no rule matched stays
 *                 silent.
 *   3  REPLAY     redelivery adds nothing — and the redelivered PAID completion
 *                 is refused by the LEDGER rather than mistaken for a cap,
 *                 which is the one way this producer could have double-notified.
 *   4  QUIET HOURS the fact survives the night in the queue, once.
 *   5  TIMEZONE   one instant, `Africa/Cairo` awake and `Asia/Riyadh` asleep.
 *
 * THE HOUSEHOLD SHAPE, and it is a real one rather than a rig. A parent sets a
 * Quran goal AND a family-wide rule «pay for at most one verified goal a day»
 * (`POST /life-intelligence/reward-rules`, engine `reward-program`, event
 * `ACHIEVEMENT_VERIFIED`, `maxPerDay: 1`). Their child finishes one goal, the
 * parent approves it and it is paid. The parent then PAUSES the program — a
 * supported action that deactivates its companion rules — while a second
 * attempt is already waiting on them. They approve that one too. It is a real
 * completion, it pays nothing, and before this decision it was invisible.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { OutboxRelay } from '../../src/modules/events/application/outbox.relay';
import { OutboxWriter } from '../../src/modules/events/application/outbox.writer';
import { AchievementService } from '../../src/modules/rewards-engine/application/services/achievement.service';
import { RewardProgramService } from '../../src/modules/rewards-engine/application/services/reward-program.service';
import { RewardRuleService } from '../../src/modules/life-intelligence/application/services/reward-rule.service';
import {
  hasEnumOrPlaceholderLeak,
  renderNotificationCopy,
  ordinal,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import { getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { freezeGoldenClock } from '../golden/golden-world';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';

/** Midday in both markets, frozen — see `direct-path-reward-child.e2e.spec.ts`
 * for the full argument about why a notification suite that reads the real
 * clock is a suite that asserts what time CI ran. */
const NOON = new Date('2026-01-15T10:00:00.000Z'); // 12:00 Cairo, 13:00 Riyadh
/** 22:00 Cairo — inside the default 21:00–07:00 window on the family's clock. */
const CAIRO_NIGHT = new Date('2026-01-15T20:00:00.000Z');
/** In January Cairo is UTC+02:00 and Riyadh is UTC+03:00, so at 18:30 UTC one
 * household is awake at 20:30 and the other is asleep at 21:30. */
const SPLIT_INSTANT = new Date('2026-01-15T18:30:00.000Z');

const QUIET_HOURS_START = '21:00';
const QUIET_HOURS_END = '07:00';

const PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/;
const ARABIC_LETTERS = /[؀-ۿ]/;
const WESTERN_DIGITS = /[0-9]/;
const PUNITIVE = ['فشل', 'خطأ', 'رفض', 'مرفوض', 'عقاب', 'تحذير', 'مخالفة', 'تجاوز', 'سيئ'];

/**
 * THE WORDS THAT WOULD MAKE THIS SENTENCE A LIE. The parent is being told their
 * child COMPLETED something, not that anything was PAID — the cap is precisely
 * why nothing was. A sentence containing any of these would re-create the
 * defect the sibling-key argument in `notification-copy.ts` exists to prevent.
 */
const REWARD_WORDS = ['مكافأة', 'نقطة', 'نقاط', 'عملة', 'رصيد'];

/** `describeTargetSpec`'s own output for Al-Mulk 1–5, derived server-side and
 * stored on `reward_programs.target_summary_ar` with Latin digits. */
const GOAL_TITLE = 'الآيات 1–5 من سورة الملك';
/**
 * THE SAME TITLE AS A PARENT ACTUALLY READS IT. `renderNotificationCopy`
 * localises digits into the household's own numerals, so the stored summary
 * «الآيات 1–5» reaches the notification body as «الآيات ١–٥». Asserting the
 * STORED form against a RENDERED body is the `PF-E-002` mistake in reverse, and
 * both spellings are named here so neither is mistaken for the other.
 */
const GOAL_TITLE_AR = 'الآيات ١–٥ من سورة الملك';

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
  readonly childName: string;
  readonly timeZone: string;
}

describeIfDb('F1 DECISION 2 — the UNPAID goal completion reaches the parent (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let relay: OutboxRelay;
  let outbox: OutboxWriter;
  let programs: RewardProgramService;
  let achievements: AchievementService;
  let rules: RewardRuleService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 decision-2 suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  /** THE RELAY, run to quiescence: consumers emit further events, so one tick
   * is not the chain. */
  async function drain(maxPasses = 12): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const tick = await relay.tick();
      published += tick.published;
      failed += tick.failed;
      if (tick.claimed === 0) break;
    }
    return { published, failed };
  }

  const decisions = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const notifications = (familyId: string): Promise<any[]> =>
    raw<any[]>(`SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`, familyId);

  const deliveries = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const countOf = async (table: string, familyId: string): Promise<number> =>
    Number((await raw<any[]>(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE "family_id" = $1::uuid`, familyId))[0].n);

  const ofType = async (familyId: string, type: string): Promise<any[]> =>
    (await notifications(familyId)).filter((n) => n.type === type);

  const decisionsOfType = async (familyId: string, eventType: string): Promise<any[]> =>
    (await decisions(familyId)).filter((d) => d.event_type === eventType);

  function assertItReadsLikeASentence(text: string): void {
    expect(text).not.toMatch(PLACEHOLDER);
    expect(hasEnumOrPlaceholderLeak(text)).toBe(false);
    expect(text.trim().length).toBeGreaterThan(4);
  }

  // -- fixtures --------------------------------------------------------------

  async function createHousehold(label: string, timeZone: string = CAIRO): Promise<Household> {
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `F1-D2 ${label} ${stamp}`, timezone: timeZone }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `f1d2.${label}.${stamp}@example.test`, passwordHash: 'x', fullName: 'F1-D2 Parent' },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    const child = await sys('create child', () =>
      prisma.child.create({
        data: { familyId: family.id, firstName: 'محمد', dateOfBirth: new Date('2014-01-01T00:00:00.000Z') },
        select: { id: true },
      }),
    );

    return { familyId: family.id, childId: child.id, userId: user.id, childName: 'محمد', timeZone };
  }

  const asFamily = <T>(familyId: string, fn: () => Promise<T>): Promise<T> =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'f1-d2-test' }, fn);

  async function aQuranGoal(h: Household): Promise<string> {
    const created = await asFamily(h.familyId, () =>
      programs.create(h.familyId, h.userId, {
        childId: h.childId,
        category: 'QURAN',
        activity: 'QURAN_MEMORIZE_AYAH_RANGE',
        targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
        durationMinutes: 20,
        verificationLevel: 'PARENT_CONFIRMATION',
        rewardSpec: { type: 'POINTS', amount: 20 },
        frequency: 'DAILY',
        maxPerDay: 3,
        maxPerWeek: 7,
      } as any),
    );
    return created.id;
  }

  /**
   * «PAY FOR AT MOST ONE VERIFIED GOAL A DAY», written by the parent through
   * the real management service, against the real DTO validation. This is the
   * cap that refuses the second completion — a REWARD POLICY the parent chose,
   * which is precisely why hiding the completion behind it would be wrong.
   */
  async function aOneGoalPerDayRule(h: Household): Promise<string> {
    const rule = await asFamily(h.familyId, () =>
      rules.create(h.familyId, h.userId, {
        triggerEngine: 'reward-program',
        eventType: 'ACHIEVEMENT_VERIFIED',
        triggerCondition: {},
        rewardType: 'XP',
        amount: 20,
        maxPerDay: 1,
        labelAr: 'هدف مكتمل',
      } as any),
    );
    return rule.id;
  }

  /** start -> submit -> parent approves. Returns the attempt id. */
  async function verifyOneAttempt(h: Household, programId: string, at: Date): Promise<string> {
    const started = await asFamily(h.familyId, () => achievements.start(h.childId, programId, at));
    const submitted = await asFamily(h.familyId, () =>
      achievements.submit(h.childId, started.id, { selfConfirmed: true } as any, at),
    );
    expect(submitted.status).toBe('PENDING_PARENT');
    const decided = await asFamily(h.familyId, () => achievements.decide(h.userId, started.id, true, undefined, at));
    expect(decided.status).toBe('VERIFIED');
    return started.id;
  }

  /**
   * THE WHOLE HOUSEHOLD STORY, up to but NOT including the second approval —
   * so a test can move the clock before the moment it measures.
   *
   * Note the ORDER, which is forced by the product's own rules rather than
   * chosen: `MAX_OPEN_ATTEMPTS_PER_DAY` is 1, so the second attempt can only be
   * opened after the first is decided; and a PAUSED program refuses `start`, so
   * the pause has to come after the second attempt is already open. That is
   * exactly the real sequence — a parent pausing a goal while their child has
   * work already submitted against it.
   */
  async function aHouseholdWithAnAttemptWaiting(
    label: string,
    timeZone: string = CAIRO,
  ): Promise<{ home: Household; programId: string; ruleId: string; pendingAttemptId: string }> {
    const home = await createHousehold(label, timeZone);
    const programId = await aQuranGoal(home);
    const ruleId = await aOneGoalPerDayRule(home);

    // COMPLETION #1 — verified, and PAID by both the program's companion rule
    // and the family's own rule. This is the ordinary path, and it fills the
    // family rule's `maxPerDay` for the day.
    await verifyOneAttempt(home, programId, NOON);
    expect((await drain()).failed).toBe(0);

    // COMPLETION #2 — opened and submitted, waiting on the parent.
    const started = await asFamily(home.familyId, () => achievements.start(home.childId, programId, NOON));
    await asFamily(home.familyId, () =>
      achievements.submit(home.childId, started.id, { selfConfirmed: true } as any, NOON),
    );

    // THE PARENT PAUSES THE GOAL. `RewardProgramService.update` deactivates the
    // companion rules — «archiving or pausing a program must stop it paying» —
    // so the only rule left that can pay a verified achievement is the family's
    // own, and that one is already at its daily cap.
    await asFamily(home.familyId, () => programs.update(programId, { status: 'PAUSED' } as any));

    return { home, programId, ruleId, pendingAttemptId: started.id };
  }

  /** A completion written the way a real producer writes one — a domain event
   * through `OutboxWriter`, in the family's own tenant scope. */
  function writeCompletion(
    h: Household,
    type: string,
    completion: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<any> {
    return asFamily(h.familyId, () =>
      outbox.write({
        type: type as any,
        aggregateType: 'HabitOccurrence',
        aggregateId: h.childId,
        childId: h.childId,
        deviceId: null,
        idempotencyKey,
        clientEventId: null,
        occurredAt: new Date(),
        traceId: null,
        payload: {
          schemaVersion: 1,
          childId: h.childId,
          deviceId: null,
          localDate: '2026-01-15',
          occurredAt: new Date().toISOString(),
          idempotencyKey,
          pointsHint: null,
          ...completion,
        },
      }),
    );
  }

  beforeAll(async () => {
    freezeGoldenClock(NOON);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    relay = app.get(OutboxRelay);
    outbox = app.get(OutboxWriter);
    programs = app.get(RewardProgramService);
    achievements = app.get(AchievementService);
    rules = app.get(RewardRuleService);
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
  // 0. THE GUARD ON THE CLOCK
  // ==========================================================================
  it('THE CLOCK IS FROZEN AT MIDDAY, in both markets', () => {
    expect(Date.now()).toBe(NOON.getTime());
    expect(getBusinessTimeHHMM(new Date(), CAIRO)).toBe('12:00');
    expect(getBusinessTimeHHMM(new Date(), RIYADH)).toBe('13:00');
    for (const zone of [CAIRO, RIYADH]) {
      const local = getBusinessTimeHHMM(new Date(), zone);
      expect(`${zone}:${local > QUIET_HOURS_END && local < QUIET_HOURS_START}`).toBe(`${zone}:true`);
    }
  });

  // ==========================================================================
  // 1. POSITIVE — the completion that paid nothing
  // ==========================================================================

  describe('1. POSITIVE — a cap-refused completion tells the parent, once', () => {
    let home: Household;
    let pendingAttemptId = '';

    it('the PAID completion says exactly what it always said — one grant, one parent notification', async () => {
      jest.setSystemTime(NOON);
      const built = await aHouseholdWithAnAttemptWaiting('positive');
      home = built.home;
      pendingAttemptId = built.pendingAttemptId;

      // ===== THE `e2e-01` / `e2e-13` INVARIANT, ON THE PAID HALF =====
      // Two ledger rows because two rules paid (the program's companion tier
      // and the family's own rule), but ONE parent notification and ONE child
      // message for ONE business event — and NO `GOAL_COMPLETED_PARENT`.
      expect(await countOf('rewards_ledger_entries', home.familyId)).toBe(2);
      expect(await countOf('notifications', home.familyId)).toBe(1);
      expect(await countOf('child_messages', home.familyId)).toBe(1);
      expect(await decisionsOfType(home.familyId, 'GOAL_COMPLETED_PARENT')).toHaveLength(0);

      const [paid] = await notifications(home.familyId);
      expect(paid.type).toBe('REWARD_GRANTED');
      // The paid sentence NAMES the goal AND the points — that cause is served,
      // which is exactly why producing a second parent notification for it is
      // forbidden.
      expect(paid.body).toContain(GOAL_TITLE_AR);
    }, 180_000);

    it('the CAP-REFUSED completion produces GOAL_COMPLETED_PARENT — the goal named, the week counted', async () => {
      jest.setSystemTime(NOON);
      const before = await countOf('notifications', home.familyId);

      await asFamily(home.familyId, () =>
        achievements.decide(home.userId, pendingAttemptId, true, undefined, NOON),
      );
      expect((await drain()).failed).toBe(0);

      // NOTHING WAS PAID — that is the premise, read out of the ledger rather
      // than assumed. The second completion added no row.
      expect(await countOf('rewards_ledger_entries', home.familyId)).toBe(2);
      // AND NO `REWARD_GRANTED` WAS EMITTED for it: `RewardsCompletionConsumer`
      // returns before writing one whenever the ledger holds nothing, so the
      // «no grant ⇒ no notification» rule still governs the REWARD sentence.
      expect(await ofType(home.familyId, 'REWARD_GRANTED')).toHaveLength(1);

      // ===== THE ROW THAT DID NOT EXIST BEFORE THIS DECISION =====
      expect(await countOf('notifications', home.familyId)).toBe(before + 1);
      const [row] = await ofType(home.familyId, 'GOAL_COMPLETED_PARENT');
      expect(row).toBeDefined();

      const [decision] = await decisionsOfType(home.familyId, 'GOAL_COMPLETED_PARENT');
      expect(decision.target_audience).toBe('PARENT');
      expect(decision.copy_key).toBe('GOAL_COMPLETED_PARENT');
      expect(decision.notification_type).toBe('GOAL_COMPLETED_PARENT');
      expect(decision.category).toBe('GOAL');

      // ===== THE SENTENCE =====
      expect(row.body).toContain(home.childName);
      expect(row.body).toContain(GOAL_TITLE_AR);
      expect(row.body).toMatch(ARABIC_LETTERS);
      assertItReadsLikeASentence(row.body);
      assertItReadsLikeASentence(row.title);
      for (const word of PUNITIVE) expect(row.body).not.toContain(word);

      // ===== AND IT DOES NOT CLAIM A REWARD WAS GIVEN =====
      // The cap is why nothing was paid; a sentence that implied otherwise
      // would be the lie «no grant ⇒ no notification» was protecting against.
      for (const word of REWARD_WORDS) expect(row.body).not.toContain(word);

      // ===== THE COUNT IS REAL, AND IT IS THE LEDGER'S OWN WINDOW =====
      // Two VERIFIED `achievement_requests` rows exist for this child inside the
      // rolling seven family-local days, so the sentence says «ثاني مرة».
      const verified = Number(
        (
          await raw<any[]>(
            `SELECT COUNT(*)::int AS n FROM "achievement_requests"
              WHERE "family_id" = $1::uuid AND "status" = 'VERIFIED'`,
            home.familyId,
          )
        )[0].n,
      );
      expect(verified).toBe(2);
      // AND IT IS RENDERED AS AN ARABIC ORDINAL IN WORDS — «ثاني», not «2».
      // Arabic ordinals below ten are irregular and a template cannot inflect
      // them, which is why `copyFor` does it in the locale rather than the
      // producer. The only Latin digits in this sentence belong to the goal's
      // own server-derived name («الآيات 1–5»), never to the count.
      expect(row.body).toContain(ordinal(2, 'ar'));
      expect(row.body).not.toMatch(WESTERN_DIGITS);

      // ===== PROVENANCE — the stored sentence IS the catalogue's =====
      const rendered = renderNotificationCopy({
        key: decision.copy_key,
        audience: decision.target_audience,
        toneBand: decision.age_band,
        locale: decision.locale,
        variables: { childName: home.childName, goalTitle: GOAL_TITLE, weekCount: ordinal(2, 'ar') },
      });
      expect(row.body).toBe(rendered.body);
      expect(row.title).toBe(rendered.title);

      // ===== AND THE CHILD IS NOT TOLD =====
      // This decision is about the PARENT hearing that their child's effort
      // happened. The child already knows they finished; telling them «you
      // completed it and got nothing» is the punitive reading CONTEXT §3.7
      // forbids.
      expect(await countOf('child_messages', home.familyId)).toBe(1);
    }, 180_000);

    it('the key is the trigger’s own, with a facet that cannot collide with the grant’s', async () => {
      const [row] = await ofType(home.familyId, 'GOAL_COMPLETED_PARENT');
      expect(String(row.source_event_id).startsWith('reward:')).toBe(true);
      expect(String(row.source_event_id).endsWith(':completed-unpaid')).toBe(true);

      // The PAID notification for the OTHER completion carries the bare form of
      // its own trigger key. Two causes, two keys, and the facet is what makes
      // «this is the completion, not the grant» legible in the row itself.
      const [paid] = await ofType(home.familyId, 'REWARD_GRANTED');
      expect(paid.source_event_id).not.toBe(row.source_event_id);
      expect(String(paid.source_event_id).endsWith(':completed-unpaid')).toBe(false);
    }, 120_000);
  });

  // ==========================================================================
  // 2. NEGATIVE — silence where silence is correct
  // ==========================================================================

  describe('2. NEGATIVE — the cases that must stay silent', () => {
    it('a capped completion with NO nameable goal says nothing — a habit is not a goal', async () => {
      jest.setSystemTime(NOON);
      const habits = await createHousehold('habit-cap');
      await asFamily(habits.familyId, () =>
        rules.create(habits.familyId, habits.userId, {
          triggerEngine: 'habit-builder',
          eventType: 'HABIT_COMPLETED',
          triggerCondition: {},
          rewardType: 'XP',
          amount: 10,
          maxPerDay: 1,
        } as any),
      );

      for (const n of [1, 2]) {
        await writeCompletion(
          habits,
          'HABIT_COMPLETED',
          { completionKind: 'HABIT', sourceType: 'HabitOccurrence', sourceId: habits.childId, verifiedBy: 'SELF', metadata: {} },
          `f1d2:habit:${habits.childId}:${n}`,
        );
        expect((await drain()).failed).toBe(0);
      }

      // The second completion WAS refused by the cap — one ledger row for two
      // completions — and it said nothing, because there is no goal to name and
      // «{childName} أكمل هدفه في {goalTitle}» cannot be rendered without one.
      expect(await countOf('rewards_ledger_entries', habits.familyId)).toBe(1);
      expect(await decisionsOfType(habits.familyId, 'GOAL_COMPLETED_PARENT')).toHaveLength(0);
      expect(await countOf('notifications', habits.familyId)).toBe(1);
    }, 180_000);

    it('a completion NO RULE matched says nothing — «no grant ⇒ no notification» is unchanged there', async () => {
      jest.setSystemTime(NOON);
      const quiet = await createHousehold('no-rule');
      // A family that owns the `smart-tasks` engine with a rule for a DIFFERENT
      // event type: the platform defaults are suppressed and nothing matches, so
      // the completion is genuinely unpaid and genuinely unremarkable.
      await asFamily(quiet.familyId, () =>
        rules.create(quiet.familyId, quiet.userId, {
          triggerEngine: 'smart-tasks',
          eventType: 'MEMORIZATION_COMPLETED',
          triggerCondition: {},
          rewardType: 'XP',
          amount: 10,
        } as any),
      );

      await writeCompletion(
        quiet,
        'TASK_COMPLETED',
        { completionKind: 'TASK', sourceType: 'SmartTask', sourceId: quiet.childId, verifiedBy: 'SELF', metadata: {} },
        `f1d2:task:${quiet.childId}:1`,
      );
      expect((await drain()).failed).toBe(0);

      expect(await countOf('rewards_ledger_entries', quiet.familyId)).toBe(0);
      expect(await countOf('notifications', quiet.familyId)).toBe(0);
      expect(await countOf('notification_decisions', quiet.familyId)).toBe(0);
    }, 180_000);
  });

  // ==========================================================================
  // 3. REPLAY — and the one way this producer could have double-notified
  // ==========================================================================

  /**
   * THE DANGEROUS CASE, WRITTEN DOWN BECAUSE IT IS THE WHOLE DESIGN.
   *
   * `applyEarn` returns `false` for a CAP refusal AND for an IDEMPOTENCY
   * duplicate, and on a REDELIVERY of an already-paid completion the cap check
   * fires FIRST — the earlier grant is inside the window. So a producer that
   * trusted the boolean would announce `GOAL_COMPLETED_PARENT` for a completion
   * `REWARD_GRANTED_WITH_GOAL` has already announced: a second parent
   * notification for one cause, which `e2e-01` and `e2e-13` forbid.
   *
   * The producer therefore asks the LEDGER — `countGrantsForTrigger` — which is
   * a durable question about committed rows rather than a per-attempt boolean.
   * This test deletes the consumption markers and requeues every message, which
   * is what an at-least-once outbox really does, and measures that the answer
   * holds.
   */
  it('3. REPLAY — redelivery adds nothing, and a PAID completion is never mistaken for a capped one', async () => {
    jest.setSystemTime(NOON);
    const built = await aHouseholdWithAnAttemptWaiting('replay');
    await asFamily(built.home.familyId, () =>
      achievements.decide(built.home.userId, built.pendingAttemptId, true, undefined, NOON),
    );
    expect((await drain()).failed).toBe(0);

    const before = {
      ledger: await countOf('rewards_ledger_entries', built.home.familyId),
      notifications: await countOf('notifications', built.home.familyId),
      childMessages: await countOf('child_messages', built.home.familyId),
      decisions: (await decisions(built.home.familyId)).length,
    };
    expect(before.notifications).toBe(2); // one REWARD_GRANTED, one GOAL_COMPLETED_PARENT
    expect((await ofType(built.home.familyId, 'GOAL_COMPLETED_PARENT'))).toHaveLength(1);

    // `consumed_messages` is an OPTIMISATION by its own docstring: delete the
    // markers and every handler runs again. This is the case a five-minute
    // fatigue window does NOT cover.
    await sys('delete consumer markers', () =>
      prisma.$executeRawUnsafe(`DELETE FROM "consumed_messages" WHERE "family_id" = $1::uuid`, built.home.familyId),
    );
    await sys('requeue every message', () =>
      prisma.$executeRawUnsafe(
        `UPDATE "outbox_messages"
            SET "status" = 'PENDING', "attempt_count" = 0, "next_attempt_at" = NOW(),
                "locked_by" = NULL, "locked_at" = NULL, "published_at" = NULL
          WHERE "family_id" = $1::uuid`,
        built.home.familyId,
      ),
    );
    const replay = await drain();
    expect(replay.failed).toBe(0);
    // NOT VACUOUS — the messages really were re-published and the consumers
    // really did run again.
    expect(replay.published).toBeGreaterThan(0);

    expect(await countOf('rewards_ledger_entries', built.home.familyId)).toBe(before.ledger);
    expect(await countOf('notifications', built.home.familyId)).toBe(before.notifications);
    expect(await countOf('child_messages', built.home.familyId)).toBe(before.childMessages);
    expect((await decisions(built.home.familyId)).length).toBe(before.decisions);
    // AND STILL EXACTLY ONE — the redelivered PAID completion, whose cap check
    // also refused on replay, did not become a second «goal completed».
    expect(await ofType(built.home.familyId, 'GOAL_COMPLETED_PARENT')).toHaveLength(1);
  }, 240_000);

  // ==========================================================================
  // 4. QUIET HOURS
  // ==========================================================================

  it('4. QUIET HOURS — the completion survives the night in the queue, once', async () => {
    jest.setSystemTime(NOON);
    const built = await aHouseholdWithAnAttemptWaiting('quiet');
    const deferredBefore = await countOf('notification_deliveries', built.home.familyId);

    jest.setSystemTime(CAIRO_NIGHT);
    expect(getBusinessTimeHHMM(new Date(), CAIRO)).toBe('22:00');

    await asFamily(built.home.familyId, () =>
      achievements.decide(built.home.userId, built.pendingAttemptId, true, undefined, CAIRO_NIGHT),
    );
    expect((await drain()).failed).toBe(0);

    // NOT DELIVERED — and not dropped. `notification-class.ts` defers a GOAL:
    // «the completion row exists and the receipt is still a receipt in the
    // morning».
    expect(await ofType(built.home.familyId, 'GOAL_COMPLETED_PARENT')).toHaveLength(0);
    const queued = (await deliveries(built.home.familyId)).filter((r) => r.type === 'GOAL_COMPLETED_PARENT');
    expect(await countOf('notification_deliveries', built.home.familyId)).toBe(deferredBefore + 1);
    expect(queued).toHaveLength(1);
    expect(queued[0].state).toBe('PENDING');
    expect(queued[0].target_audience).toBe('PARENT');
    expect(queued[0].defer_reason).toBe('QUIET_HOURS');
    // 07:00 on THIS family's clock, which in January Cairo is 05:00 UTC.
    expect(new Date(queued[0].scheduled_for).toISOString()).toBe('2026-01-16T05:00:00.000Z');
    // The sentence was composed BEFORE the queue, so the goal survives the night
    // with it.
    expect(queued[0].body).toContain(GOAL_TITLE_AR);

    const [decision] = await decisionsOfType(built.home.familyId, 'GOAL_COMPLETED_PARENT');
    expect(decision.decision).toBe('DEFER');
    expect(decision.reason).toBe('QUIET_HOURS_ACTIVE');
    expect(decision.outcome).toBe('DEFER');

    jest.setSystemTime(NOON);
  }, 240_000);

  // ==========================================================================
  // 5. TIMEZONE — one instant, two calendars
  // ==========================================================================

  it('5. TIMEZONE — the SAME instant delivers in Africa/Cairo and defers in Asia/Riyadh', async () => {
    jest.setSystemTime(NOON);
    const cairo = await aHouseholdWithAnAttemptWaiting('tz-cairo', CAIRO);
    const riyadh = await aHouseholdWithAnAttemptWaiting('tz-riyadh', RIYADH);

    jest.setSystemTime(SPLIT_INSTANT);
    expect(getBusinessTimeHHMM(new Date(), CAIRO)).toBe('20:30');
    expect(getBusinessTimeHHMM(new Date(), RIYADH)).toBe('21:30');

    for (const built of [cairo, riyadh]) {
      await asFamily(built.home.familyId, () =>
        achievements.decide(built.home.userId, built.pendingAttemptId, true, undefined, SPLIT_INSTANT),
      );
    }
    expect((await drain()).failed).toBe(0);

    // CAIRO IS AWAKE.
    expect(await ofType(cairo.home.familyId, 'GOAL_COMPLETED_PARENT')).toHaveLength(1);
    expect(
      (await deliveries(cairo.home.familyId)).filter((r) => r.type === 'GOAL_COMPLETED_PARENT'),
    ).toHaveLength(0);

    // RIYADH IS ASLEEP — and its morning is an hour earlier in UTC than
    // Cairo's, because the zones differ. A server that asked UTC would have
    // given both households the same answer and been wrong for one of them.
    expect(await ofType(riyadh.home.familyId, 'GOAL_COMPLETED_PARENT')).toHaveLength(0);
    const queued = (await deliveries(riyadh.home.familyId)).filter((r) => r.type === 'GOAL_COMPLETED_PARENT');
    expect(queued).toHaveLength(1);
    expect(new Date(queued[0].scheduled_for).toISOString()).toBe('2026-01-16T04:00:00.000Z');
    expect(queued[0].body).toContain(GOAL_TITLE_AR);

    jest.setSystemTime(NOON);
  }, 300_000);
});
