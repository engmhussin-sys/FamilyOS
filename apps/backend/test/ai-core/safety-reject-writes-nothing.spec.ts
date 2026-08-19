/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * `RW-000` — REJECT MEANS NO WRITE. THE HALF OF THE INVARIANT NOBODY RAN.
 * ============================================================================
 *
 * THE INVARIANT, IN FULL:
 *
 *     ANY text generated for a child:
 *       generate -> final transformation -> safety policy -> persistence -> delivery
 *     THE BYTES CHECKED MUST BE THE BYTES STORED AND DELIVERED.
 *     REJECT MEANS NO WRITE.
 *
 * WHAT WAS ALREADY PROVEN, AND BY WHAT.
 *
 *   «checked bytes == shipped bytes»  `test/ai-core/child-safety-invariant.spec.ts`
 *   «the gate is fail-closed»         `test/ai-core/child-safety-mutation.spec.ts`
 *                                     (11 invariants x 4 mutants)
 *
 * WHAT WAS NOT, AND THIS FILE IS THAT SENTENCE EXECUTED. «REJECT MEANS NO
 * WRITE» had exactly one assertion behind it:
 * `test/life-intelligence/child-safety-before-persistence.spec.ts` checks that
 * `createIfAbsent` is not CALLED on a refusal. That is a JEST MOCK, on ONE
 * repository, guarding ONE table, on ONE path. It cannot see a second table, a
 * second writer, an outbox row, a domain event, or a cache — and «nothing was
 * written» is a claim about the whole database, not about one mock's call
 * count.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS FILE ANSWERS IT: BY DERIVING THE SEARCH SPACE, NEVER BY LISTING IT.
 *
 * A hand-written table list is a list that rots, and this repository has
 * already shipped a probe that read as exhaustive while covering a third of its
 * surface. So the candidate set is READ OUT OF THE LIVE DATABASE at test time:
 * every `BASE TABLE` in `public` that has at least one text-bearing column
 * (`text` / `varchar` / `char` / `json` / `jsonb`). A table added by a migration
 * tomorrow is inside this sweep the moment it exists, with nobody editing this
 * file.
 *
 * AND EVERY ROW IS READ AS `row_to_json(x)::text`, the technique
 * `e2e-16-safety-escalation.golden.spec.ts` uses for the same reason: it is the
 * WHOLE ROW, every column of every type including JSON blobs, so no Prisma
 * projection, no `select`, and no column somebody adds next sprint can hide the
 * string from the assertion.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THAT KEEP THIS FROM BEING A TEST THAT PASSES BY DOING
 * NOTHING. All three are asserted, none is assumed:
 *
 *   1. THE SWEEP CAN SEE. Every act runs the sweep TWICE: once for the REJECTED
 *      text (must be 0 everywhere) and once for the SAFE text from the positive
 *      control (must be >= 1). A sweep that cannot find the safe sentence would
 *      not have found the unsafe one either, and the zero would mean nothing.
 *   2. THE PATH REALLY RAN. Every act has a positive control: the SAME call,
 *      the SAME service, the SAME database, with SAFE model output — and it
 *      must produce the rows the rejection is asserted not to produce.
 *   3. THE INPUT REALLY IS A REJECTION. ACT 0 measures the verdict on the real
 *      `ChildSafetyFilterService`. A fixture that quietly stopped being unsafe
 *      would pass this whole file by writing nothing at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL. Real PostgreSQL, real Redis, the real `AppModule`, the real
 * global HTTP pipeline, the real guards, the real device-bound token, the real
 * tenant extension. The ONE substitution is `AI_PROVIDER`, and it is the thing
 * under test rather than a stub of it: no Anthropic key exists in this
 * environment, and a suite about what happens when a MODEL RETURNS AN UNSAFE
 * SENTENCE must be able to make a model return an unsafe sentence. Every other
 * link — the filter, the composer, the communication service, the repository,
 * the tables — is the deployed one.
 *
 * THE CLOCK IS FROZEN (`freezeGoldenClock`): the family business date is part
 * of the coach card's seed and of the notification dedupe key.
 */
import { randomUUID } from 'node:crypto';

import request = require('supertest');

import {
  GOLDEN_NOON,
  P,
  goldenAt,
  bootGoldenWorld,
  describeGolden,
  freezeGoldenClock,
  type GoldenHousehold,
  type GoldenWorld,
} from '../golden/golden-world';
import { AI_PROVIDER, type IAIProviderRequest } from '../../src/modules/ai-core/domain/ai-provider.port';
import { ChildSafetyFilterService } from '../../src/modules/ai-core/application/services/child-safety-filter.service';
import { ageBandFor, countWords, profileForAge } from '../../src/modules/ai-core/domain/age-band';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import type { NotificationEventInput } from '../../src/modules/notification-engine/application/services/notification-context.assembler';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';

