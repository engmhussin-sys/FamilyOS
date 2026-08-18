/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-13 — THE VERTICAL SLICE. ONE FAMILY, ONE PROCESS, END TO END.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS AND THE TWELVE BEFORE IT DO NOT COVER IT. Each of the
 * existing goldens owns a SLICE and owns it well: E2E-01 the reward loop from an
 * already-paired device, E2E-05 and E2E-06 the two halves of what a household is
 * told, E2E-12 the pairing lifecycle from a household that never earns anything.
 * Every one of them starts from a fixture that has already skipped the step
 * before it, and none of them ever registers a family into a REAL MARKET.
 *
 * So no test in this repository has ever executed the whole chain — the chain a
 * real household walks on the first day and the chain every commercial number
 * ABNY reports is derived from:
 *
 *   a parent registers in SAUDI ARABIA
 *     -> the server, not the client, chooses the family's calendar from that
 *        market («Asia/Riyadh», because every streak and every daily cap is
 *        counted on it)
 *     -> the parent adds a child and invites a device
 *     -> a SECOND actor with no token redeems the code, registers, attests,
 *        uploads its capabilities, and STOPS — because no device may confirm
 *        itself
 *     -> the parent confirms, and `GET /pairing/devices` (the route the parent
 *        app really polls) says ACTIVE
 *     -> the parent sets «حفظ سورة الملك، الآيات ١–٥، ٢٠ دقيقة، ٢٠ نقطة»
 *     -> the child's own phone shows it as today's goal, and the child can
 *        DISCOVER the QURAN domain in `GET /self/catalogue` — the route that
 *        did not exist until F1
 *     -> the child starts, works, and submits EVIDENCE. Never a result: there
 *        is no field on the request by which a child could state an outcome,
 *        and this scenario proves it by sending one and being refused
 *     -> the SERVER verifies, and for a Quran program the rule is
 *        PARENT_CONFIRMATION, so the honest answer is «escalate» and NOTHING is
 *        granted
 *     -> the parent confirms
 *     -> one ledger grant, one timeline entry, one PARENT notification and one
 *        CHILD notification — and the two sentences are DIFFERENT TEXT, because
 *        a product that sends one string to both is a broadcast, not a coach
 *     -> and an admin growth counter moves, ATTRIBUTED TO SAUDI ARABIA and not
 *        to Egypt, which is the only reason `families.country_code` exists
 *     -> then the completion is DELIVERED AGAIN, the way an at-least-once
 *        outbox really delivers it, and every one of those four numbers is
 *        still exactly one.
 *
 * EVERY COUNT IN THE PARAGRAPH ABOVE IS READ BACK OUT OF A TABLE WITH
 * `world.raw`, never from a returned object. A response body saying «granted: 1»
 * is the thing under test, not the evidence.
 *
 * NOTHING IS SUBSTITUTED. Real PostgreSQL, real Redis, real booted NestJS app
 * over real HTTP, real guards, real tokens, real outbox relay.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK, AND WHY IT IS FROZEN LATE RATHER THAN AT BOOT.
 *
 * Every other golden that asserts a notification freezes `Date` before it boots,
 * and for a good reason: a reward confirmed at 03:00 family-local is correctly
 * DEFERRED, so a suite on the wall clock would assert «one parent notification»
 * and be green in the afternoon and red at night. This scenario needs that
 * property too, and it takes it — from ACT III onwards.
 *
 * ACTS I AND II RUN ON THE REAL CLOCK, and the reason is a MEASURED DEFECT
 * rather than a preference. `PrismaPairingEventRepository.findLatest` resolves
 * «what state is this child's pairing in» with
 * `orderBy: { occurredAt: 'desc' }` and NO tiebreaker, over a
 * `timestamp(3)` column with a client-generated default. Two pairing events that
 * land in the same millisecond therefore leave the current state up to whatever
 * order PostgreSQL happens to return, and `PairingStateMachineService` then
 * evaluates the next transition against a state that may not be the newest one.
 *
 * A frozen `Date` makes EVERY event in the flow share one instant, so the whole
 * flow becomes a coin toss and the run this file was first written against
 * answered `409 CONFLICT` on `POST /pairing/device/register` from a household
 * that had just legitimately redeemed its code. That is not a test artefact
 * being worked around: it is the same race a production household hits whenever
 * two transitions commit inside one millisecond — which the three transitions
 * `PairingOrchestratorService.activate` performs back-to-back can easily do.
 * The finding is reported; the fix belongs to the pairing module (a monotonic
 * ordering column, or a deterministic tiebreaker), and no test may paper over it.
 *
 * So the pairing act runs on real time, `freezeGoldenClock` is called before
 * ACT III, and the household's rows are back-dated onto the golden day by
 * `ageTheHousehold` so that everything downstream is on the golden calendar
 * regardless.
 *
 * AND THE ASSERTIONS ON PAIRING STATE DO NOT ORDER BY TIME AT ALL. They walk the
 * transition table's own `from_state -> to_state` chain, which is deterministic
 * whatever the clock does — see `currentPairingState`.
 * ---------------------------------------------------------------------------
 */
import {
  GOLDEN_NOON,
  P,
  ageTheHousehold,
  asBearer,
  asParent,
  bootGoldenWorld,
  describeGolden,
  freezeGoldenClock,
  goldenAt,
  type GoldenHousehold,
  type GoldenWorld,
} from './golden-world';
import { countWords, profileForAge } from '../../src/modules/ai-core/domain/age-band';
import {
  hasEnumOrPlaceholderLeak,
  renderNotificationCopy,
} from '../../src/modules/notifications/domain/engine/notification-copy';

import request = require('supertest');

jest.setTimeout(240_000);

/**
 * THE MARKET THIS HOUSEHOLD IS IN, and the market it must never be counted in.
 * Both are seeded and ACTIVE in the `countries` catalogue (migration 0014), and
 * `families.country_code` is a REAL FOREIGN KEY onto it since 0022 — so an
 * unsupported code here fails the registration rather than being dropped.
 */
const THE_MARKET = 'SA';
const THE_OTHER_MARKET = 'EG';
/** `growth_settings.reporting.timezone.SA`, chosen by the SERVER from the country. */
const THE_MARKET_CALENDAR = 'Asia/Riyadh';

/**
 * THE ARABIC SENTENCE FOR THE GOAL, AND IT IS DERIVED ONCE, SERVER-SIDE.
 *
 * `RewardProgram.targetSummaryAr`, composed by `describeTargetSpec` from the
 * parent's own form and the real Quran table when the program is created. STEP 8
 * asserts the program row carries exactly this; every later assertion that a
 * sentence «names the achievement» is written against THIS CONSTANT rather than
 * against a re-typed string, because the whole product rule under test is that
 * three clients and two server surfaces read one derived summary instead of each
 * re-assembling Arabic out of a surah number and two ayah indices.
 */
const THE_TARGET_SUMMARY = 'الآيات 1–5 من سورة الملك';

/**
 * THE SAME SUMMARY, AS IT READS INSIDE ARABIC PROSE — `F1-003`.
 *
 * `describeTargetSpec` writes LATIN digits, and that stored value is still what
 * `reward_programs.target_summary_ar` and `notifications.data.goalTitle` carry
 * (a machine field is not prose — STEP 14 asserts both). But a rendered
 * SENTENCE may not mix scripts: «الآيات 1–5 … وحصل على ٢٠ نقطة» put two numeral
 * systems in one line, which is the «reads as a translation» failure
 * `PF-E-002` names. `substitute` now localises string variables for BOTH
 * audiences, so this is the form that reaches a human — parent or child — and
 * `THE_TARGET_SUMMARY` above stays the form that reaches a column.
 */
const THE_TARGET_SUMMARY_IN_PROSE = 'الآيات ١–٥ من سورة الملك';

/** The parent's form, field for field, exactly as the product brief words it. */
const THE_QURAN_GOAL = {
  category: 'QURAN',
  activity: 'QURAN_MEMORIZE_AYAH_RANGE',
  targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
  durationMinutes: 20,
  verificationLevel: 'PARENT_CONFIRMATION',
  rewardSpec: { type: 'POINTS', amount: 20 },
  frequency: 'DAILY',
  maxPerDay: 1,
  maxPerWeek: 7,
};

/** The device agent's own attestation payload, as the real Android agent sends it. */
const CLEAN_RISK_SIGNALS = {
  isEmulator: false,
  isRooted: false,
  hasTamperIndicators: false,
  isUnsupportedDevice: false,
  missingAttestation: false,
  mockLocationEnabled: false,
  developerModeEnabled: false,
  usbDebuggingEnabled: false,
  isOldAndroidVersion: false,
};

const CAPABILITY_SNAPSHOT = {
  manufacturer: 'Google',
  model: 'Pixel 7a',
  sdkInt: 34,
  agentVersion: '1.0.0',
};

