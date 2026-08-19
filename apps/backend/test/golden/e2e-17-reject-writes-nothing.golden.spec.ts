/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * E2E-17 — A REFUSED SENTENCE LEAVES NO TRACE, AND THE CHILD STILL GETS THEIR
 * MESSAGE. THE WHOLE CHAIN, OVER REAL HTTP, ON REAL INFRASTRUCTURE.
 * ============================================================================
 *
 * THE CLAUSE THIS SCENARIO EXECUTES:
 *
 *     REJECT MEANS NO WRITE — and «no write» is a statement about the
 *     DATABASE, not about one repository's call count.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS BESIDE `test/ai-core/safety-reject-writes-nothing.spec.ts`.
 *
 * That suite drives the three GENERATION paths service by service and sweeps
 * every text-bearing table for the refused sentence. It ends at the write. This
 * one adds the three things it cannot say:
 *
 *   1. THE REAL LOOP. The child earns a real reward on their own paired device
 *      over real HTTP, the real producer chain fires, and the model misbehaves
 *      IN THE MIDDLE OF IT — not in a service call this file composed.
 *   2. THE NIGHT PATH. `notification_deliveries` is a SECOND table that holds a
 *      title and a body addressed to a child, and NOTHING reaches it on the
 *      immediate path — it exists only when quiet hours defer a message until
 *      morning. A sweep that only ever ran at noon would never look at it.
 *      ACT III runs at 22:00 Africa/Cairo, defers, releases, and sweeps both
 *      sides of the night.
 *   3. THE DELIVERY END. The invariant's last word is «and DELIVERED». So the
 *      parent approves, the child's own device reads its inbox, and what comes
 *      back over the wire is asserted to be the safe sentence — and to be a
 *      real card rather than a blank one or an error.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL MISBEHAVES ON THE CHILD'S SENTENCE ONLY, AND THAT IS DELIBERATE.
 *
 * One reward legitimately notifies BOTH audiences — `NotificationRewardConsumer`
 * makes two `handleEvent` calls — and the two audiences are filtered by two
 * different policies. `SafetyEngineService`, the PARENT policy, is six English
 * regexes about spyware and it PASSES «أنت كسول ولم تنجز شيئًا اليوم»; that is
 * not news, it is the measured premise `PG-001` was written on, and
 * `child-safety-before-persistence.spec.ts` pins it. If this file let the model
 * return that sentence for the parent's half too, a parent row would hold it and
 * this scenario's sweep would be reporting that known parent-policy property
 * instead of the child-path question it is asking. So the scripted provider
 * refuses only the sentence it is handed for the CHILD, and ACT 0 asserts that
 * it really did fire — a discriminator that silently stopped matching would make
 * every zero below vacuous.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL. Real PostgreSQL, real Redis, the real `AppModule`, the real
 * global HTTP pipeline, the real guards, the real device token, the real tenant
 * extension, the real outbox relay, the real quiet-hours release sweep. The ONE
 * substitution is `AI_PROVIDER` — no Anthropic key exists here, and a scenario
 * about what happens when a model returns an unsafe sentence must be able to
 * make one do it.
 *
 * THE CLOCK IS FROZEN (`freezeGoldenClock`) and ACT III moves it into the
 * family's own night on purpose: the deferral instant, the business date and
 * the quiet window are all functions of the family's wall clock.
 */
import { randomUUID } from 'node:crypto';

import request = require('supertest');

import {
  GOLDEN_NOON,
  P,
  ageTheHousehold,
  asChild,
  asParent,
  bootGoldenWorld,
  describeGolden,
  freezeGoldenClock,
  goldenAt,
  type GoldenHousehold,
  type GoldenWorld,
} from './golden-world';
import { AI_PROVIDER, type IAIProviderRequest } from '../../src/modules/ai-core/domain/ai-provider.port';
import { ChildSafetyFilterService } from '../../src/modules/ai-core/application/services/child-safety-filter.service';
import { ageBandFor, countWords, profileForAge } from '../../src/modules/ai-core/domain/age-band';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import type { NotificationEventInput } from '../../src/modules/notification-engine/application/services/notification-context.assembler';
import { QuietHoursReleaseService } from '../../src/modules/life-intelligence/application/services/quiet-hours-release.service';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';