// ===========================================================================
// THE TWO SENTENCES, AND WHY EACH IS SHAPED THE WAY IT IS
// ===========================================================================
/**
 * A MARKER THAT SURVIVES EVERY TRANSFORMATION IN THE CHAIN.
 *
 * The sweep hunts for the marker as well as for the whole sentence, because a
 * leak does not have to be verbatim to be a leak: a truncated column, a
 * re-encoded JSON blob, a `substring(0,120)` in a log-ish table would all hide
 * the full sentence and keep the marker. Two independent markers — one per
 * sentence — so the SAFE control's own row can never be mistaken for a leak of
 * the UNSAFE one.
 *
 * ITS SHAPE IS CHOSEN AGAINST THE FILTER'S OWN RULES, not at random: `PII_LEAK`
 * refuses `\+?[0-9][0-9\s().-]{8,}[0-9]` (a phone) and a bare UUID, so the
 * marker is letter-led and carries a letter in the middle, which makes a
 * ten-digit run impossible. ACT 0 measures that the SAFE sentence really is
 * safe WITH the marker attached rather than trusting this paragraph.
 */
const marker = (): string => {
  const hex = randomUUID().replace(/-/g, '');
  return `zq${hex.slice(0, 5)}x${hex.slice(5, 10)}`;
};

const UNSAFE_MARK = marker();
const SAFE_MARK = marker();
/** Distinct from both markers: it labels this run's causal keys, nothing else. */
const RUN_ID = randomUUID().slice(0, 8);

/**
 * THE REJECTED SENTENCE. It is the ONE that has actually been measured landing
 * in `child_messages` verbatim (`F6-005`), plus a marker. `SHAMING`, not
 * `TOO_LONG`: a length rejection would prove the ceiling and not the content
 * rule, and the content rule is the one that reaches a child as an insult.
 */
const UNSAFE_BODY = `أنت كسول ولم تنجز شيئًا اليوم ${UNSAFE_MARK}`;
/** The positive control's sentence: in-band, warm, non-comparative Arabic. */
const SAFE_BODY = `أحسنت اليوم، خطوة جميلة نحو هدفك ${SAFE_MARK}`;

/** A title that is itself safe, so every act below isolates the BODY. */
const NEUTRAL_TITLE = 'رسالة';

/** The child is twelve: `12-14`, `maxWords` 15, `maxChars` 150. */
const CHILD_AGE = 12;

// ===========================================================================
// THE SCRIPTED PROVIDER — the one substitution, and it is the input under test
// ===========================================================================
interface ScriptedProvider {
  /** What the next `complete()` returns; `null` makes it throw. */
  next: string | null;
  calls: IAIProviderRequest[];
}

const script: ScriptedProvider = { next: null, calls: [] };

const resetScript = (next: string | null): void => {
  script.next = next;
  script.calls = [];
};