/** What may never appear in a sentence a parent or a child reads. */
const RAW_ENUM = /[A-Z]{3,}_[A-Z_]+/;
const UNSUBSTITUTED_PLACEHOLDER = /[{}]|%s|\$\{/;
const A_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AN_HTTP_STATUS = /\b(200|201|204|400|401|403|404|409|422|429|500)\b/;
const ARABIC_LETTERS = /[؀-ۿ]/;
const WESTERN_DIGITS = /[0-9]/;
/** CONTEXT §3 principle 7, verbatim — the vocabulary that may not reach a child. */
const PUNITIVE_VOCABULARY = ['ممنوع', 'تجاوزت', 'فشلت', 'محظور', 'عقاب', 'خطأ منك'];

/** The four numbers this whole file exists to pin, all read from tables. */
interface SliceCounts {
  readonly rewardGrants: number;
  readonly timelineEvents: number;
  readonly childNotifications: number;
  readonly parentNotifications: number;
}

describeGolden('GOLDEN E2E-13 — one Saudi household, from registration to an admin counter, exactly once', () => {
  let world: GoldenWorld;
  let home: GoldenHousehold;

  /** Filled by the pairing act; used by every child request after it. */
  let deviceId = '';
  let deviceToken = '';
  let programId = '';
  let achievementId = '';

  /**
   * The FIRST_REWARD step of both markets' funnels, read BEFORE this household
   * had earned anything. The admin assertion is a DELTA and not an absolute:
   * these are cross-tenant counts over a shared database, and an absolute number
   * would be an assertion about every other suite that ever ran here.
   */
  let funnelBefore: { sa: number; eg: number };

  beforeAll(async () => {
    // NOT frozen yet — see the header. ACTS I and II pair a device for real, and
    // the pairing state machine's «latest event» read has no tiebreaker.
    world = await bootGoldenWorld('golden E2E-13 (vertical slice)');

    // A TWELVE-YEAR-OLD, expressed relative to the golden day rather than to a
    // real clock: the age is computed on the FAMILY's calendar, and the tone
    // band ('11-13') the child's sentence is composed in is derived from it.
    const year = Number(GOLDEN_NOON.toISOString().slice(0, 4));
    home = await world.register('e2e13', {
      childName: 'محمد',
      childDateOfBirth: `${year - 12}-01-05`,
      // STRAIGHT THROUGH TO `/auth/register`. No timezone is sent with it on
      // purpose — the country must be the thing that decides the calendar.
      countryCode: THE_MARKET,
    });
    // A family that started using ABNY this morning, not thirty seconds ago:
    // `evaluateActivation` GATE 3 refuses a completion inside 60 minutes of the
    // child row, because that is a parent demonstrating the app to somebody.
    await ageTheHousehold(world, home, goldenAt('08:00'));

    // THE SHORTCUT, REMOVED. `golden-world.ts` seeds a `Device` row directly and
    // says at the seeding site that the real pairing flow needs a second
    // physical actor. This scenario IS that second actor, so the shortcut goes —
    // and it must go, because leaving it would also trip the
    // `unlimited_devices_per_child` entitlement gate on the second device.
    await world.sys('remove the seeded shortcut device', () =>
      world.prisma.device.deleteMany({ where: { id: home.deviceId } }),
    );
  }, 240_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  // ==========================================================================
  // THE READERS. Every one of them goes to a TABLE.
  // ==========================================================================

  const scalar = async (sql: string, ...params: unknown[]): Promise<number> => {
    const rows = await world.raw<Array<{ n: number }>>(sql, ...params);
    return Number(rows[0].n);
  };

  /**
   * THE FOUR NUMBERS, from the four tables CONTEXT §5's chain ends in.
   *
   * Counted together in one function on purpose: the invariant is not «one
   * ledger row» — it is «one ledger row AND one timeline entry AND one parent
   * notification AND one child message», and four separate helpers would let
   * three of them drift.
   *
   * `countTheLoop` in `golden-world.ts` counts almost these four through Prisma.
   * This scenario reads the ROWS instead, with SQL, because the brief's whole
   * demand is that the replay be measured against the database and not against
   * an ORM cache or a returned object.
   */
  async function countTheSlice(): Promise<SliceCounts> {
    const [rewardGrants, timelineEvents, childNotifications, parentNotifications] = await Promise.all([
      scalar(
        `SELECT COUNT(*)::int AS n FROM "rewards_ledger_entries"
          WHERE "family_id" = $1::uuid AND "child_id" = $2::uuid AND "type" = 'EARN'`,
        home.familyId,
        home.childId,
      ),
      scalar(
        `SELECT COUNT(*)::int AS n FROM "life_timeline_events"
          WHERE "family_id" = $1::uuid AND "child_id" = $2::uuid AND "event_type" = 'reward_granted'`,
        home.familyId,
        home.childId,
      ),
      scalar(
        `SELECT COUNT(*)::int AS n FROM "child_messages"
          WHERE "family_id" = $1::uuid AND "child_id" = $2::uuid`,
        home.familyId,
        home.childId,
      ),
      scalar(
        `SELECT COUNT(*)::int AS n FROM "notifications"
          WHERE "family_id" = $1::uuid AND "child_id" = $2::uuid AND "type" = 'REWARD_GRANTED'`,
        home.familyId,
        home.childId,
      ),
    ]);
    return { rewardGrants, timelineEvents, childNotifications, parentNotifications };
  }

  const parentNotificationRow = async (): Promise<any> => {
    const [row] = await world.raw<any[]>(
      `SELECT * FROM "notifications"
        WHERE "family_id" = $1::uuid AND "type" = 'REWARD_GRANTED' ORDER BY "created_at", "id"`,
      home.familyId,
    );
    return row;
  };

  const childMessageRow = async (): Promise<any> => {
    const [row] = await world.raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      home.familyId,
    );
    return row;
  };

  const decisionRow = async (eventType: string): Promise<any> => {
    const [row] = await world.raw<any[]>(
      `SELECT * FROM "notification_decisions"
        WHERE "family_id" = $1::uuid AND "event_type" = $2 ORDER BY "created_at", "id"`,
      home.familyId,
      eventType,
    );
    return row;
  };

  /**
   * The child's pairing timeline as the TRANSITION TABLE's own edges, straight
   * out of PostgreSQL and with no ORDER BY anywhere.
   *
   * `e2e-12` reads this timeline `ORDER BY occurred_at DESC, id DESC`, which is
   * right for a suite on the real clock and is exactly the ordering the defect in
   * this file's header makes meaningless: `id` is a random UUID, so a
   * co-millisecond pair is ordered by nothing at all. An edge list needs no
   * clock — a state machine's history is a chain, and a chain knows its own head.
   */
  async function pairingEdges(): Promise<Array<{ from: string | null; to: string; event: string }>> {
    const rows = await world.raw<any[]>(
      `SELECT from_state, to_state, event_type FROM device_pairing_events WHERE child_id = $1::uuid`,
      home.childId,
    );
    return rows.map((r) => ({ from: r.from_state, to: r.to_state, event: r.event_type }));
  }

  /**
   * The head of the chain: the one state nothing has yet transitioned OUT of.
   *
   * SELF-LOOPS ARE EXCLUDED, and they are real rather than a quirk of this
   * helper: `DEVICE_TRUST_CHANGED` records a trust re-evaluation ON the state
   * the device is already in (`DEVICE_REGISTERED -> DEVICE_REGISTERED`), because
   * a trust level changing is a fact about the device and not a move through the
   * pairing machine. An edge that does not advance the machine cannot be the
   * thing that decides where the machine is.
   */
  async function currentPairingState(): Promise<string> {
    const progressing = (await pairingEdges()).filter((e) => e.from !== e.to);
    const departed = new Set(progressing.map((e) => e.from).filter((s): s is string => Boolean(s)));
    const heads = progressing.map((e) => e.to).filter((to) => !departed.has(to));
    // A pairing timeline with two heads is a forked state machine and must fail
    // loudly rather than let a caller pick one.
    expect(heads).toHaveLength(1);
    return heads[0];
  }

  async function deviceRow(id: string): Promise<any> {
    const rows = await world.raw<any[]>(
      `SELECT id, status, child_id, family_id, owner_type FROM devices WHERE id = $1`,
      id,
    );
    return rows[0];
  }

  /**
   * `FIRST_REWARD` — «households that reached their first real reward» — for one
   * market, through the ADMIN HTTP ROUTE the commercial dashboard consumes, with
   * the internal admin key. Not a repository call: the point of the step is that
   * the number a human reads moves.
   */
  async function firstRewardStep(countryCode: string): Promise<number> {
    const report = await request(world.http)
      .get(`${P}/admin/growth/funnel?countryCode=${countryCode}`)
      .set('x-internal-admin-key', process.env.INTERNAL_ADMIN_API_KEY as string);
    expect(report.status).toBe(200);
    expect(report.body.countryCode).toBe(countryCode);
    const step = (report.body.steps as any[]).find((s) => s.step === 'FIRST_REWARD');
    expect(step).toBeDefined();
    // The dashboard must be able to render a REPORTED number differently from a
    // MEASURED one, so the source travels with the count.
    expect(step.source).toBe('DOMAIN_TABLE');
    return step.count;
  }

  /**
   * Nothing a parent or a child reads may be a database value. Applied to BOTH
   * sentences, from one function, so the two audiences cannot drift apart on it.
   */
  function assertItReadsLikeASentence(text: string): void {
    expect(text).toMatch(ARABIC_LETTERS);
    expect(text).not.toMatch(RAW_ENUM);
    expect(text).not.toMatch(UNSUBSTITUTED_PLACEHOLDER);
    expect(text).not.toMatch(A_UUID);
    expect(text).not.toMatch(AN_HTTP_STATUS);
    expect(hasEnumOrPlaceholderLeak(text)).toBe(false);
    for (const id of [home.familyId, home.childId, deviceId, programId, achievementId]) {
      if (id) expect(text).not.toContain(id);
    }
  }

  // ==========================================================================
  // ACT I — STEPS 1 AND 2. A PARENT REGISTERS, IN A REAL MARKET.
  // ==========================================================================

  describe('ACT I — the household exists, and the server knows which market it is in', () => {
    it('STEP 1 — the parent registered over HTTP, and holds a token bound to their own family', async () => {
      expect(home.familyId).toBeTruthy();
      expect(home.ownerUserId).toBeTruthy();

      // The token is not taken on trust: it reaches a parent surface of THIS
      // family and returns this family's child.
      const children = await request(world.http).get(`${P}/children`).set(asParent(home));
      expect(children.status).toBe(200);
      expect((children.body as any[]).map((c) => c.id)).toContain(home.childId);
    });

    it('STEP 2 — the family carries countryCode SA, and the SERVER chose Asia/Riyadh from it', async () => {
      const [family] = await world.raw<any[]>(
        `SELECT "id", "country_code", "timezone" FROM "families" WHERE "id" = $1::uuid`,
        home.familyId,
      );

      // THE MARKET, on the row, backed by a foreign key onto `countries`.
      expect(family.country_code).toBe(THE_MARKET);

      /**
       * THE CALENDAR, AND WHY IT IS THE MARKET'S AND NOT `UTC`.
       *
       * `Family.timezone`'s schema default is `"UTC"`, and NOTHING in this
       * registration sent a timezone — the parent app has a country from the SIM
       * or the store front and no timezone picker. `CountryCatalogueService
       * .reconcileTimeZone` therefore derives the calendar from the country, and
       * it has to: every business date, every streak, every `maxPerDay` and
       * every reward idempotency key is computed on this column, so a Saudi
       * household on `UTC` has a day that ends three hours late and a streak
       * that breaks on a different night than its parent's calendar says.
       */
      expect(family.timezone).toBe(THE_MARKET_CALENDAR);
      expect(family.timezone).not.toBe('UTC');
    });

    it('STEP 2 — a household that names no market is honestly UNKNOWN, never defaulted into one', async () => {
      // The negative half, and it is the load-bearing one for every per-country
      // number below: `countryCode` is OMITTED here, and the column must stay
      // NULL rather than fall back to EG. A defaulted country would publish an
      // invented market fact as a measured one.
      const noMarket = await world.register('e2e13-nomarket');
      const [row] = await world.raw<any[]>(
        `SELECT "country_code" FROM "families" WHERE "id" = $1::uuid`,
        noMarket.familyId,
      );
      expect(row.country_code).toBeNull();
    });
  });

  // ==========================================================================
  // ACT II — STEPS 3 TO 7. THE CHILD, AND A DEVICE THAT PAIRS FOR REAL.
  // ==========================================================================

  describe('ACT II — the child gets a phone, the honest way', () => {
    let pairingCode = '';
    let registrationToken = '';

    it('STEP 3 — the child exists, and belongs to this family', async () => {
      const [child] = await world.raw<any[]>(
        `SELECT "id", "family_id", "first_name", "date_of_birth" FROM "children" WHERE "id" = $1::uuid`,
        home.childId,
      );
      expect(child.family_id).toBe(home.familyId);
      expect(child.first_name).toBe(home.childName);

      // And there is NO device yet — the shortcut was deleted in `beforeAll`, so
      // everything below is the real flow rather than a decorated fixture.
      expect(
        await scalar(`SELECT COUNT(*)::int AS n FROM devices WHERE family_id = $1::uuid`, home.familyId),
      ).toBe(0);
    });

    it('STEP 4 — the parent creates a pairing invitation, and the timeline opens', async () => {
      const invited = await request(world.http)
        .post(`${P}/pairing/invite`)
        .set(asParent(home))
        .send({ childId: home.childId });

      expect(invited.status).toBe(200);
      // SERVER-GENERATED and short enough for a child to type off a screen.
      expect(invited.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(invited.body.expiresInSeconds).toBe(600);
      pairingCode = invited.body.code;

      expect(await pairingEdges()).toEqual([
        { from: null, to: 'INVITATION_SENT', event: 'PAIRING_INVITED' },
      ]);
    });

    it('STEP 5 — the child device redeems the code with NO token at all', async () => {
      // No Authorization header: this is the AUTH_BOOTSTRAP surface and the
      // family is resolved FROM the code, server-side. A device that has never
      // met this backend has nothing else to present.
      const accepted = await request(world.http).post(`${P}/pairing/accept`).send({ code: pairingCode });

      expect(accepted.status).toBe(200);
      expect(typeof accepted.body.token).toBe('string');
      expect(accepted.body.expiresInSeconds).toBe(300);
      registrationToken = accepted.body.token;
      expect(await currentPairingState()).toBe('AUTHENTICATING');

      // ONE-TIME, and it is one atomic `getAndDelete` rather than a window a
      // race could widen.
      const replayed = await request(world.http).post(`${P}/pairing/accept`).send({ code: pairingCode });
      expect(replayed.status).toBe(401);
      expect((await pairingEdges()).filter((e) => e.to === 'AUTHENTICATING')).toHaveLength(1);
    });

    it('STEP 6 — the device registers, verifies, uploads capabilities, and STOPS', async () => {
      const registered = await request(world.http)
        .post(`${P}/pairing/device/register`)
        .set(asBearer(registrationToken))
        .send({
          publicKey: 'GOLDEN-E2E-13-KEYSTORE-PUBLIC-KEY',
          platform: 'ANDROID',
          deviceModel: 'Pixel 7a',
          osVersion: '14',
          appVersion: '1.0.0',
          pairingProtocolVersion: '1',
        });
      expect(registered.status).toBe(201);
      deviceId = registered.body.deviceId;
      deviceToken = registered.body.tokens.accessToken;
      expect(deviceId).toBeTruthy();
      expect(deviceToken).toBeTruthy();
      expect((await deviceRow(deviceId)).status).toBe('PENDING_PAIRING');
      expect(await currentPairingState()).toBe('DEVICE_REGISTERED');

      const verified = await request(world.http)
        .post(`${P}/pairing/verify`)
        .set(asBearer(deviceToken))
        .send({
          attestationChain: 'golden-e2e-13-attestation-chain',
          pairingCapabilitySnapshot: CAPABILITY_SNAPSHOT,
          riskSignals: CLEAN_RISK_SIGNALS,
        });
      expect(verified.status).toBe(200);
      expect(verified.body.trustLevel).toBe('L3_ATTESTED');
      expect(verified.body.riskAssessment.overallLevel).toBe('LOW');

      // THE STALL. Everything the DEVICE can do is done and the device is still
      // unusable: the next transition is PARENT_CONFIRMED(USER), and no device
      // may fire it. The child surface is closed until a human says otherwise.
      expect(await currentPairingState()).toBe('CAPABILITIES_UPLOADED');
      expect((await deviceRow(deviceId)).status).toBe('PENDING_PAIRING');
      const tooEarly = await request(world.http)
        .get(`${P}/self/achievements/today`)
        .set(asBearer(deviceToken));
      expect(tooEarly.status).toBe(403);
    });

    it('STEP 6 — the PARENT confirms, and one call carries the device to ACTIVATED', async () => {
      const activated = await request(world.http)
        .post(`${P}/pairing/activate`)
        .set(asParent(home))
        .send({ deviceId });

      expect(activated.status).toBe(200);
      expect(activated.body.status).toBe('ACTIVATED');

      // ALL THREE transitions from ONE request, asserted as the EDGES the
      // transition table specifies rather than as a timestamp ordering. The two
      // SYSTEM steps have no client actor, so an endpoint for them would be an
      // activation that stalls whenever that client crashes.
      const edges = await pairingEdges();
      expect(edges).toContainEqual({
        from: 'CAPABILITIES_UPLOADED',
        to: 'PARENT_CONFIRMED',
        event: 'PARENT_CONFIRMED',
      });
      expect(edges).toContainEqual({
        from: 'PARENT_CONFIRMED',
        to: 'POLICY_ASSIGNED',
        event: 'POLICY_ASSIGNED',
      });
      expect(edges).toContainEqual({
        from: 'POLICY_ASSIGNED',
        to: 'ACTIVATED',
        event: 'DEVICE_ACTIVATED',
      });
      expect(await currentPairingState()).toBe('ACTIVATED');

      // THE WHOLE WALK, ONCE EACH. Written out as the complete set of edges that
      // ADVANCE the machine, so a regression names exactly which transition
      // appeared, vanished or repeated. Order is normalised away on purpose —
      // the chain is the assertion, and the chain is what the clock cannot
      // disturb.
      const progressing = edges
        .filter((e) => e.from !== e.to)
        .map((e) => `${e.from ?? '∅'}--${e.event}-->${e.to}`)
        .sort();
      expect(progressing).toEqual(
        [
          '∅--PAIRING_INVITED-->INVITATION_SENT',
          'INVITATION_SENT--PAIRING_ACCEPTED-->AUTHENTICATING',
          'AUTHENTICATING--DEVICE_REGISTERED-->DEVICE_REGISTERED',
          'DEVICE_REGISTERED--DEVICE_VERIFIED-->DEVICE_VERIFIED',
          'DEVICE_VERIFIED--CAPABILITIES_UPLOADED-->CAPABILITIES_UPLOADED',
          'CAPABILITIES_UPLOADED--PARENT_CONFIRMED-->PARENT_CONFIRMED',
          'PARENT_CONFIRMED--POLICY_ASSIGNED-->POLICY_ASSIGNED',
          'POLICY_ASSIGNED--DEVICE_ACTIVATED-->ACTIVATED',
        ].sort(),
      );
      // And every edge that did NOT advance the machine is a trust
      // re-evaluation — nothing else is allowed to sit still on this timeline.
      for (const loop of edges.filter((e) => e.from === e.to)) {
        expect(loop.event).toBe('DEVICE_TRUST_CHANGED');
      }
    });

    it('STEP 7 — the parent sees the device ACTIVE on GET /pairing/devices, the route the app polls', async () => {
      const listed = await request(world.http).get(`${P}/pairing/devices`).set(asParent(home));

      expect(listed.status).toBe(200);
      const mine = (listed.body as any[]).find((d) => d.id === deviceId);
      expect(mine).toBeDefined();
      // The list and the ROW agree — `status` here is not a column nobody reads.
      expect(mine.status).toBe('ACTIVE');
      expect((await deviceRow(deviceId)).status).toBe('ACTIVE');
      expect(mine.childFirstName).toBe(home.childName);
      expect(mine.trustLevel).toBe('L3_ATTESTED');

      // And the paired child can now actually USE the product.
      const today = await request(world.http).get(`${P}/self/achievements/today`).set(asBearer(deviceToken));
      expect(today.status).toBe(200);
    });
  });

  // ==========================================================================
  // ACT III — STEPS 8 TO 10. THE GOAL, AND THE CHILD DISCOVERING IT.
  // ==========================================================================

  describe('ACT III — the parent sets a goal, and the child can both see it and browse for more', () => {
    beforeAll(async () => {
      /**
       * THE CLOCK IS TAKEN OVER HERE, at midday on the golden day, so that the
       * reward the parent confirms in ACT IV is DELIVERED rather than correctly
       * deferred past 21:00 Asia/Riyadh. The pairing act above needed real time;
       * everything from here is a scenario about notifications, business days
       * and caps, and every one of those is a function of the wall clock.
       */
      freezeGoldenClock(GOLDEN_NOON);

      // The BASELINE for STEP 16, taken now — under the same frozen clock the
      // «after» reading will use, so the two funnel windows are the same window
      // and the comparison is a delta rather than two different questions.
      funnelBefore = {
        sa: await firstRewardStep(THE_MARKET),
        eg: await firstRewardStep(THE_OTHER_MARKET),
      };
    }, 120_000);

    it('STEP 8 — «حفظ سورة الملك، الآيات ١–٥، ٢٠ دقيقة، ٢٠ نقطة», and the server checks the Quran itself', async () => {
      const created = await request(world.http)
        .post(`${P}/reward-programs`)
        .set(asParent(home))
        .send({ childId: home.childId, ...THE_QURAN_GOAL });

      expect([200, 201]).toContain(created.status);
      programId = created.body.id;

      // It reads back as a SENTENCE. The parent typed a surah number and a
      // range; they expect to see a surah and a range.
      expect(created.body.category).toBe('QURAN');
      expect(created.body.targetSummaryAr).toBe(THE_TARGET_SUMMARY);
      expect(created.body.durationMinutes).toBe(20);
      expect(created.body.rewardSpec).toMatchObject({ type: 'POINTS', amount: 20 });
      expect(created.body.verificationLevel).toBe('PARENT_CONFIRMATION');

      // A goal the server could not honour is worse than no goal: Al-Mulk has
      // thirty ayat, and a program promising ayah 300 lies to the child on day one.
      const impossible = await request(world.http)
        .post(`${P}/reward-programs`)
        .set(asParent(home))
        .send({
          childId: home.childId,
          ...THE_QURAN_GOAL,
          targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 300 },
        });
      expect(impossible.status).toBe(400);
      expect(JSON.stringify(impossible.body)).toContain('AYAH_OUT_OF_SURAH');

      // NOTHING has been earned by creating a goal.
      expect(await countTheSlice()).toEqual({
        rewardGrants: 0,
        timelineEvents: 0,
        childNotifications: 0,
        parentNotifications: 0,
      });
    });

    it('STEP 9 — the child sees it as TODAY\'S goal, from the child\'s own device token', async () => {
      const today = await request(world.http).get(`${P}/self/achievements/today`).set(asBearer(deviceToken));

      expect(today.status).toBe(200);
      const mine = (today.body as any[]).find(
        (entry) => entry.programId === programId || entry.id === programId,
      );
      expect(mine).toBeDefined();
      // «available», plus a reason when it is not: the child app must be able to
      // EXPLAIN, never just fail on tap (CONTEXT §3 principle 7).
      expect(mine.available).toBe(true);
      expect(JSON.stringify(mine)).toContain('سورة الملك');
    });

    it('STEP 10 — the child BROWSES GET /self/catalogue and finds the QURAN domain', async () => {
      const catalogue = await request(world.http).get(`${P}/self/catalogue`).set(asBearer(deviceToken));

      expect(catalogue.status).toBe(200);
      // The age is the SERVER's, computed from `dateOfBirth` on the family's own
      // calendar — the same number `checkProgramEligibility` will compare
      // against `minAge` when the child starts something.
      expect(catalogue.body.child.ageYears).toBe(12);
      /**
       * TWO BANDS FOR ONE CHILD, AND THEY ARE DELIBERATELY DIFFERENT.
       *
       * The catalogue reports the SAFETY band from `ai-core/domain/age-band.ts`
       * (`ageBandFor(12) === '12-14'`), which is the band whose `maxWords` /
       * `maxChars` ceiling any child-facing sentence must fit under. The
       * notification engine records the TONE band from `notification-tone.ts`
       * (`toneBandFor(12) === '11-13'`), which is the register the sentence is
       * WRITTEN in, and whose profile names `'12-14'` as its own strictest
       * safety band precisely so the two cannot drift.
       *
       * Both are asserted here, together, because a reader who saw only one
       * would reasonably conclude the other was a bug — and because a future
       * change that collapsed them would have to come here and say so.
       */
      expect(catalogue.body.child.ageBand).toBe('12-14');
      expect(catalogue.body.child.ageBandLabelAr).toBe('من ١٢ إلى ١٤ سنة');
      expect(catalogue.body.child.ageBandLabelAr).toMatch(ARABIC_LETTERS);

      const quran = (catalogue.body.domains as any[]).find((d) => d.code === 'QURAN');
      expect(quran).toBeDefined();
      expect(quran.labelAr).toBe('قرآن');
      expect(quran.items.length).toBeGreaterThan(0);
      // SUGGESTED at twelve, and — because nothing is ever hidden from a child —
      // every domain is returned, annotated rather than removed.
      expect(quran.suitability.suggestedAtThisAge).toBe(true);
      expect(quran.suitability.hidden).toBe(false);
      for (const domain of catalogue.body.domains as any[]) {
        expect(domain.suitability.hidden).toBe(false);
        expect(domain.labelAr).toMatch(ARABIC_LETTERS);
        expect(domain.suitability.noteAr).toMatch(ARABIC_LETTERS);
        // Not one raw enum reaches the child's screen: `code` is the machine
        // field and `labelAr` is what is rendered beside it.
        expect(domain.labelAr).not.toMatch(RAW_ENUM);
      }

      // The activity the parent's goal is built from is discoverable BY NAME.
      const memorise = (quran.items as any[]).find(
        (item) => item.activityCode === 'QURAN_MEMORIZE_AYAH_RANGE',
      );
      expect(memorise).toBeDefined();
      expect(memorise.titleAr).toMatch(ARABIC_LETTERS);
      // AND A CHILD CANNOT PROPOSE THEIR OWN REWARD. Every value here is derived
      // from one server-computed integer; there is no argument on this surface
      // through which a caller could raise it.
      expect(memorise.reward.suggestedAmount).toBe(30);
      expect(memorise.requiresParentApproval).toBe(true);

      // The chooser row alone, derived from the same projection so the two
      // routes cannot disagree about which domains exist or in what order.
      const domains = await request(world.http)
        .get(`${P}/self/catalogue/domains`)
        .set(asBearer(deviceToken));
      expect(domains.status).toBe(200);
      expect((domains.body.domains as any[]).map((d) => d.code)).toEqual(
        (catalogue.body.domains as any[]).map((d) => d.code),
      );
      expect((domains.body.domains as any[])[0].items).toBeUndefined();
    });

    it('STEP 10 — the catalogue is CHILD-ONLY, and a parent token cannot reach it', async () => {
      // The two token families are not interchangeable: `DeviceJwtAuthGuard` is
      // the 'device-jwt' strategy, and this is refused at the transport before
      // any handler or role check runs.
      const asTheParent = await request(world.http).get(`${P}/self/catalogue`).set(asParent(home));
      expect(asTheParent.status).toBe(401);
    });
  });

  // ==========================================================================
  // ACT IV — STEPS 11 TO 13. EVIDENCE, ESCALATION, CONFIRMATION, GRANT.
  // ==========================================================================

  describe('ACT IV — the child works, the server refuses to decide, the parent decides', () => {
    it('STEP 11 — the child STARTS the goal and receives an attempt, not a reward', async () => {
      const started = await request(world.http)
        .post(`${P}/self/achievements/start`)
        .set(asBearer(deviceToken))
        .send({ programId });

      expect([200, 201]).toContain(started.status);
      achievementId = started.body.id;
      expect(started.body.status).toBe('IN_PROGRESS');

      await world.drainOutbox();
      const counts = await countTheSlice();
      expect(counts.rewardGrants).toBe(0);
      expect(counts.parentNotifications).toBe(0);
    });

    it('STEP 11 — a child cannot STATE A RESULT: there is no field for one, and sending one is a 400', async () => {
      // The strongest available form of «submits evidence, never a result».
      // `main.ts` runs `forbidNonWhitelisted: true` and `SubmitAchievementDto`
      // has no outcome field, so this is refused at the pipeline — the claim is
      // structural rather than policed inside a service.
      const claimed = await request(world.http)
        .post(`${P}/self/achievements/${achievementId}/submit`)
        .set(asBearer(deviceToken))
        .send({ foregroundMinutes: 21, result: 'VERIFIED', status: 'VERIFIED' });

      expect(claimed.status).toBe(400);
      expect(claimed.body.code).toBe('VALIDATION_FAILED');
      // And the refusal wrote nothing: the attempt ledger is still empty.
      expect(
        await scalar(
          `SELECT COUNT(*)::int AS n FROM "verification_attempts" WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      ).toBe(0);
    });

    it('STEP 12 — the child SUBMITS evidence, the SERVER escalates, and NOTHING is granted', async () => {
      const submitted = await request(world.http)
        .post(`${P}/self/achievements/${achievementId}/submit`)
        .set(asBearer(deviceToken))
        .send({ foregroundMinutes: 21, note: 'حفظت الآيات' });

      expect(submitted.status).toBe(201);
      // THE SERVER DECIDED. A Quran program's rule is PARENT_CONFIRMATION, so
      // the honest answer is «escalate» — the child stated evidence and the
      // server stated the outcome, and there is no field by which those swap.
      expect(submitted.body.status).toBe('PENDING_PARENT');
      expect(submitted.body.outcome.result).toBe('ESCALATED');
      expect(submitted.body.outcome.reasonCode).toBe('AWAITING_PARENT');

      // The attempt is recorded as append-only evidence of what the server decided.
      expect(
        await scalar(
          `SELECT COUNT(*)::int AS n FROM "verification_attempts" WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      ).toBe(1);

      await world.drainOutbox();
      expect(await countTheSlice()).toEqual({
        rewardGrants: 0,
        timelineEvents: 0,
        childNotifications: 0,
        parentNotifications: 0,
      });
    });

    it('STEP 13 — the parent confirms, and EXACTLY ONE of each thing happens', async () => {
      const approved = await request(world.http)
        .post(`${P}/reward-programs/achievements/${achievementId}/approve`)
        .set(asParent(home))
        .send({});
      expect([200, 201]).toContain(approved.status);

      await world.drainOutbox();

      const [achievement] = await world.raw<any[]>(
        `SELECT "status" FROM "achievement_requests" WHERE "id" = $1::uuid`,
        achievementId,
      );
      expect(achievement.status).toBe('VERIFIED');

      // THE LEDGER — one row, twenty points, carrying the causal key that makes
      // it unrepeatable under `rewards_ledger_entries (child_id, idempotency_key)`.
      const entries = await world.raw<any[]>(
        `SELECT * FROM "rewards_ledger_entries"
          WHERE "family_id" = $1::uuid AND "child_id" = $2::uuid AND "type" = 'EARN'`,
        home.familyId,
        home.childId,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].amount).toBe(20);
      expect(entries[0].delta).toBe(20);
      // «نقطة» is the product word, `XP` is the ledger word; one number, not two
      // economies (`reward-spec.ts`, the REUSE decision of Sprint F4).
      expect(entries[0].reward_type).toBe('XP');
      expect(String(entries[0].idempotency_key)).toContain(':achv:');
      // The grant is stamped on THIS FAMILY'S business day — the Riyadh one.
      expect(entries[0].business_date).not.toBeNull();

      expect(await countTheSlice()).toEqual({
        rewardGrants: 1,
        timelineEvents: 1,
        childNotifications: 1,
        parentNotifications: 1,
      });
    });

    it('STEP 13 — the balance the child actually sees moved by twenty, and by nothing else', async () => {
      const account = await request(world.http)
        .get(`${P}/life-intelligence/self/rewards/account`)
        .set(asBearer(deviceToken));

      expect(account.status).toBe(200);
      expect(account.body.xp).toBe(20);
    });

    it('STEP 13 — nothing was stranded: every outbox message for this family reached PUBLISHED', async () => {
      expect(
        await scalar(
          `SELECT COUNT(*)::int AS n FROM "outbox_messages"
            WHERE "family_id" = $1::uuid AND "status" <> 'PUBLISHED'`,
          home.familyId,
        ),
      ).toBe(0);
    });
  });

  // ==========================================================================
  // ACT V — STEPS 14 AND 15. TWO AUDIENCES, TWO SENTENCES, ONE TIMELINE.
  // ==========================================================================

  describe('ACT V — what the household is told, and what is written into the child\'s life', () => {
    it('STEP 14 — the parent and the child are BOTH told, and they are told DIFFERENT THINGS', async () => {
      const parent = await parentNotificationRow();
      const child = await childMessageRow();
      expect(parent).toBeDefined();
      expect(child).toBeDefined();

      // ONE CAUSE, TWO ROWS. The keys are the same domain event; the AUDIENCE
      // facet is what separates them, which is why neither deduplicates the
      // other away and why the parent's daily cap cannot silence the child's own
      // news about their own work.
      expect(String(parent.source_event_id).startsWith('evt:')).toBe(true);
      expect(String(child.source_event_id)).toBe(`${parent.source_event_id}:child`);

      // ===== THE ASSERTION THIS ACT EXISTS FOR =====
      // Not the same sentence. A product that sent one string to both audiences
      // would be a broadcast with two recipients, not a coach.
      expect(child.body).not.toBe(parent.body);
      expect(child.title === parent.title && child.body === parent.body).toBe(false);

      // THE PARENT'S NAMES THE CHILD AND NAMES THE WORK. «محمد أكمل الآيات ١–٥
      // من سورة الملك» and not «حصل طفلك على مكافأة», pinned to the byte so the
      // next change to this copy is deliberate.
      //
      // `F1-003` — WHAT THIS PIN ASSERTED BEFORE, VERBATIM:
      //
      //   `🌟 ${home.childName} أكمل ${THE_TARGET_SUMMARY} اليوم وحصل على ٢٠ نقطة. افتح التطبيق لتشجيعه.`
      //
      // i.e. «🌟 محمد أكمل الآيات 1–5 من سورة الملك اليوم وحصل على ٢٠ نقطة…» —
      // Latin digits from `describeTargetSpec` beside Arabic-Indic digits from
      // `formatNumber`, in one sentence. `THE_TARGET_SUMMARY_IN_PROSE` is the
      // same summary in the one script the sentence is written in.
      expect(parent.title).toBe('مكافأة جديدة');
      expect(parent.body).toBe(
        `🌟 ${home.childName} أكمل ${THE_TARGET_SUMMARY_IN_PROSE} اليوم وحصل على ٢٠ نقطة. افتح التطبيق لتشجيعه.`,
      );
      expect(parent.body).toContain(home.childName);

      /**
       * THE CHILD'S IS ADDRESSED TO THE CHILD. Second person, and it does not
       * name them, because you do not say a child's own name back at them on
       * their own phone.
       *
       * `F1-002` — WHAT THIS ASSERTED BEFORE, VERBATIM:
       *
       *     expect(child.body).toContain('حصلت');
       *
       * That word came from `COPY_CATALOGUE.REWARD_GRANTED_CHILD` — «حصلت على
       * مكافأة جديدة» — which was the ONLY sentence a child could ever receive
       * for a reward, whatever earned it. `REWARD_GRANTED` is what four
       * different domain causes collapse into at the notification door, so a
       * child who kept a seven-day streak and this child, whose parent
       * confirmed «الآيات ١–٥ من سورة الملك» after they submitted evidence and
       * WAITED, read the identical line.
       *
       * The child now reads the answer to the thing they actually did — «تم
       * تأكيد إنجازك في … من أهلك», `COPY_CATALOGUE.ACHIEVEMENT_VERIFIED` at
       * this child's own tone band. The property this assertion was defending —
       * SECOND PERSON, NOT THIRD, and never the child's own name — is asserted
       * below and is unchanged; only the verb it happened to be spelled with
       * has moved.
       */
      expect(child.body).toContain('إنجازك');
      expect(child.body).not.toContain(home.childName);
      expect(child.body).not.toContain('حصل ');

      // NEITHER IS A TEMPLATE, AND NEITHER LEAKS A DATABASE VALUE.
      assertItReadsLikeASentence(parent.body);
      assertItReadsLikeASentence(parent.title);
      assertItReadsLikeASentence(child.body);
      assertItReadsLikeASentence(child.title);
    });

    /**
     * ========================================================================
     * THE GAP THIS FILE MEASURED, NOW CLOSED — AND PINNED FROM THE OTHER SIDE.
     * ========================================================================
     *
     * WHAT THIS TEST SAID BEFORE, VERBATIM, AND WHY:
     *
     *     expect(parent.body).not.toContain('سورة الملك');
     *     expect(parent.body).not.toContain('الملك');
     *     expect(data ?? null).toBeNull();
     *
     * The chain this scenario walks starts at «حفظ سورة الملك، الآيات ١–٥» and
     * the parent's notification about its completion did NOT name it — not in
     * the body, and not in `data`, which was `null` because
     * `NotificationRewardConsumer` passed no facts alongside the event and
     * `COPY_CATALOGUE.REWARD_GRANTED` declared exactly one variable,
     * `childName`. The parent was told THAT their child earned something and had
     * to open the app to learn WHAT — a broadcast with a pointer attached, and
     * measurably not the notification the product brief advertises.
     *
     * The pin said «when a producer starts carrying the goal, this test turns
     * red and forces a deliberate update». It did, and this is that update: the
     * SAME two places are still the assertion, with the answers inverted.
     *
     * WHERE THE TWO FACTS COME FROM, because that is the half a byte-pin cannot
     * express and the half that would be easiest to fake:
     *
     *   THE GOAL   `RewardProgram.targetSummaryAr`, derived ONCE by
     *              `describeTargetSpec` at program creation (STEP 8 read it off
     *              the response) and carried to the consumer on the completion's
     *              own metadata. NOT re-assembled in the notification layer from
     *              a surah number — this test compares against the same
     *              `THE_TARGET_SUMMARY` STEP 8 asserted, so a second derivation
     *              that drifted by one character would fail here.
     *   THE POINTS Summed from `rewards_ledger_entries`. Asserted below against
     *              the LEDGER ROW rather than against the literal 20, so a
     *              notification that stated a number the database does not hold
     *              would fail even though both numbers came from this file.
     */
    it('STEP 14 — the parent notification NAMES the achievement and the points, in the body AND in the payload', async () => {
      const parent = await parentNotificationRow();

      // ===== THE BODY. The goal, by the name the parent gave it. =====
      // `F1-003` — WAS `expect(parent.body).toContain(THE_TARGET_SUMMARY);`,
      // i.e. the stored Latin-digit form «الآيات 1–5 من سورة الملك». The
      // sentence now carries the same summary in the script the rest of the
      // sentence is written in; the STORED value is asserted unchanged below,
      // on `data.goalTitle`.
      expect(parent.body).toContain(THE_TARGET_SUMMARY_IN_PROSE);
      expect(parent.body).toContain('سورة الملك');

      // ===== AND THE NUMBER IS THE LEDGER'S. =====
      // Read back out of `rewards_ledger_entries` and rendered in Arabic-Indic
      // digits, because Arabic prose with Latin numerals reads as a translation
      // (`PF-E-002`). Twenty is not hard-coded into this assertion: it is
      // whatever the grant actually paid.
      const [ledger] = await world.raw<any[]>(
        `SELECT "amount" FROM "rewards_ledger_entries"
          WHERE "family_id" = $1::uuid AND "child_id" = $2::uuid AND "type" = 'EARN' AND "reward_type" = 'XP'`,
        home.familyId,
        home.childId,
      );
      const pointsInArabic = String(ledger.amount).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
      expect(parent.body).toContain(`${pointsInArabic} نقطة`);

      // ===== AND IT REACHES THE APP AS DATA, NOT ONLY AS PROSE. =====
      // «افتح التطبيق» has to lead somewhere, and a client must not have to
      // parse Arabic to deep-link. `data` was NULL; it now carries the facts —
      // and carries NO identifiers, which CONTEXT §3 principle 8 requires of
      // this payload just as much as of the FCM one.
      const data = typeof parent.data === 'string' ? JSON.parse(parent.data) : parent.data;
      expect(data).not.toBeNull();
      expect(data.goalTitle).toBe(THE_TARGET_SUMMARY);
      expect(data.points).toBe(ledger.amount);
      const serialisedData = JSON.stringify(data);
      for (const id of [home.familyId, home.childId, deviceId, programId, achievementId]) {
        if (id) expect(serialisedData).not.toContain(id);
      }
      expect(serialisedData).not.toContain(home.childName);
    });

    /**
     * THE OTHER HALF OF «NAME THE ACHIEVEMENT», and it is the one a byte-pin on
     * the parent's sentence alone would let rot: the child's message must NOT
     * have been dragged along with it.
     *
     * The two audiences are scored, capped and composed separately on purpose,
     * and `COPY_CATALOGUE.REWARD_GRANTED_CHILD` deliberately declares NO
     * variables — «حصلت على ٣ مكافآت من سورة الملك» is a receipt read at a
     * child, not encouragement. So the parent gaining detail must leave the
     * child's sentence exactly where it was.
     */
    it('STEP 14 — the parent gained the detail and the CHILD did not: two audiences, still two sentences', async () => {
      const parent = await parentNotificationRow();
      const child = await childMessageRow();

      expect(child.body).not.toBe(parent.body);
      /**
       * `F1-002` — WHAT THIS ASSERTED BEFORE, VERBATIM:
       *
       *     expect(child.body).not.toContain(THE_TARGET_SUMMARY);
       *     expect(child.body).not.toContain('سورة الملك');
       *
       * and the reason given was that the parent gaining detail must not drag
       * the child's sentence along with it. THAT REASON STILL HOLDS AND IS
       * STILL ASSERTED — the two sentences are still different sentences, and
       * the child's still withholds the two facts it was written to withhold:
       * the POINTS and the grant COUNT, which are a receipt read at a child.
       *
       * What changed is not the parent's sentence leaking into the child's; it
       * is that the CHILD'S OWN CAUSE finally reaches the copy layer. This
       * child submitted evidence against a goal and waited for a human to look
       * at it, and «حصلت على مكافأة جديدة» never said that a human had. The
       * catalogue has held «تم تأكيد إنجازك في {goalTitle}» in four tone bands
       * and two languages since `F6-002` with nothing able to select it.
       *
       * THE TITLE IS NOT THE PARENT'S COPY. The parent reads «{childName} أكمل
       * {goalTitle} اليوم وحصل على {points} نقطة. افتح التطبيق لتشجيعه» — a
       * third-person report with a number and a call to act. The child reads a
       * second-person confirmation with no number and no name. Same fact, two
       * audiences, two registers.
       */
      expect(child.body).toContain(THE_TARGET_SUMMARY_IN_PROSE);
      // AND STILL NOT `describeTargetSpec`'S LATIN NUMERALS. It writes «الآيات
      // 1–5»; an Arabic sentence gets «الآيات ١–٥» (`PF-E-002`) — and as of
      // `F1-003` that is true of the PARENT's sentence above as well, which is
      // why both now quote one constant. The stored column keeps the Latin
      // form; only prose is localised.
      expect(child.body).not.toContain(THE_TARGET_SUMMARY);
      // No points, no counts: the child's own app already shows the balance.
      expect(child.body).not.toContain('نقطة');
      // Second person, and still not their own name back at them.
      expect(child.body).toContain('إنجازك');
      expect(child.body).not.toContain(home.childName);

      // PHASE F1 — AND THE PAYLOAD DID NOT HAND OVER WHAT THE SENTENCE
      // WITHHELD. This assertion is the reason the child branch NARROWS
      // `data` to one whitelisted key instead of copying the producer's
      // object across: the parent's row legitimately carries `goalTitle` and
      // `points`, and a verbatim copy would have given the child the same
      // detail one field at a time, past a sentence written to withhold it.
      //
      // The child's row carries a DESTINATION and nothing else — «حصلت على
      // مكافأة» leading to the rewards surface — and no identifier, which
      // CONTEXT §3 principle 8 asks of a child-readable row at least as loudly
      // as of the parent's FCM payload.
      const childData = typeof child.data === 'string' ? JSON.parse(child.data) : child.data;
      expect(Object.keys(childData ?? {})).toEqual(['deepLink']);
      // `F1-002` — WAS `abny://rewards`, and it moved with the SENTENCE rather
      // than on its own: `notification-destination.ts` sends
      // `REWARD_GRANTED_CHILD` to the reward and `ACHIEVEMENT_VERIFIED` to the
      // goal («the review happens ON the goal»), and the engine resolves the
      // link from `composed.resolvedCopyKey` precisely so a tap can never land
      // somewhere the sentence did not describe. The child is told their goal
      // was confirmed, and the tap opens the goal.
      expect(childData.deepLink).toBe('abny://goals');
      const childPayload = JSON.stringify(childData);
      for (const id of [home.familyId, home.childId, deviceId, programId, achievementId]) {
        if (id) expect(childPayload).not.toContain(id);
      }
      expect(childPayload).not.toContain(home.childName);
      expect(childPayload).not.toContain(THE_TARGET_SUMMARY);
    });

    /**
     * THE PROVENANCE OF THE PARENT'S SENTENCE, asserted the way `e2e-10` asserts
     * every other one: the decision row names the copy key, and rendering THAT
     * key with THESE variables must reproduce the stored body byte for byte.
     *
     * This is what «the string is not typed into a consumer» means as an
     * assertion rather than as a claim — and it is also the check that would
     * catch the failure mode this change could most plausibly introduce: a
     * template whose variable the producer forgot renders no `{placeholder}`
     * (the renderer refuses), it silently degrades to `GENERIC`. A `GENERIC`
     * fallback would still be Arabic, still leak-free, and still pass every
     * generic check in this file — so the key is asserted by name.
     */
    it('STEP 14 — the parent’s sentence is rendered FROM THE CATALOGUE, at the key the decision row names', async () => {
      const parent = await parentNotificationRow();
      const decision = await decisionRow('REWARD_GRANTED');
      expect(decision).toBeDefined();

      expect(decision.target_audience).toBe('PARENT');
      expect(decision.locale).toBe('ar');
      // The COPY KEY differs from the notification TYPE, deliberately: the row
      // is still a `REWARD_GRANTED` — which is what the scorer weights, what the
      // quiet-hours matrix classifies and what the analytics count — while the
      // SENTENCE is the one that has somewhere to put a goal and a number.
      expect(decision.copy_key).toBe('REWARD_GRANTED_WITH_GOAL');
      expect(parent.type).toBe('REWARD_GRANTED');

      const rendered = renderNotificationCopy({
        key: decision.copy_key,
        audience: 'PARENT',
        toneBand: '11-13',
        locale: 'ar',
        variables: { childName: home.childName, goalTitle: THE_TARGET_SUMMARY, points: 20 },
      });
      expect(parent.body).toBe(rendered.body);
      expect(parent.title).toBe(rendered.title);
      expect(rendered.resolvedKey).toBe('REWARD_GRANTED_WITH_GOAL');
    });

    /**
     * AND THE FALLBACK IS INTACT — which is the whole reason the goal sentence is
     * a SECOND key rather than a rewrite of the first.
     *
     * Most rewards in this product are not parent-authored programs: a habit
     * tick, a hydration target, a streak milestone. None of them knows what was
     * achieved, and none of them ever will. A producer with no goal must get a
     * COMPLETE sentence — not a half-filled template, and not the contentless
     * `GENERIC` entry — and this asserts that at the catalogue, where the
     * property lives, because no scenario in this file can produce a goal-less
     * grant to observe it end to end.
     */
    it('STEP 14 — a reward with no goal still reads as a whole sentence, never as a template or a stub', async () => {
      const withoutTheGoal = renderNotificationCopy({
        key: 'REWARD_GRANTED',
        audience: 'PARENT',
        toneBand: '11-13',
        locale: 'ar',
        variables: { childName: home.childName },
      });
      expect(withoutTheGoal.resolvedKey).toBe('REWARD_GRANTED');
      expect(withoutTheGoal.body).toBe(
        `حصل ${home.childName} على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.`,
      );
      assertItReadsLikeASentence(withoutTheGoal.body);

      // AND THE FAILURE MODE THE NEW KEY COULD HAVE INTRODUCED, PINNED: a
      // producer that has the child's name but NOT the goal must never reach the
      // goal template, because a rendered `{goalTitle}` in a parent's hand is the
      // exact leak this catalogue exists to make impossible.
      const halfFilled = renderNotificationCopy({
        key: 'REWARD_GRANTED_WITH_GOAL',
        audience: 'PARENT',
        toneBand: '11-13',
        locale: 'ar',
        variables: { childName: home.childName },
      });
      expect(halfFilled.body).not.toMatch(UNSUBSTITUTED_PLACEHOLDER);
      expect(halfFilled.body).not.toContain('goalTitle');
      expect(halfFilled.body).not.toContain('points');
      expect(hasEnumOrPlaceholderLeak(halfFilled.body)).toBe(false);
    });

    it('STEP 14 — the child\'s sentence is ARABIC, from the catalogue, and fits a twelve-year-old', async () => {
      const child = await childMessageRow();
      const decision = await decisionRow('REWARD_GRANTED_CHILD');
      expect(decision).toBeDefined();

      // The household registered through `/auth/register` with no `locale`, the
      // way the mobile app registers one, and is answered in the product's first
      // language.
      expect(decision.target_audience).toBe('CHILD');
      expect(decision.locale).toBe('ar');
      expect(decision.age_band).toBe('11-13');
      expect(child.body).toMatch(ARABIC_LETTERS);
      expect(child.body).not.toMatch(WESTERN_DIGITS);

      // FROM LOCALIZATION, BYTE-IDENTICAL. Rendering the key the decision row
      // names, at the band it names, must reproduce the stored sentence exactly
      // — which is what «the string is not typed into a service» means as an
      // assertion rather than as a claim.
      //
      // `F1-002` — WHAT THIS PASSED BEFORE, VERBATIM: `variables: {}`.
      // `REWARD_GRANTED_CHILD` declares no variables, so an empty record
      // reproduced it. The key the decision row now names is
      // `ACHIEVEMENT_VERIFIED`, whose sentence states WHICH goal was confirmed,
      // and the fact is read back out of the PROGRAM the parent created rather
      // than restated here — a second derivation that drifted by one character
      // would fail on this line.
      const rendered = renderNotificationCopy({
        key: decision.copy_key,
        audience: 'CHILD',
        toneBand: '11-13',
        locale: 'ar',
        variables: { goalTitle: THE_TARGET_SUMMARY },
      });
      expect(decision.copy_key).toBe('ACHIEVEMENT_VERIFIED');
      expect(child.body).toBe(rendered.body);
      expect(child.title).toBe(rendered.title);

      // AGE-APPROPRIATE FOR THIS CHILD'S BAND, checked against the SAFETY
      // ceiling `age-band.ts` sets for a twelve-year-old — the ceiling the tone
      // engine composes UNDER, read from that module rather than restated here.
      const ceiling = profileForAge(12);
      expect(countWords(child.body)).toBeLessThanOrEqual(ceiling.maxWords);
      expect(child.body.length).toBeLessThanOrEqual(ceiling.maxChars);
      // And the register really is the twelve-year-old's: the 5-7 band's
      // sentence for the identical key is a different string.
      const forASevenYearOld = renderNotificationCopy({
        key: decision.copy_key,
        audience: 'CHILD',
        toneBand: '5-7',
        locale: 'ar',
        variables: { goalTitle: THE_TARGET_SUMMARY },
      });
      expect(child.body).not.toBe(forASevenYearOld.body);

      // NON-PUNITIVE — CONTEXT §3 principle 7.
      for (const word of PUNITIVE_VOCABULARY) {
        expect(child.body).not.toContain(word);
        expect(child.title).not.toContain(word);
      }
    });

    it('STEP 14 — the child\'s message is behind the parent\'s gate, and the child does not see it yet', async () => {
      const child = await childMessageRow();
      expect(child.approval_status).toBe('PENDING');
      expect(child.delivered_at).toBeNull();

      const inbox = await request(world.http)
        .get(`${P}/life-intelligence/self/messages`)
        .set(asBearer(deviceToken));
      expect(inbox.status).toBe(200);
      // The wedge did not become a way around §5.8's approval gate.
      expect(inbox.body).toHaveLength(0);
    });

    it('STEP 15 — the timeline gained ONE curated entry, carrying the key that makes it unrepeatable', async () => {
      const timeline = await world.raw<any[]>(
        `SELECT * FROM "life_timeline_events"
          WHERE "family_id" = $1::uuid AND "child_id" = $2::uuid AND "event_type" = 'reward_granted'`,
        home.familyId,
        home.childId,
      );

      expect(timeline).toHaveLength(1);
      const metadata =
        typeof timeline[0].metadata === 'string' ? JSON.parse(timeline[0].metadata) : timeline[0].metadata;
      // `life_timeline_events_reward_source_key_uq` is a UNIQUE INDEX on
      // `(child_id, metadata->>'sourceKey')`. The value is what makes the
      // replay in ACT VII structurally unable to write a second row.
      expect(metadata?.sourceKey).toBeTruthy();
      expect(timeline[0].title).not.toMatch(RAW_ENUM);

      /**
       * ======================================================================
       * THE SECOND GAP THIS FILE MEASURED, NOW CLOSED. THE TIMELINE IS ARABIC.
       * ======================================================================
       *
       * WHAT THIS TEST SAID BEFORE, VERBATIM:
       *
       *     expect(timeline[0].title).toBe('Earned a reward');
       *     expect(timeline[0].title).not.toMatch(ARABIC_LETTERS);
       *
       * Every user-visible string this scenario checks is Arabic from a
       * catalogue: the parent's notification, the child's message, the goal's
       * `targetSummaryAr`, every label on `GET /self/catalogue`. The LIFE
       * TIMELINE — «سجل حياة الطفل», the artefact CONTEXT §1 puts forward as
       * what a parent keeps — was written by `rewards-engine.service.ts` with
       * `title: 'Earned a reward'`, a hardcoded ENGLISH literal, for an
       * Arabic-first product whose only two markets are EG and SA.
       *
       * It was not a raw enum and not a placeholder, so it passed every generic
       * leak check in this file; it was simply the wrong language — the failure
       * mode a leak check cannot see, which is why it was pinned to the byte.
       *
       * IT IS NOW TWO ASSERTIONS, NOT ONE, and the second is the important one.
       * «حصل على مكافأة» would be Arabic and would still answer only WHEN: a
       * timeline of twenty identical rows is a counter, not a life record. So the
       * entry NAMES the work, from the same server-derived `targetSummaryAr` the
       * notification uses — one derivation, two surfaces.
       */
      expect(timeline[0].title).toMatch(ARABIC_LETTERS);
      expect(timeline[0].title).not.toMatch(/[A-Za-z]/);
      expect(timeline[0].title).toContain(THE_TARGET_SUMMARY);
      expect(timeline[0].title).toBe(`أكمل ${THE_TARGET_SUMMARY} وحصل على مكافأة`);

      // The same three properties every other user-visible string in this file
      // is held to. `title` is read by a parent inside the app, so «not a raw
      // enum, not a placeholder, not a database id» is not a lower bar here.
      assertItReadsLikeASentence(timeline[0].title);
    });
  });

  // ==========================================================================
  // ACT VI — STEP 16. AN ADMIN COUNTER MOVES, IN THE RIGHT MARKET.
  // ==========================================================================

  describe('ACT VI — the growth funnel learns about this household, in Saudi Arabia', () => {
    it('STEP 16 — the ACTIVATION row exists and is STAMPED with the family\'s own market', async () => {
      // `family_activations` is one row per family, ever — the unique index is
      // the guarantee, not a code check — and its `country_code` is resolved by
      // the SAME precedence (`domain/country-attribution.ts`) that the queries
      // counting those rows use. This is the per-row form of the whole step:
      // there is no aggregate here to be confused by another suite.
      const rows = await world.raw<any[]>(
        `SELECT * FROM "family_activations" WHERE "family_id" = $1::uuid`,
        home.familyId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].country_code).toBe(THE_MARKET);
      expect(rows[0].country_code).not.toBe(THE_OTHER_MARKET);
      expect(rows[0].rule_version).toBeTruthy();
      expect(Number(rows[0].time_to_value_minutes)).toBeGreaterThanOrEqual(0);
    });

    it('STEP 16 — the growth event carries SA, and still does not say WHICH child', async () => {
      const rows = await world.raw<any[]>(
        `SELECT "event_name", "payload" FROM "analytics_events" WHERE "family_id" = $1::uuid`,
        home.familyId,
      );
      const activation = rows.find((r) => r.event_name === 'CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL');
      expect(activation).toBeDefined();
      const payload =
        typeof activation.payload === 'string' ? JSON.parse(activation.payload) : activation.payload;
      expect(payload.countryCode).toBe(THE_MARKET);

      // CONTEXT §3 principle 8, enforced by an allow-list: the growth store
      // learned that A child completed a goal, never which one.
      for (const row of rows) {
        const serialised = JSON.stringify(row.payload ?? {});
        expect(serialised).not.toContain(home.childId);
        expect(serialised).not.toContain(home.childName);
      }
    });

    it('STEP 16 — GET /admin/growth/funnel moves for SA and does NOT move for EG', async () => {
      const saAfter = await firstRewardStep(THE_MARKET);
      const egAfter = await firstRewardStep(THE_OTHER_MARKET);

      // SA GAINED THIS HOUSEHOLD. Asserted as a DELTA, not an absolute: these
      // are cross-tenant counts over a shared database, and an absolute would be
      // an assertion about every suite that ever ran here.
      expect(saAfter).toBeGreaterThanOrEqual(funnelBefore.sa + 1);

      // AND EG GAINED NOTHING. This is the half that `families.country_code`
      // exists for: the markets are DISJOINT by construction (a family whose own
      // column is set is never also read off an ad label), so the sum of the
      // per-country numbers can never exceed the platform's.
      expect(egAfter).toBe(funnelBefore.eg);
    });

    it('STEP 16 — the counter is a REPORT, not a tenant surface: a parent token cannot read it', async () => {
      const asTheParent = await request(world.http)
        .get(`${P}/admin/growth/funnel?countryCode=${THE_MARKET}`)
        .set(asParent(home));
      const anonymous = await request(world.http).get(`${P}/admin/growth/funnel?countryCode=${THE_MARKET}`);

      // «How many households converted in Saudi Arabia» is not a question a
      // tenant may ask, and the guarantee is that the endpoint refuses them
      // rather than that a filter was remembered.
      expect([401, 403]).toContain(asTheParent.status);
      expect([401, 403]).toContain(anonymous.status);
    });
  });

  // ==========================================================================
  // ACT VII — STEP 17. THE REPLAY. THE ACT THAT MAKES THE OTHERS WORTH ANYTHING.
  // ==========================================================================

  /**
   * ABNY's promise to a parent is that a reward MEANS something. A reward that
   * can be earned twice for one surah is not a bug in a counter — it is the
   * moment the child learns the system can be farmed and the parent stops
   * trusting the number. CONTEXT §3 principle 6 says the defence must be a
   * DATABASE CONSTRAINT and not a code check, and this act is where that claim
   * is spent rather than stated.
   */
  describe('ACT VII — the completion is delivered again, and the product does not move', () => {
    /**
     * Re-enqueues every outbox message for this family AND deletes the
     * `consumed_messages` markers. That is the HARSH form on purpose: the marker
     * table is documented as an OPTIMISATION, so stripping it makes the
     * redelivery genuinely re-enter every consumer. What is left standing
     * between the replay and a second reward is PostgreSQL.
     */
    async function redeliverEverything(): Promise<void> {
      await world.sys('redeliver every message', async () => {
        await world.prisma.consumedMessage.deleteMany({ where: { familyId: home.familyId } });
        await world.prisma.outboxMessage.updateMany({
          where: { familyId: home.familyId },
          data: {
            status: 'PENDING',
            lockedAt: null,
            lockedBy: null,
            nextAttemptAt: new Date(),
            attemptCount: 0,
          },
        });
      });
    }

    it('STEP 17 — at-least-once redelivery grants zero, notifies zero, and writes zero timeline rows', async () => {
      const before = await countTheSlice();
      expect(before).toEqual({
        rewardGrants: 1,
        timelineEvents: 1,
        childNotifications: 1,
        parentNotifications: 1,
      });

      // The clock is moved OUTSIDE the fatigue guard's five-minute DUPLICATE
      // window deliberately. A second notification WOULD be dispatched if a
      // second grant happened, so a pass here cannot be the window swallowing it.
      jest.setSystemTime(goldenAt('12:06'));
      await redeliverEverything();
      const drained = await world.drainOutbox();
      // THE REDELIVERY REALLY HAPPENED. Without this line the test could pass by
      // measuring nothing at all, which is how a regression test dies quietly.
      expect(drained.published).toBeGreaterThan(0);

      expect(await countTheSlice()).toEqual(before);
    });

    it('STEP 17 — with the notification history BLINDED, the four numbers are still one each', async () => {
      // The fatigue guard reads the last 24 hours of `notifications` for this
      // child. Back-dating the row 48 hours makes the guard see an EMPTY history
      // and happily allow a second send — so a pass here cannot be credited to
      // the guard. The row stays in the table, because the CONSTRAINT still sees
      // it: `notifications (family_id, source_event_id, user_id)`.
      const parent = await parentNotificationRow();
      await world.sys('back-date it out of the fatigue window', () =>
        world.prisma.notification.update({
          where: { id: parent.id },
          data: { createdAt: new Date(GOLDEN_NOON.getTime() - 48 * 60 * 60 * 1000) },
        }),
      );

      jest.setSystemTime(goldenAt('12:20'));
      await redeliverEverything();
      const drained = await world.drainOutbox();
      expect(drained.published).toBeGreaterThan(0);

      // ===== THE FOUR NUMBERS THE BRIEF ASKS FOR, AFTER TWO FULL REDELIVERIES
      // ===== WITH THE CONSUMER MARKERS DELETED AND THE FATIGUE HISTORY BLINDED.
      // Every one read out of its own table by SQL, never from a response body.
      expect(await countTheSlice()).toEqual({
        rewardGrants: 1,
        timelineEvents: 1,
        childNotifications: 1,
        parentNotifications: 1,
      });
    });

    it('STEP 17 — the child cannot re-submit, and the parent cannot re-approve', async () => {
      const resubmitted = await request(world.http)
        .post(`${P}/self/achievements/${achievementId}/submit`)
        .set(asBearer(deviceToken))
        .send({ foregroundMinutes: 21 });
      expect(resubmitted.status).toBe(409);

      const reapproved = await request(world.http)
        .post(`${P}/reward-programs/achievements/${achievementId}/approve`)
        .set(asParent(home))
        .send({});
      expect(reapproved.status).toBe(409);
      // And what the PARENT reads about it is a sentence, not an enum.
      expect(reapproved.body.messageAr).toBeTruthy();
      expect(reapproved.body.messageAr).not.toMatch(RAW_ENUM);
      expect(reapproved.body.messageAr).not.toMatch(AN_HTTP_STATUS);

      await world.drainOutbox();
      expect(await countTheSlice()).toEqual({
        rewardGrants: 1,
        timelineEvents: 1,
        childNotifications: 1,
        parentNotifications: 1,
      });
    });

    it('STEP 17 — the ACTIVATION and the admin counter are each still exactly one', async () => {
      expect(
        await scalar(
          `SELECT COUNT(*)::int AS n FROM "family_activations" WHERE "family_id" = $1::uuid`,
          home.familyId,
        ),
      ).toBe(1);

      // The analytics counter is as idempotent as the ledger, and by the same
      // kind of thing: a CONSTRAINT on the CAUSE
      // (`analytics_events (event_name, source_event_id)`, migration 0020) —
      // not a marker, because the replays above DELETE the markers.
      expect(
        await scalar(
          `SELECT COUNT(*)::int AS n FROM "analytics_events"
            WHERE "family_id" = $1::uuid AND "event_name" = 'REWARD_GRANTED'`,
          home.familyId,
        ),
      ).toBe(1);
      expect(
        await scalar(
          `SELECT COUNT(*)::int AS n FROM "analytics_events"
            WHERE "family_id" = $1::uuid AND "event_name" = 'CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL'`,
          home.familyId,
        ),
      ).toBe(1);

      // And the market's funnel did not double-count the household either.
      expect(await firstRewardStep(THE_MARKET)).toBeGreaterThanOrEqual(funnelBefore.sa + 1);
      expect(await firstRewardStep(THE_OTHER_MARKET)).toBe(funnelBefore.eg);
    });

    it('STEP 17 — and after all of it, the two sentences are still the same two sentences', async () => {
      const parent = await parentNotificationRow();
      const child = await childMessageRow();

      // `F1-003` — WHAT THIS PIN ASSERTED BEFORE, VERBATIM:
      //
      //   `🌟 ${home.childName} أكمل ${THE_TARGET_SUMMARY} اليوم وحصل على ٢٠ نقطة. افتح التطبيق لتشجيعه.`
      //
      // The same sentence, now in one numeral script. Still byte-pinned, and
      // still the SAME sentence after two full redeliveries — which is what
      // this step is actually about.
      expect(parent.body).toBe(
        `🌟 ${home.childName} أكمل ${THE_TARGET_SUMMARY_IN_PROSE} اليوم وحصل على ٢٠ نقطة. افتح التطبيق لتشجيعه.`,
      );
      expect(child.body).not.toBe(parent.body);
      assertItReadsLikeASentence(parent.body);
      assertItReadsLikeASentence(child.body);

      // AND THE POINTS DID NOT DOUBLE IN THE SENTENCE EITHER. This is the half a
      // count-only replay assertion cannot reach: the ledger sum the producer
      // reads is a read over committed rows, so two full redeliveries with the
      // consumer markers deleted must still announce twenty — not forty, and not
      // «٠ نقطة» from a recovery path that lost the number.
      expect(parent.body).toContain('٢٠ نقطة');
      const data = typeof parent.data === 'string' ? JSON.parse(parent.data) : parent.data;
      expect(data.points).toBe(20);
      expect(data.goalTitle).toBe(THE_TARGET_SUMMARY);

      // AND THE TIMELINE TITLE IS STILL THE ONE ARABIC SENTENCE.
      const [entry] = await world.raw<any[]>(
        `SELECT "title" FROM "life_timeline_events"
          WHERE "family_id" = $1::uuid AND "child_id" = $2::uuid AND "event_type" = 'reward_granted'`,
        home.familyId,
        home.childId,
      );
      expect(entry.title).toBe(`أكمل ${THE_TARGET_SUMMARY} وحصل على مكافأة`);
    });
  });
});