/** See the header: letter-led and letter-broken, so `PII_LEAK` cannot fire on
 * the marker itself and turn every rejection below into a `TOO_LONG` or a
 * phone-number match instead of the SHAMING one this scenario is about. */
const marker = (): string => {
  const hex = randomUUID().replace(/-/g, '');
  return `zq${hex.slice(0, 5)}x${hex.slice(5, 10)}`;
};

const UNSAFE_MARK = marker();
const SAFE_MARK = marker();
const NIGHT_UNSAFE_MARK = marker();
const NIGHT_SAFE_MARK = marker();
const RUN_ID = randomUUID().slice(0, 8);

/** The sentence `F6-005` watched land in `child_messages` verbatim. */
const UNSAFE_BODY = `أنت كسول ولم تنجز شيئًا اليوم ${UNSAFE_MARK}`;
const SAFE_BODY = `أحسنت اليوم، خطوة جميلة نحو هدفك ${SAFE_MARK}`;
const NIGHT_UNSAFE_BODY = `أنت كسول ولم تنجز شيئًا اليوم ${NIGHT_UNSAFE_MARK}`;
const NIGHT_SAFE_BODY = `أحسنت اليوم، خطوة جميلة نحو هدفك ${NIGHT_SAFE_MARK}`;

const CHILD_AGE = 12;
/** 22:00 Africa/Cairo (UTC+3 in summer) — inside the 21:00–07:00 quiet window,
 * asserted from the family's own timezone in ACT III rather than by arithmetic
 * here. */
const CAIRO_NIGHT = goldenAt('19:00');
/** 07:30 the next Cairo morning: after `quietHoursEnd`, so the queue is due. */
const CAIRO_MORNING = new Date(CAIRO_NIGHT.getTime() + 9.5 * 60 * 60 * 1000);

// ===========================================================================
// THE SCRIPTED PROVIDER
// ===========================================================================
/**
 * It answers with `unsafe` when the sentence it is offered matches `poisonWhen`
 * and with `safe` otherwise, and it COUNTS both — so «the model misbehaved on
 * the child's sentence» is a measurement this file makes rather than a comment
 * it writes.
 */
const script: {
  unsafe: string;
  safe: string | null;
  poisonWhen: (req: IAIProviderRequest) => boolean;
  poisoned: number;
  calls: IAIProviderRequest[];
} = {
  unsafe: UNSAFE_BODY,
  safe: null,
  poisonWhen: () => false,
  poisoned: 0,
  calls: [],
};

const arm = (opts: {
  unsafe?: string;
  safe?: string | null;
  poisonWhen?: (req: IAIProviderRequest) => boolean;
}): void => {
  script.unsafe = opts.unsafe ?? UNSAFE_BODY;
  script.safe = opts.safe === undefined ? null : opts.safe;
  script.poisonWhen = opts.poisonWhen ?? (() => false);
  script.poisoned = 0;
  script.calls = [];
};