describeGolden('`RW-000` — a rejected child-facing sentence reaches NOTHING (real PostgreSQL, real Redis, real app)', () => {
  let world: GoldenWorld;
  let H: GoldenHousehold;
  let filter: ChildSafetyFilterService;
  let engine: SmartNotificationEngineService;

  /** Every text-bearing table in `public`, read from the live catalogue. */
  let TABLES: string[] = [];
  /** The single UNION ALL statement built from `TABLES`, built once. */
  let SWEEP_SQL = '';
  /**
   * The subset of `TABLES` that also carries a `family_id`, and the statement
   * that sweeps them for ONE household.
   *
   * WHY BOTH SWEEPS EXIST. The marker sweep is run-scoped and therefore
   * database-wide-safe: nothing else can have written this run's marker. But a
   * leak that TRUNCATED the sentence would drop the marker with it, so the
   * bare shaming word must be swept too — and that word is not run-scoped: it
   * is a fixture in other suites, and this database is shared and never reset.
   * Scoping by `family_id` makes the bare-word sweep answer the only question
   * it can honestly answer: «did THIS household's rejected sentence land
   * anywhere», rather than «has any suite ever written this word».
   */
  let FAMILY_TABLES: string[] = [];
  let FAMILY_SWEEP_SQL = '';

  const asParent = { get Authorization() { return `Bearer ${H.parentToken}`; } };
  const asChild = { get Authorization() { return `Bearer ${H.deviceToken}`; } };

  const rephraseWas = process.env.NOTIFICATION_AI_REPHRASE_ENABLED;

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    /**
     * THE REPHRASE FLAG IS ON FOR THIS SUITE, AND THAT IS THE POINT.
     * `NotificationComposerService` reads it per call; with it off the model is
     * never offered a sentence and ACT III would be asserting the emptiness of
     * a path that did not run. Restored in `afterAll`.
     */
    process.env.NOTIFICATION_AI_REPHRASE_ENABLED = 'true';

    world = await bootGoldenWorld('rw-000-reject-writes-nothing', (builder) =>
      builder.overrideProvider(AI_PROVIDER).useValue({
        complete: async (req: IAIProviderRequest): Promise<string> => {
          script.calls.push(req);
          if (script.next === null) throw new Error('RW-000: the script did not arm a reply');
          return script.next;
        },
      }),
    );

    const year = new Date().getUTCFullYear();
    H = await world.register('rw000', {
      childName: 'محمد',
      childDateOfBirth: `${year - CHILD_AGE}-01-05`,
      familyTimeZone: 'Africa/Cairo',
    });

    filter = world.app.get(ChildSafetyFilterService);
    engine = world.app.get(SmartNotificationEngineService);

    // ---- THE SEARCH SPACE, DERIVED. -------------------------------------
    // `::text` ON THE IDENTIFIER, AND IT IS NOT COSMETIC. `information_schema`
    // columns are PostgreSQL's `name` type, which the WASM query engine this
    // repository runs on cannot deserialize — the sweep failed on its own
    // catalogue read before it ever looked at a row.
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

    const tenanted = await world.raw<Array<{ table_name: string }>>(`
      SELECT c.table_name::text AS table_name
        FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.column_name = 'family_id'
       ORDER BY 1
    `);
    const tenantedNames = new Set(tenanted.map((r) => r.table_name));
    FAMILY_TABLES = TABLES.filter((t) => tenantedNames.has(t));
    FAMILY_SWEEP_SQL = FAMILY_TABLES.map(
      (t) =>
        `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}" x ` +
        `WHERE x."family_id"::text = $2 AND row_to_json(x)::text LIKE '%' || $1 || '%'`,
    ).join(' UNION ALL ');
  }, 300_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (rephraseWas === undefined) delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
    else process.env.NOTIFICATION_AI_REPHRASE_ENABLED = rephraseWas;
    if (world) await world.close();
  });

  // =========================================================================
  // THE SWEEPS
  // =========================================================================
  /**
   * EVERY TEXT-BEARING TABLE IN THE DATABASE, WHOLE ROWS, ONE STATEMENT.
   *
   * Returns the tables that contain the needle anywhere in any column. `LIKE
   * '%' || $1 || '%'` is PARAMETERISED rather than interpolated: the needle is
   * Arabic with a marker and a `%` or a quote in a future fixture must not
   * become SQL. The table names are interpolated because an identifier cannot
   * be a bind parameter — they come from `information_schema`, not from input.
   */
  const sweepSql = async (needle: string): Promise<Array<{ t: string; n: number }>> => {
    const rows = await world.raw<Array<{ t: string; n: number }>>(SWEEP_SQL, needle);
    return rows.filter((r) => Number(r.n) > 0).map((r) => ({ t: r.t, n: Number(r.n) }));
  };

  /**
   * THE WHOLE REDIS KEYSPACE, KEY AND VALUE, EVERY TYPE.
   *
   * The brief's instruction is to PROVE that nothing caches child text rather
   * than assume it, so this does not look in a known prefix: it SCANs the
   * keyspace this run produced and reads every value by its own type. A key
   * whose type this function does not know is reported as `UNREADABLE:<type>`
   * and fails the assertion below — «I could not read it» must never render as
   * «it was clean».
   */
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
              blob = (await client.lrange(key, 0, -1)).join(' ');
              break;
            case 'set':
              blob = (await client.smembers(key)).join(' ');
              break;
            case 'zset':
              blob = (await client.zrange(key, 0, -1)).join(' ');
              break;
            case 'hash':
              blob = Object.entries(await client.hgetall(key))
                .flat()
                .join(' ');
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

  /** The same sweep, narrowed to this household — see `FAMILY_SWEEP_SQL`. */
  const sweepFamily = async (needle: string): Promise<Array<{ t: string; n: number }>> => {
    const rows = await world.raw<Array<{ t: string; n: number }>>(
      FAMILY_SWEEP_SQL,
      needle,
      H.familyId,
    );
    return rows.filter((r) => Number(r.n) > 0).map((r) => ({ t: r.t, n: Number(r.n) }));
  };

  /** The whole assertion, in one sentence, so no act can forget half of it. */
  const assertReachedNothing = async (needle: string): Promise<void> => {
    expect(await sweepSql(needle)).toEqual([]);
    const redis = await sweepRedis(needle);
    expect(redis.hits).toEqual([]);
  };

  // =========================================================================
  // ACT 0 — THE FIXTURES ARE WHAT THEY CLAIM TO BE, AND THE SWEEP CAN SEE
  // =========================================================================
  describe('ACT 0 — the instruments, measured before anything is concluded from them', () => {
    it('the search space is DERIVED from the live catalogue and covers every table the chain can write', () => {
      // A derivation that silently returned two tables would make every zero
      // below meaningless, so the floor is asserted rather than trusted.
      expect(TABLES.length).toBeGreaterThan(60);
      // And the tables the brief names by hand are IN it — derived, then
      // cross-checked against the known surface, which is the opposite of
      // enumerating the known surface and hoping it is complete.
      for (const known of [
        'child_messages',
        'notifications',
        'notification_decisions',
        'notification_deliveries',
        'outbox_messages',
        'domain_events',
        'ai_alerts',
        'ai_memory_entries',
        'life_timeline_events',
      ]) {
        expect(TABLES).toContain(known);
      }
    });

    it('the REJECTED sentence really is rejected, by the real filter, at this child’s own band', () => {
      const band = ageBandFor(CHILD_AGE);
      const verdict = filter.validate(UNSAFE_BODY, band);
      expect(verdict.isSafe).toBe(false);
      // SHAMING and not TOO_LONG: the CONTENT rule is the one under test.
      expect(verdict.reasons).toContain('SHAMING');
      expect(verdict.reasons).not.toContain('TOO_LONG');
      expect(UNSAFE_BODY.length).toBeLessThanOrEqual(profileForAge(CHILD_AGE).maxChars);
      expect(countWords(UNSAFE_BODY)).toBeLessThanOrEqual(profileForAge(CHILD_AGE).maxWords);
    });

    it('the CONTROL sentence really is safe — marker attached, at the same band', () => {
      const verdict = filter.validate(SAFE_BODY, ageBandFor(CHILD_AGE));
      expect(verdict.reasons).toEqual([]);
      expect(verdict.isSafe).toBe(true);
    });

    it('THE SQL SWEEP CAN SEE A BODY — it finds a canary written into `child_messages` and loses it when the row goes', async () => {
      // Written through the REPOSITORY'S OWN TABLE, as a fixture, so what the
      // sweep is proven able to see is a real row in the real column a real
      // leak would land in — not a synthetic table this file invented.
      const canary = `rwcanary-${marker()}`;
      const id = randomUUID();
      await world.sys('write the sweep canary', () =>
        world.prisma.$executeRawUnsafe(
          `INSERT INTO "child_messages"
             ("id","family_id","child_id","author_type","category","title","body","approval_status","created_at")
           VALUES ($1::uuid,$2::uuid,$3::uuid,'AI','RW_CANARY','عنوان',$4,'PENDING',now())`,
          id,
          H.familyId,
          H.childId,
          canary,
        ),
      );
      expect(await sweepSql(canary)).toEqual([{ t: 'child_messages', n: 1 }]);

      await world.sys('remove the sweep canary', () =>
        world.prisma.$executeRawUnsafe(`DELETE FROM "child_messages" WHERE "id" = $1::uuid`, id),
      );
      expect(await sweepSql(canary)).toEqual([]);
    });

    it('THE REDIS SWEEP CAN SEE A VALUE — it finds a canary in the live keyspace and loses it when the key goes', async () => {
      const Redis = require('ioredis');
      const client = new Redis(process.env.REDIS_URL as string);
      const canary = `rwcanary-${marker()}`;
      try {
        await client.set('rw-000:canary', `some cached body :: ${canary}`, 'EX', 60);
        const found = await sweepRedis(canary);
        // The keyspace is non-empty and the canary is IN it: a scan that
        // returned zero keys would report «clean» for every needle forever.
        expect(found.keys).toBeGreaterThan(0);
        expect(found.hits).toEqual(['rw-000:canary[string]']);

        await client.del('rw-000:canary');
        expect((await sweepRedis(canary)).hits).toEqual([]);
      } finally {
        await client.quit();
      }
    });
  });

  // =========================================================================
  // ACT I — THE CHILD'S AI COACH CARD (`GET /self/coach/today`)
  // =========================================================================
  /**
   * THE PATH. `ChildCoachService.today` picks a human-written template, offers
   * it to the model for re-wording, and runs the model's answer back through
   * `ChildSafetyFilterService.chooseSafe`. It is a READ endpoint, so «reject
   * means no write» here is the strongest form of the claim: the rejected
   * sentence must not appear in the database OR IN THE CACHE, and the child
   * must still be handed a real card.
   */
  describe('ACT I — the AI coach card: the model returns shaming, and the child still gets a card', () => {
    let rejectedCard: any;

    it('the REJECTED variation ships nothing: the card is the human-written template, not the model’s sentence', async () => {
      resetScript(UNSAFE_BODY);
      const res = await request(world.http).get(`${P}/self/coach/today`).set(asChild);

      expect(res.status).toBe(200);
      // THE MODEL WAS REALLY CONSULTED. Without this the whole act could pass
      // because the provider was never reached.
      expect(script.calls).toHaveLength(1);
      expect(script.calls[0].sourceFeature).toBe('ai-core.child-coach');

      rejectedCard = res.body;
      expect(rejectedCard.messageAr).not.toContain(UNSAFE_MARK);
      expect(rejectedCard.messageAr).not.toContain('كسول');
      expect(rejectedCard.phrasedByAi).toBe(false);
    });

    it('AND THE CHILD IS NOT SHOWN A BROKEN OR EMPTY STATE — a real Arabic sentence, inside their own band', () => {
      expect(typeof rejectedCard.messageAr).toBe('string');
      expect(rejectedCard.messageAr.trim().length).toBeGreaterThan(0);
      expect(rejectedCard.messageAr).toMatch(/[ء-ي]/);
      expect(rejectedCard.ageBand).toBe(ageBandFor(CHILD_AGE));
      const ceiling = profileForAge(CHILD_AGE);
      expect(rejectedCard.messageAr.length).toBeLessThanOrEqual(ceiling.maxChars);
      expect(countWords(rejectedCard.messageAr)).toBeLessThanOrEqual(ceiling.maxWords);
      // And the card the child is handed is itself safe — a fallback that
      // failed its own filter would be the defect wearing the fix's clothes.
      expect(filter.validate(rejectedCard.messageAr, ageBandFor(CHILD_AGE)).isSafe).toBe(true);
    });

    it('THE REJECTED SENTENCE IS IN NO TABLE AND IN NO CACHE — every text-bearing table, whole rows, plus the whole keyspace', async () => {
      await assertReachedNothing(UNSAFE_MARK);
      await assertReachedNothing(UNSAFE_BODY);
    });

    it('POSITIVE CONTROL — the SAME call with a SAFE variation ships the model’s own sentence, so the path is live', async () => {
      resetScript(SAFE_BODY);
      const res = await request(world.http).get(`${P}/self/coach/today`).set(asChild);

      expect(res.status).toBe(200);
      expect(script.calls).toHaveLength(1);
      // The variation SHIPPED. This is what makes the rejection above a
      // rejection rather than a path that never had a candidate.
      expect(res.body.phrasedByAi).toBe(true);
      expect(res.body.messageAr).toBe(SAFE_BODY);
    });

    it('and the coach card CACHES NOTHING for either verdict — the safe sentence shipped and is in no table and no cache either', async () => {
      // The honest answer to «check Redis» on this path: the coach card is
      // computed per request and persisted nowhere, and that is asserted for
      // BOTH verdicts rather than assumed for the unsafe one. If a cache is
      // ever added here, the SAFE sweep goes red first — which is the right
      // order, because it is the one that costs no child anything.
      expect(await sweepSql(SAFE_MARK)).toEqual([]);
      expect((await sweepRedis(SAFE_MARK)).hits).toEqual([]);
    });
  });

  // =========================================================================
  // ACT II — THE PARENT'S AI DRAFT (`POST …/communication/:childId/ai-draft`)
  // =========================================================================
  /**
   * THE PATH THAT WRITES. This is the HTTP route behind
   * `FamilyCommunicationService.draftAiMessage`: the parent supplies a seed,
   * the model rewords it, and the result is written to `child_messages`. It is
   * the route `PG-001` was written for, and until this file the «nothing was
   * written» half of `PG-001`'s own refusal sentence had never been checked
   * against the table it names.
   */
  describe('ACT II — the AI draft route: the model returns shaming, and `child_messages` stays empty', () => {
    const CATEGORY = 'SET_SCREEN_TIME_POLICY';
    let refusal: any;

    const draft = (seedBody: string) =>
      request(world.http)
        .post(`${P}/life-intelligence/communication/${H.childId}/ai-draft`)
        .set(asParent)
        .send({ category: CATEGORY, title: NEUTRAL_TITLE, body: seedBody });

    it('the request is REFUSED, loudly, and the refusal names the policy, the band, the reason and the table', async () => {
      resetScript(UNSAFE_BODY);
      const res = await draft('أحسنت اليوم، واصل التقدم');

      // NOT SILENTLY SWALLOWED. A refusal the caller cannot distinguish from a
      // success is the failure mode `PE-N-001` had, and it cost the child half
      // of this product for months.
      expect(res.status).toBe(400);
      refusal = res.body;
      const said = JSON.stringify(refusal);
      expect(said).toContain('PG-001');
      expect(said).toContain('SHAMING');
      expect(said).toContain(ageBandFor(CHILD_AGE));
      expect(said).toContain('child_messages');
      // AND THE REJECTED TEXT IS NOT IN THE ERROR. The refused string is itself
      // the thing that tripped the filter; an error body that echoes it has
      // moved the unsafe sentence from a table into a log and a response.
      expect(said).not.toContain(UNSAFE_MARK);
      expect(said).not.toContain('كسول');
      // The model really was consulted — the rejection is of MODEL OUTPUT.
      expect(script.calls).toHaveLength(1);
    });

    it('THE REJECTED SENTENCE IS IN NO TABLE AND IN NO CACHE', async () => {
      await assertReachedNothing(UNSAFE_MARK);
      await assertReachedNothing(UNSAFE_BODY);
    });

    it('and there is no `child_messages` row at all for this cause — not a rejected one, not an empty one', async () => {
      const rows = await world.raw<any[]>(
        `SELECT row_to_json(m)::text AS row FROM "child_messages" m
          WHERE m."family_id" = $1::uuid AND m."category" = $2`,
        H.familyId,
        CATEGORY,
      );
      expect(rows).toHaveLength(0);
    });

    it('POSITIVE CONTROL — the SAME route with a SAFE variation writes exactly the row just asserted absent', async () => {
      resetScript(SAFE_BODY);
      const res = await draft('أحسنت اليوم، واصل التقدم');
      expect([200, 201]).toContain(res.status);

      const rows = await world.raw<Array<{ row: string }>>(
        `SELECT row_to_json(m)::text AS row FROM "child_messages" m
          WHERE m."family_id" = $1::uuid AND m."category" = $2`,
        H.familyId,
        CATEGORY,
      );
      expect(rows).toHaveLength(1);
      // The whole row, read back as JSON: the model's sentence IS the stored
      // body. Same table, same column, same tenant — so the zero above is a
      // zero this exact write would have broken.
      expect(rows[0].row).toContain(SAFE_MARK);
      // And the sweep — the same instrument that returned nothing for the
      // rejected text — finds it.
      expect((await sweepSql(SAFE_MARK)).map((r) => r.t)).toContain('child_messages');
      // Still behind the parent's approval gate: the control proves a WRITE,
      // never a bypass of §5.8.
      expect(rows[0].row).toContain('"approval_status":"PENDING"');
    });
  });

  // =========================================================================
  // ACT III — THE NOTIFICATION ENGINE, CHILD AUDIENCE
  // =========================================================================
  /**
   * THE LONGEST PATH, AND THE ONE WITH THE DECISION ROW.
   *
   *   handleEvent -> render template -> safety on the TEMPLATE -> model
   *     -> safety on the MODEL OUTPUT -> `notification_decisions` (always)
   *     -> deliverNow -> `child_messages`
   *
   * `NotificationComposerService` is FAIL-CLOSED here in the other direction
   * from `PG-001`: a rejected variation is not an error, it is the TEMPLATE
   * shipping. So this act asserts two things at once — the child still gets
   * their message, AND the sentence that was refused is in no column of the
   * decision row that records the refusal.
   */
  describe('ACT III — the engine: the model returns shaming, the template ships, the decision row records the reason and not the text', () => {
    const EVENT = 'REWARD_GRANTED_CHILD';
    /**
     * THE CAUSAL KEYS CARRY NEITHER MARKER, AND THAT IS NOT A DETAIL.
     *
     * The first draft of this file wrote `rw000:reject:${UNSAFE_MARK}` — and
     * the sweep dutifully reported `child_messages` and `notification_decisions`
     * as holding the marker, because they did: in `source_event_id`, put there
     * by this file. A sweep that hunts for a string must not be handed a
     * fixture that plants it. The run id below is unrelated to both markers.
     */
    const rejectKey = `rw000:${RUN_ID}:reject`;
    const controlKey = `rw000:${RUN_ID}:control`;

    const fire = (input: NotificationEventInput) =>
      runWithTenant({ familyId: H.familyId, actorType: 'SYSTEM', actorId: 'rw-000' }, () =>
        engine.handleEvent(input),
      );

    const event = (sourceEventId: string, now: Date): NotificationEventInput => ({
      familyId: H.familyId,
      childId: H.childId,
      eventType: EVENT,
      sourceEventId,
      trigger: 'DOMAIN_EVENT',
      now,
    });

    /**
     * THE CONTROL FIRES FOUR HOURS LATER, AND THAT IS A PRODUCT RULE RATHER
     * THAN A WORKAROUND.
     *
     * `evaluateFatigue`'s COOLDOWN is 30 minutes for this type, and the child's
     * inbox is its own history (`readChildInboxHistory`). Two `REWARD_GRANTED_CHILD`
     * events at the same frozen instant are, correctly, one notification and one
     * cooldown suppression — and a suppressed control writes nothing, which
     * would make it a control that proves nothing. 16:00 UTC is 19:00 in
     * Africa/Cairo: past the cooldown and still outside the 21:00 quiet window,
     * so the control exercises the SEND path the rejection was measured on.
     */
    const CONTROL_AT = goldenAt('16:00');

    let rejected: any;

    it('the engine still delivers — the child gets the catalogue’s own sentence, and the model’s is discarded', async () => {
      resetScript(UNSAFE_BODY);
      rejected = await fire(event(rejectKey, GOLDEN_NOON));

      expect(script.calls).toHaveLength(1);
      expect(script.calls[0].sourceFeature).toBe('notification-engine');
      expect(rejected.decision.targetAudience).toBe('CHILD');
      // FAIL-CLOSED, AND NOT FAIL-SILENT: the notification survives, the
      // sentence does not.
      expect(rejected.body).not.toContain(UNSAFE_MARK);
      expect(rejected.aiRewritten).toBe(false);
      expect(rejected.body.trim().length).toBeGreaterThan(0);
    });

    it('the decision row EXISTS and says a safety rejection happened — a refusal must be counted, not lost', async () => {
      const rows = await world.raw<Array<{ row: string }>>(
        `SELECT row_to_json(nd)::text AS row FROM "notification_decisions" nd
          WHERE nd."family_id" = $1::uuid AND nd."source_event_id" = $2`,
        H.familyId,
        rejectKey,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0].row;
      // THE CLOSED REASON CODE IS THERE …
      expect(row).toContain('SHAMING');
      // … AND THE TEXT IS NOT, IN ANY COLUMN OF THE WHOLE ROW. This is the
      // `row_to_json` assertion the brief asks for, and it is why no Prisma
      // `select` can hide a column from it.
      expect(row).not.toContain(UNSAFE_MARK);
      expect(row).not.toContain('كسول');
      expect(row).toContain('"ai_rewritten":false');
    });

    it('the child’s message row holds the TEMPLATE, and it is safe at the child’s own band', async () => {
      const rows = await world.raw<Array<{ row: string; body: string }>>(
        `SELECT row_to_json(m)::text AS row, m."body" AS body FROM "child_messages" m
          WHERE m."family_id" = $1::uuid AND m."source_event_id" LIKE $2`,
        H.familyId,
        `${rejectKey}%`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].row).not.toContain(UNSAFE_MARK);
      expect(filter.validate(rows[0].body, ageBandFor(CHILD_AGE)).isSafe).toBe(true);
    });

    it('THE REJECTED SENTENCE IS IN NO TABLE AND IN NO CACHE — including the outbox, the deliveries and the domain events', async () => {
      // Drained first, on purpose: an outbox row is a message that HAS NOT
      // SHIPPED YET, so sweeping before the relay runs would miss anything the
      // relay copies onward. Both sides of the drain are swept.
      await assertReachedNothing(UNSAFE_MARK);
      await world.drainOutbox();
      await assertReachedNothing(UNSAFE_MARK);
      await assertReachedNothing(UNSAFE_BODY);
    });

    it('POSITIVE CONTROL — the SAME event with a SAFE variation writes the model’s sentence into the very rows just asserted clean', async () => {
      resetScript(SAFE_BODY);
      const control = await fire(event(controlKey, CONTROL_AT));

      expect(script.calls).toHaveLength(1);
      expect(control.aiRewritten).toBe(true);
      // STATED, so that a future suppression is a named failure rather than an
      // empty table somebody spends an afternoon on.
      expect(control.outcome?.decision).toBe('SEND');
      expect(control.body).toBe(SAFE_BODY);

      const decision = await world.raw<Array<{ row: string }>>(
        `SELECT row_to_json(nd)::text AS row FROM "notification_decisions" nd
          WHERE nd."family_id" = $1::uuid AND nd."source_event_id" = $2`,
        H.familyId,
        controlKey,
      );
      expect(decision).toHaveLength(1);
      expect(decision[0].row).toContain('"ai_rewritten":true');

      const message = await world.raw<Array<{ body: string }>>(
        `SELECT m."body" AS body FROM "child_messages" m
          WHERE m."family_id" = $1::uuid AND m."source_event_id" LIKE $2`,
        H.familyId,
        `${controlKey}%`,
      );
      expect(message).toHaveLength(1);
      // THE BYTES CHECKED ARE THE BYTES STORED — and they are the model's, so
      // the engine's rejection above really did suppress a sentence that would
      // otherwise have landed in this exact column.
      expect(message[0].body).toBe(SAFE_BODY);
      expect((await sweepSql(SAFE_MARK)).map((r) => r.t)).toContain('child_messages');
    });
  });

  // =========================================================================
  // ACT IV — THE WHOLE-RUN SWEEP
  // =========================================================================
  /**
   * ONE FINAL SWEEP AFTER EVERY ACT HAS RUN AND THE OUTBOX HAS BEEN TURNED.
   *
   * The per-act sweeps run immediately after their own rejection, which is when
   * a synchronous leak would show. This one runs at the END, after the relay,
   * after the control writes, after every deferred effect this suite can
   * trigger — because a leak that appears one relay tick later is still a leak,
   * and it is the kind a per-act assertion cannot see.
   */
  describe('ACT IV — after everything: the rejected sentence is still nowhere, and the safe one is still somewhere', () => {
    it('the outbox is turned, and the rejected sentence is in none of the derived tables', async () => {
      await world.drainOutbox();
      const hits = await sweepSql(UNSAFE_MARK);
      // Named in the failure message: a leak must report WHICH table holds it.
      expect(hits).toEqual([]);
      expect(await sweepSql(UNSAFE_BODY)).toEqual([]);
    });

    it('AND THE BARE SHAMING WORD IS IN NO ROW OF THIS HOUSEHOLD — a leak that truncated the marker away is still a leak', async () => {
      // The marker sweeps above cannot see a column that stored the first
      // twenty characters and dropped the rest. This one can, and it is scoped
      // to the household because the word itself is a fixture in other suites
      // on this shared, never-reset database.
      expect(FAMILY_TABLES.length).toBeGreaterThan(30);
      expect(FAMILY_TABLES).toContain('child_messages');
      expect(FAMILY_TABLES).toContain('notification_decisions');
      expect(FAMILY_TABLES).toContain('notification_deliveries');
      expect(FAMILY_TABLES).toContain('outbox_messages');
      expect(FAMILY_TABLES).toContain('domain_events');
      expect(await sweepFamily('كسول')).toEqual([]);
      expect(await sweepFamily(UNSAFE_MARK)).toEqual([]);
      // AND THE HOUSEHOLD-SCOPED SWEEP CAN SEE: the safe control's rows are in
      // this family, so its zero above is a zero it was capable of breaking.
      expect((await sweepFamily(SAFE_MARK)).map((r) => r.t)).toContain('child_messages');
    });

    it('the rejected sentence is in no Redis value, and the keyspace really was scanned', async () => {
      const swept = await sweepRedis(UNSAFE_MARK);
      expect(swept.hits).toEqual([]);
      // NOT VACUOUS: this run's own throttle and session keys are in there, so
      // «no hits» is a statement about a keyspace that exists.
      expect(swept.keys).toBeGreaterThan(0);
    });

    it('AND THE CONTROLS ARE STILL THERE — the sweep that found nothing is the sweep that finds the safe rows', async () => {
      const safe = await sweepSql(SAFE_MARK);
      expect(safe.map((r) => r.t).sort()).toContain('child_messages');
      // Two acts wrote a safe body: the draft route and the engine control.
      const childMessages = safe.find((r) => r.t === 'child_messages');
      expect(childMessages!.n).toBeGreaterThanOrEqual(2);
    });
  });
});