describeGolden('E2E-17 — a refused child sentence reaches nothing, and the child still gets their message', () => {
  let world: GoldenWorld;
  /** The daytime household: the real reward loop. */
  let DAY: GoldenHousehold;
  /** Registered AT NIGHT, so its device token is not hours expired by 22:00 —
   * the same reason, and the same three lines, as E2E-16's `NIGHT`. */
  let NIGHT: GoldenHousehold;
  let filter: ChildSafetyFilterService;
  let engine: SmartNotificationEngineService;
  let release: QuietHoursReleaseService;

  let TABLES: string[] = [];
  let SWEEP_SQL = '';

  const rephraseWas = process.env.NOTIFICATION_AI_REPHRASE_ENABLED;

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    // The composer reads this per call. With it off the model is never offered
    // a sentence and every act below would be asserting the emptiness of a path
    // that did not run. Restored in `afterAll`.
    process.env.NOTIFICATION_AI_REPHRASE_ENABLED = 'true';

    world = await bootGoldenWorld('e2e-17-reject-writes-nothing', (builder) =>
      builder.overrideProvider(AI_PROVIDER).useValue({
        complete: async (req: IAIProviderRequest): Promise<string> => {
          script.calls.push(req);
          if (script.poisonWhen(req)) {
            script.poisoned += 1;
            return script.unsafe;
          }
          if (script.safe === null) throw new Error('E2E-17: no safe reply armed for this sentence');
          return script.safe;
        },
      }),
    );

    const year = new Date().getUTCFullYear();
    DAY = await world.register('e2e17day', {
      childName: 'محمد',
      childDateOfBirth: `${year - CHILD_AGE}-01-05`,
      familyTimeZone: 'Africa/Cairo',
    });
    await ageTheHousehold(world, DAY, goldenAt('06:00'));

    jest.setSystemTime(CAIRO_NIGHT);
    NIGHT = await world.register('e2e17night', {
      childName: 'ليان',
      childDateOfBirth: `${year - CHILD_AGE}-01-05`,
      familyTimeZone: 'Africa/Cairo',
    });
    jest.setSystemTime(GOLDEN_NOON);

    filter = world.app.get(ChildSafetyFilterService);
    engine = world.app.get(SmartNotificationEngineService);
    release = world.app.get(QuietHoursReleaseService);

    // ---- THE SEARCH SPACE, DERIVED FROM THE LIVE CATALOGUE ---------------
    // Never a hand-written list: a list rots, and the table somebody forgets is
    // the one that holds the sentence. `::text` on the identifier because
    // `information_schema` hands back PostgreSQL's `name` type, which the WASM
    // query engine this repository runs on cannot deserialize.
    const rows = await world.raw<Array<{ table_name: string }>>(`
      SELECT DISTINCT t.table_name::text AS table_name
        FROM information_schema.tables t
        JOIN information_schema.columns c
          ON c.table_schema = t.table_schema AND c.table_name = t.table_name
       WHERE t.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND t.table_name <> '_prisma_migrations'
         AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')
       ORDER BY 1
    `);
    TABLES = rows.map((r) => r.table_name);
    SWEEP_SQL = TABLES.map(
      (t) =>
        `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}" x ` +
        `WHERE row_to_json(x)::text LIKE '%' || $1 || '%'`,
    ).join(' UNION ALL ');
  }, 300_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (rephraseWas === undefined) delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
    else process.env.NOTIFICATION_AI_REPHRASE_ENABLED = rephraseWas;
    if (world) await world.close();
  });

  // -------------------------------------------------------------------------
  // THE TWO SWEEPS
  // -------------------------------------------------------------------------
  /** Every text-bearing table, WHOLE ROWS as `row_to_json(x)::text`, so no
   * Prisma projection and no column added next sprint can hide the string. */
  const sweepSql = async (needle: string): Promise<Array<{ t: string; n: number }>> => {
    const rows = await world.raw<Array<{ t: string; n: number }>>(SWEEP_SQL, needle);
    return rows.filter((r) => Number(r.n) > 0).map((r) => ({ t: r.t, n: Number(r.n) }));
  };

  /** The whole keyspace, every value type. An unreadable type is a FAILURE and
   * never a pass: «I could not read it» must not render as «it was clean». */
  const sweepRedis = async (needle: string): Promise<{ keys: number; hits: string[] }> => {
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL as string);
    try {
      const hits: string[] = [];
      let cursor = '0';
      let seen = 0;
      do {
        const [next, keys] = await client.scan(cursor, 'COUNT', 500);
        cursor = next;
        for (const key of keys as string[]) {
          seen += 1;
          const type = await client.type(key);
          let blob: string;
          switch (type) {
            case 'string':
              blob = (await client.get(key)) ?? '';
              break;
            case 'list':
              blob = (await client.lrange(key, 0, -1)).join(' ');
              break;
            case 'set':
              blob = (await client.smembers(key)).join(' ');
              break;
            case 'zset':
              blob = (await client.zrange(key, 0, -1)).join(' ');
              break;
            case 'hash':
              blob = Object.entries(await client.hgetall(key)).flat().join(' ');
              break;
            case 'none':
              blob = '';
              break;
            default:
              blob = `UNREADABLE:${type}`;
          }
          if (key.includes(needle) || blob.includes(needle) || blob.startsWith('UNREADABLE:')) {
            hits.push(`${key}[${type}]`);
          }
        }
      } while (cursor !== '0');
      return { keys: seen, hits };
    } finally {
      await client.quit();
    }
  };

  const assertReachedNothing = async (needle: string): Promise<void> => {
    expect(await sweepSql(needle)).toEqual([]);
    expect((await sweepRedis(needle)).hits).toEqual([]);
  };

  const childMessages = (h: GoldenHousehold): Promise<any[]> =>
    world.raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      h.familyId,
    );

  // =========================================================================
  // ACT 0 — THE INSTRUMENTS
  // =========================================================================
  describe('ACT 0 — measured before anything is concluded from it', () => {
    it('the search space is derived from the live catalogue and holds every table this chain can write', () => {
      expect(TABLES.length).toBeGreaterThan(60);
      for (const known of [
        'child_messages',
        'notifications',
        'notification_decisions',
        'notification_deliveries',
        'outbox_messages',
        'domain_events',
      ]) {
        expect(TABLES).toContain(known);
      }
    });

    it('the refused sentence is refused by the real CHILD policy, for SHAMING and not for length', () => {
      const band = ageBandFor(CHILD_AGE);
      for (const body of [UNSAFE_BODY, NIGHT_UNSAFE_BODY]) {
        const verdict = filter.validate(body, band);
        expect(verdict.isSafe).toBe(false);
        expect(verdict.reasons).toContain('SHAMING');
        expect(verdict.reasons).not.toContain('TOO_LONG');
      }
    });

    it('the control sentences are safe at the same band, markers attached', () => {
      for (const body of [SAFE_BODY, NIGHT_SAFE_BODY]) {
        expect(filter.validate(body, ageBandFor(CHILD_AGE)).reasons).toEqual([]);
      }
    });

    it('THE SWEEP CAN SEE A CHILD-ADDRESSED BODY — a canary in `child_messages` is found and then lost', async () => {
      const canary = `e2e17canary-${marker()}`;
      const id = randomUUID();
      await world.sys('write the sweep canary', () =>
        world.prisma.$executeRawUnsafe(
          `INSERT INTO "child_messages"
             ("id","family_id","child_id","author_type","category","title","body","approval_status","created_at")
           VALUES ($1::uuid,$2::uuid,$3::uuid,'AI','E2E17_CANARY','عنوان',$4,'PENDING',now())`,
          id,
          DAY.familyId,
          DAY.childId,
          canary,
        ),
      );
      expect(await sweepSql(canary)).toEqual([{ t: 'child_messages', n: 1 }]);
      await world.sys('remove the sweep canary', () =>
        world.prisma.$executeRawUnsafe(`DELETE FROM "child_messages" WHERE "id" = $1::uuid`, id),
      );
      expect(await sweepSql(canary)).toEqual([]);
    });

    it('THE REDIS SWEEP CAN SEE A VALUE — a canary key is found and then lost', async () => {
      const Redis = require('ioredis');
      const client = new Redis(process.env.REDIS_URL as string);
      const canary = `e2e17canary-${marker()}`;
      try {
        await client.set('e2e-17:canary', `cached body :: ${canary}`, 'EX', 60);
        const found = await sweepRedis(canary);
        expect(found.keys).toBeGreaterThan(0);
        expect(found.hits).toEqual(['e2e-17:canary[string]']);
        await client.del('e2e-17:canary');
        expect((await sweepRedis(canary)).hits).toEqual([]);
      } finally {
        await client.quit();
      }
    });
  });

  // =========================================================================
  // ACT I — THE REAL LOOP, WITH THE MODEL MISBEHAVING INSIDE IT
  // =========================================================================
  /**
   * Five real HTTP calls, the same five E2E-06's ACT I makes: the parent
   * creates a reward program, the CHILD starts and submits an achievement on
   * their own paired device, the outbox is turned, and the producer chain
   * fires both audiences. The only difference is that the model returns a
   * shaming sentence when it is handed the CHILD's copy.
   */
  describe('ACT I — a child earns a reward on their own device and the model returns shaming', () => {
    let childBodyOffered = '';

    it('the loop runs end to end over real HTTP, and the model really did misbehave on the child’s sentence', async () => {
      // POISON THE CHILD'S HALF ONLY. The discriminator is the AUDIENCE the
      // composer is rendering for, inferred from the sentence it offers: the
      // child's reward copy and the parent's are different strings from the
      // same catalogue. It is asserted to have fired below, so a discriminator
      // that stopped matching fails here rather than passing quietly.
      arm({
        unsafe: UNSAFE_BODY,
        safe: null,
        // `safe: null` makes the provider THROW for the parent's sentence,
        // which the composer already treats as «model failed, ship the
        // template» (§7). That keeps the parent's row deterministic and written
        // by the catalogue, and keeps this file from asserting anything about a
        // parent sentence it invented.
        poisonWhen: (req) => {
          const isChildCopy = /مكافأة|شارة|أحسنت|حصلت/.test(req.userMessage);
          if (isChildCopy) childBodyOffered = req.userMessage;
          return isChildCopy;
        },
      });

      const program = await request(world.http)
        .post(`${P}/reward-programs`)
        .set(asParent(DAY))
        .send({
          childId: DAY.childId,
          category: 'HOUSEWORK',
          activity: 'CHORE',
          targetSpec: { quantity: 1, unit: 'مهمة' },
          durationMinutes: 10,
          verificationLevel: 'SELF_CHECK',
          rewardSpec: { type: 'POINTS', amount: 10 },
        });
      expect([200, 201]).toContain(program.status);

      const started = await request(world.http)
        .post(`${P}/self/achievements/start`)
        .set(asChild(DAY))
        .send({ programId: program.body.id });
      const submitted = await request(world.http)
        .post(`${P}/self/achievements/${started.body.id}/submit`)
        .set(asChild(DAY))
        .send({ selfConfirmed: true });
      expect(submitted.body.status).toBe('VERIFIED');

      await world.drainOutbox();

      // THE MODEL WAS CONSULTED AND IT RETURNED THE SHAMING SENTENCE. Without
      // this the whole act could be green because nothing ever ran.
      expect(script.calls.length).toBeGreaterThan(0);
      expect(script.poisoned).toBeGreaterThan(0);
      expect(childBodyOffered).not.toBe('');
    });

    it('THE CHILD IS STILL TOLD — a row exists, in Arabic, inside their own band, and it is NOT the model’s sentence', async () => {
      const rows = await childMessages(DAY);
      // FAIL-CLOSED IS NOT FAIL-SILENT. A rejection that also dropped the
      // child's message would trade one defect for another: the child earned
      // the reward, and «we refused the model's wording» is not a reason to
      // tell them nothing.
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.body).not.toContain(UNSAFE_MARK);
        expect(row.body).not.toContain('كسول');
        expect(row.body).toMatch(/[ء-ي]/);
        expect(filter.validate(row.body, ageBandFor(CHILD_AGE)).isSafe).toBe(true);
        const ceiling = profileForAge(CHILD_AGE);
        expect(row.body.length).toBeLessThanOrEqual(ceiling.maxChars);
        expect(countWords(row.body)).toBeLessThanOrEqual(ceiling.maxWords);
      }
    });

    it('the decision row RECORDS the refusal by its closed reason code and carries the text in no column', async () => {
      const rows = await world.raw<Array<{ row: string }>>(
        `SELECT row_to_json(nd)::text AS row FROM "notification_decisions" nd
          WHERE nd."family_id" = $1::uuid AND nd."target_audience" = 'CHILD'`,
        DAY.familyId,
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      // A refusal must be COUNTED — a dashboard that cannot see it is a
      // dashboard that reports a healthy model.
      expect(rows.some((r) => r.row.includes('SHAMING'))).toBe(true);
      for (const r of rows) {
        // THE WHOLE ROW, every column, including the JSON explanation blob.
        expect(r.row).not.toContain(UNSAFE_MARK);
        expect(r.row).not.toContain('كسول');
      }
    });

    it('THE REFUSED SENTENCE IS IN NO TABLE AND IN NO CACHE — swept before and after the relay', async () => {
      await assertReachedNothing(UNSAFE_MARK);
      await world.drainOutbox();
      await assertReachedNothing(UNSAFE_MARK);
      await assertReachedNothing(UNSAFE_BODY);
    });

    it('AND THE CHILD’S OWN SURFACES ARE NOT BROKEN — the coach card and the inbox both answer with real content', async () => {
      // §11.2's reason for fail-closed in the first place: a child reading an
      // outage as their own fault is a product failure. So the two endpoints
      // the child app calls are exercised AFTER a refusal, on the device token.
      arm({ unsafe: UNSAFE_BODY, safe: null, poisonWhen: () => true });
      const card = await request(world.http).get(`${P}/self/coach/today`).set(asChild(DAY));
      expect(card.status).toBe(200);
      expect(typeof card.body.messageAr).toBe('string');
      expect(card.body.messageAr.trim().length).toBeGreaterThan(0);
      expect(card.body.messageAr).not.toContain(UNSAFE_MARK);
      expect(card.body.phrasedByAi).toBe(false);
      expect(filter.validate(card.body.messageAr, ageBandFor(CHILD_AGE)).isSafe).toBe(true);

      const inbox = await request(world.http)
        .get(`${P}/life-intelligence/self/messages`)
        .set(asChild(DAY));
      expect(inbox.status).toBe(200);
      expect(Array.isArray(inbox.body)).toBe(true);
    });

    it('AND THE DELIVERY END — the parent approves, the child reads it, and what crosses the wire is the safe sentence', async () => {
      const [message] = await childMessages(DAY);
      expect(message).toBeDefined();
      // §5.8's approval gate is real: until the parent acts the child sees
      // nothing, which is why the inbox above was allowed to be empty.
      const approved = await request(world.http)
        .post(`${P}/life-intelligence/communication/${DAY.childId}/${message.id}/approve`)
        .set(asParent(DAY))
        .send({});
      expect([200, 201]).toContain(approved.status);

      const inbox = await request(world.http)
        .get(`${P}/life-intelligence/self/messages`)
        .set(asChild(DAY));
      expect(inbox.status).toBe(200);
      const delivered = inbox.body.find((m: any) => m.id === message.id);
      expect(delivered).toBeDefined();
      // THE BYTES CHECKED ARE THE BYTES DELIVERED, read off the HTTP response
      // the child's device actually receives.
      expect(delivered.body).toBe(message.body);
      expect(JSON.stringify(inbox.body)).not.toContain(UNSAFE_MARK);
    });
  });

  // =========================================================================
  // ACT II — THE POSITIVE CONTROL, THROUGH THE SAME ENGINE
  // =========================================================================
  /**
   * WITHOUT THIS ACT, ACT I PROVES NOTHING. A sweep that returns zero because
   * the model's output could never have been stored on this path is a sweep
   * measuring its own irrelevance. So the SAME event type, for the SAME child,
   * through the SAME engine and the SAME tables, with a SAFE sentence — and the
   * sentence must be IN the rows ACT I asserted clean.
   */
  describe('ACT II — the same cause with a safe sentence writes the very rows ACT I asserted clean', () => {
    const key = `e2e17:${RUN_ID}:control`;
    /** Four hours on: past this type's 30-minute delivery cooldown, and still
     * three hours short of the family's quiet window. */
    const CONTROL_AT = goldenAt('16:00');

    it('the model’s own sentence is composed, delivered and stored', async () => {
      arm({ safe: SAFE_BODY, poisonWhen: () => false });

      const input: NotificationEventInput = {
        familyId: DAY.familyId,
        childId: DAY.childId,
        eventType: 'REWARD_GRANTED_CHILD',
        sourceEventId: key,
        trigger: 'DOMAIN_EVENT',
        now: CONTROL_AT,
      };
      const result = await runWithTenant(
        { familyId: DAY.familyId, actorType: 'SYSTEM', actorId: 'golden-e2e-17' },
        () => engine.handleEvent(input),
      );

      expect(result.decision.targetAudience).toBe('CHILD');
      expect(result.aiRewritten).toBe(true);
      expect(result.body).toBe(SAFE_BODY);
      // Named, so a future suppression is a stated failure rather than an empty
      // table somebody spends an afternoon on.
      expect(result.outcome?.decision).toBe('SEND');
    });

    it('and it is IN `child_messages` — the same table, the same column, the same tenant as the zero above', async () => {
      const rows = await world.raw<Array<{ row: string; body: string }>>(
        `SELECT row_to_json(m)::text AS row, m."body" AS body FROM "child_messages" m
          WHERE m."family_id" = $1::uuid AND m."source_event_id" LIKE $2`,
        DAY.familyId,
        `${key}%`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe(SAFE_BODY);
      expect(rows[0].row).toContain('"approval_status":"PENDING"');
      // THE INSTRUMENT THAT FOUND NOTHING IS THE INSTRUMENT THAT FINDS THIS.
      expect((await sweepSql(SAFE_MARK)).map((r) => r.t)).toContain('child_messages');
    });
  });

  // =========================================================================
  // ACT III — THE NIGHT PATH, AND THE SECOND TABLE THAT HOLDS A CHILD'S BODY
  // =========================================================================
  /**
   * `notification_deliveries` carries `title VARCHAR(200)` and `body
   * VARCHAR(500)` for a message addressed to a child, and it is written ONLY
   * when quiet hours defer one. Nothing on the immediate path touches it, so a
   * suite that only ever ran at noon would sweep it and find it empty for a
   * reason that has nothing to do with safety.
   *
   * THE TWO HALVES, AND BOTH ARE ASSERTED:
   *   AT NIGHT   the model returns shaming, the composer refuses it, and the
   *              row that waits until morning holds the CATALOGUE's sentence.
   *   IN THE MORNING the real release sweep runs and the child's message is
   *              still the catalogue's sentence — a deferral is not a second
   *              door around the gate.
   */
  describe('ACT III — quiet hours: the deferred row, and the morning release', () => {
    const rejectKey = `e2e17:${RUN_ID}:night-reject`;
    const controlKey = `e2e17:${RUN_ID}:night-control`;

    const fireAtNight = (sourceEventId: string) =>
      runWithTenant({ familyId: NIGHT.familyId, actorType: 'SYSTEM', actorId: 'golden-e2e-17' }, () =>
        engine.handleEvent({
          familyId: NIGHT.familyId,
          childId: NIGHT.childId,
          eventType: 'REWARD_GRANTED_CHILD',
          sourceEventId,
          trigger: 'DOMAIN_EVENT',
          now: CAIRO_NIGHT,
        }),
      );

    beforeAll(() => {
      jest.setSystemTime(CAIRO_NIGHT);
    });

    afterAll(() => {
      jest.setSystemTime(GOLDEN_NOON);
    });

    it('it really is quiet hours on THIS family’s own clock — read from the family row, not asserted by arithmetic', async () => {
      const [family] = await world.raw<Array<{ timezone: string }>>(
        `SELECT "timezone" FROM "families" WHERE "id" = $1::uuid`,
        NIGHT.familyId,
      );
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: family.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(CAIRO_NIGHT);
      expect(family.timezone).toBe('Africa/Cairo');
      expect(local >= '21:00' || local < '07:00').toBe(true);
    });

    it('the message is DEFERRED, not delivered — and the refused sentence is not in the row that waits', async () => {
      arm({ unsafe: NIGHT_UNSAFE_BODY, safe: null, poisonWhen: () => true });
      const result = await fireAtNight(rejectKey);

      expect(script.poisoned).toBeGreaterThan(0);
      expect(result.outcome?.decision).toBe('DEFER');

      const rows = await world.raw<Array<{ row: string; body: string; state: string }>>(
        `SELECT row_to_json(d)::text AS row, d."body" AS body, d."state" AS state
           FROM "notification_deliveries" d
          WHERE d."family_id" = $1::uuid AND d."source_event_id" LIKE $2`,
        NIGHT.familyId,
        `${rejectKey}%`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('PENDING');
      // THE WHOLE ROW. `notification_deliveries` also carries a `data` JSON
      // payload and a `last_error` column, and either would be a place for a
      // rejected sentence to survive the night.
      expect(rows[0].row).not.toContain(NIGHT_UNSAFE_MARK);
      expect(rows[0].row).not.toContain('كسول');
      expect(filter.validate(rows[0].body, ageBandFor(CHILD_AGE)).isSafe).toBe(true);
    });

    it('AND IT IS IN NO OTHER TABLE AND NO CACHE EITHER, while the night is still in progress', async () => {
      await assertReachedNothing(NIGHT_UNSAFE_MARK);
      await assertReachedNothing(NIGHT_UNSAFE_BODY);
    });

    it('POSITIVE CONTROL — a SAFE sentence at the same instant IS in the deferred row, so the queue really carries a body', async () => {
      arm({ safe: NIGHT_SAFE_BODY, poisonWhen: () => false });
      const result = await fireAtNight(controlKey);
      expect(result.outcome?.decision).toBe('DEFER');
      expect(result.body).toBe(NIGHT_SAFE_BODY);

      const rows = await world.raw<Array<{ body: string }>>(
        `SELECT d."body" AS body FROM "notification_deliveries" d
          WHERE d."family_id" = $1::uuid AND d."source_event_id" LIKE $2`,
        NIGHT.familyId,
        `${controlKey}%`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe(NIGHT_SAFE_BODY);
      expect((await sweepSql(NIGHT_SAFE_MARK)).map((r) => r.t)).toContain('notification_deliveries');
    });

    it('THE MORNING — the real release sweep runs, the queue resolves, and no row on either side of the night holds the refused sentence', async () => {
      jest.setSystemTime(CAIRO_MORNING);
      const report = await release.sweep(CAIRO_MORNING);
      expect(report.delivered).toBeGreaterThanOrEqual(1);

      /**
       * ONE MESSAGE, NOT TWO, AND THAT IS THE PRODUCT RULE RATHER THAN A LOSS.
       * Two rewards deferred overnight are COALESCED by the release sweep — a
       * child waking up to two near-identical cards is the fatigue defect this
       * queue exists to avoid. The count is therefore read from the QUEUE'S OWN
       * resolution rather than asserted as a number here, so a future change to
       * the coalescing rule fails on the rule and not on an arithmetic guess.
       */
      const queue = await world.raw<Array<{ row: string; state: string; body: string }>>(
        `SELECT row_to_json(d)::text AS row, d."state" AS state, d."body" AS body
           FROM "notification_deliveries" d
          WHERE d."family_id" = $1::uuid
          ORDER BY d."created_at"`,
        NIGHT.familyId,
      );
      expect(queue).toHaveLength(2);
      // EVERY row is resolved — nothing is left holding a body indefinitely.
      expect(queue.every((q) => ['DELIVERED', 'SUPPRESSED'].includes(q.state))).toBe(true);
      // AND NEITHER ROW — INCLUDING THE COALESCED ONE, WHOSE BODY STAYS IN THE
      // TABLE — CARRIES THE REFUSED SENTENCE, IN ANY COLUMN.
      for (const q of queue) {
        expect(q.row).not.toContain(NIGHT_UNSAFE_MARK);
        expect(q.row).not.toContain('كسول');
        expect(filter.validate(q.body, ageBandFor(CHILD_AGE)).isSafe).toBe(true);
      }

      const rows = await childMessages(NIGHT);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.body).not.toContain(NIGHT_UNSAFE_MARK);
        expect(row.body).not.toContain('كسول');
        expect(filter.validate(row.body, ageBandFor(CHILD_AGE)).isSafe).toBe(true);
      }
      // The control's sentence survived the night intact: the bytes checked at
      // 22:00 are the bytes stored at 07:30, which is the OTHER half of the
      // invariant holding across a deferral.
      expect(rows.some((r) => r.body === NIGHT_SAFE_BODY)).toBe(true);

      // AND A DEFERRAL IS NOT A SECOND DOOR.
      await world.drainOutbox();
      await assertReachedNothing(NIGHT_UNSAFE_MARK);
    });
  });

  // =========================================================================
  // ACT IV — THE WHOLE-RUN SWEEP
  // =========================================================================
  describe('ACT IV — after every act, after the relay: still nowhere', () => {
    it('neither refused sentence is in any derived table', async () => {
      await world.drainOutbox();
      expect(await sweepSql(UNSAFE_MARK)).toEqual([]);
      expect(await sweepSql(NIGHT_UNSAFE_MARK)).toEqual([]);
      expect(await sweepSql(UNSAFE_BODY)).toEqual([]);
      expect(await sweepSql(NIGHT_UNSAFE_BODY)).toEqual([]);
    });

    it('neither is in any Redis value, and the keyspace really was scanned', async () => {
      const swept = await sweepRedis(UNSAFE_MARK);
      expect(swept.hits).toEqual([]);
      expect(swept.keys).toBeGreaterThan(0);
      expect((await sweepRedis(NIGHT_UNSAFE_MARK)).hits).toEqual([]);
    });

    it('AND BOTH CONTROLS ARE STILL THERE — the zeros above were breakable', async () => {
      expect((await sweepSql(SAFE_MARK)).map((r) => r.t)).toContain('child_messages');
      const night = (await sweepSql(NIGHT_SAFE_MARK)).map((r) => r.t);
      expect(night).toContain('child_messages');
      expect(night).toContain('notification_deliveries');
    });
  });
});
