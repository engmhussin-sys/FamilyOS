/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-06 — WHAT THE CHILD IS TOLD. THE HALF OF THE PRODUCT THAT IS THE
 * WEDGE.
 * ============================================================================
 *
 * THE PRODUCT LOOP THIS PROTECTS. CONTEXT §1 states the commercial thesis in one
 * sentence: «تطبيق الطفل هو منتج قائم بذاته يريد الطفل فتحه (Gamified Coach)، لا
 * برنامج تجسس يريد الطفل حذفه». Every competitor in this category loses to the
 * same number — the child circumvention rate — and ABNY's answer is that the
 * child's own app talks to them, in their own language, at their own age, and
 * never punishes.
 *
 * A message to a child therefore has FIVE properties, and this scenario asserts
 * every one of them against a row in `child_messages`:
 *
 *   ARABIC          — the product's first language, with Arabic-Indic digits.
 *                     «٩ أيام», never «9 days» and never «9 أيام».
 *   AGE-BANDED      — a seven-year-old and a twelve-year-old get DIFFERENT
 *                     sentences for the identical event, and each fits inside
 *                     the SAFETY ceiling `age-band.ts` sets for their band.
 *   NON-PUNITIVE    — CONTEXT §3 principle 7. No «ممنوع», no «تجاوزت», no
 *                     «فشلت». A statement plus a way forward.
 *   FROM LOCALIZATION — the string is BYTE-IDENTICAL to what the catalogue
 *                     renders for that key, band and locale. Not a literal in a
 *                     service, not a raw `ALL_CAPS_SNAKE` enum, not a template
 *                     with an unresolved `{placeholder}`.
 *   GATED AND IDEMPOTENT — it lands as `PENDING` with `delivered_at = NULL`,
 *                     behind the parent-approval gate, carrying the producer's
 *                     idempotency key in `source_event_id`; and the same cause
 *                     delivered twice is ONE row, refused by
 *                     `child_messages (family_id, source_event_id)`.
 *
 * AND FIRST, ACT I ASKS THE ONLY QUESTION THAT MATTERS COMMERCIALLY: does a
 * child who earns a reward hear anything at all today? Measured over real HTTP.
 * The answer was NO, and it was recorded as PF-E-006.
 *
 * ---------------------------------------------------------------------------
 * `F6-006` — THE CHILD PATH HAS A PRODUCER, AND ACT I IS THE PROOF.
 *
 * ACT I is unchanged as a SCENARIO — the same five HTTP calls on a real device
 * token, the same outbox drain, no engine call and no test double anywhere. Its
 * assertions are rewritten to the new answer, each carrying the line it
 * replaced:
 *
 *   BEFORE  `child_messages` = 0 rows · the child's inbox empty · the only
 *           CHILD-facing producer in `src/` was three English literals with no
 *           caller.
 *   AFTER   ONE row, `PENDING`, `delivered_at = NULL`, `source_event_id` the
 *           producer's own key plus the `:child` facet, and a body that is
 *           BYTE-IDENTICAL to what `COPY_CATALOGUE` renders for
 *           `REWARD_GRANTED_CHILD` at this child's tone band in `ar` — inside
 *           the safety ceiling `age-band.ts` sets for a twelve-year-old, and
 *           free of the punitive vocabulary CONTEXT §3 principle 7 forbids.
 *
 * ACT I also carries the `PE-N-001` GUARD, because that defect is why this half
 * of the product was dead in the first place: a notification type checked
 * against a whitelist of RECOMMENDATION types, silently refused, one message at
 * a time, for months. The two vocabularies are asserted to still be disjoint on
 * the real `SafetyEngineService` — so a future collision fails beside the
 * scenario that measured the silence rather than in a household.
 *
 * The English generator is deliberately NOT wired and deliberately NOT deleted;
 * see the test that still pins it, and the Wiring Report's open risks.
 * ---------------------------------------------------------------------------
 *
 * Real PostgreSQL, real Redis, real booted app, real HTTP. Nothing stubbed.
 */
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
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import type { NotificationEventInput } from '../../src/modules/notification-engine/application/services/notification-context.assembler';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { evaluateSmartNotificationCandidates } from '../../src/modules/life-intelligence/application/services/smart-notification-decision-engine';
import {
  COPY_CATALOGUE,
  hasEnumOrPlaceholderLeak,
  renderNotificationCopy,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import { countWords, profileForAge } from '../../src/modules/ai-core/domain/age-band';
import { SafetyEngineService } from '../../src/modules/ai-core/application/services/safety-engine.service';
import { NOTIFICATION_CLASSES } from '../../src/shared/notifications/notification-class';

import request = require('supertest');

/** The vocabulary CONTEXT §3 principle 7 forbids reaching a child, verbatim. */
const PUNITIVE_VOCABULARY = ['ممنوع', 'تجاوزت', 'فشلت', 'محظور', 'عقاب', 'خطأ منك'];

const AR_INDIC_DIGITS = /[٠-٩]/;
const ARABIC_LETTERS = /[؀-ۿ]/;
const WESTERN_DIGITS = /[0-9]/;

describeGolden('GOLDEN E2E-06 — the sentence that reaches the child, and the gate it passes through', () => {
  let world: GoldenWorld;
  /** A seven-year-old and a twelve-year-old: two tone bands, two safety bands. */
  let younger: GoldenHousehold;
  let older: GoldenHousehold;
  let engine: SmartNotificationEngineService;

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('golden E2E-06 (child notification)');
    // Ages are computed on the family calendar from the golden day, so the
    // dates of birth are expressed relative to it rather than to a real clock.
    const year = Number(GOLDEN_NOON.toISOString().slice(0, 4));
    younger = await world.register('e2e06a', {
      childName: 'سلمى',
      childDateOfBirth: `${year - 7}-01-05`,
    });
    older = await world.register('e2e06b', {
      childName: 'محمد',
      childDateOfBirth: `${year - 12}-01-05`,
    });
    await ageTheHousehold(world, younger, goldenAt('08:00'));
    await ageTheHousehold(world, older, goldenAt('08:00'));
    engine = world.app.get(SmartNotificationEngineService);
  }, 180_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  /** `category` on a `child_messages` row IS the notification type the producer
   * named. ACT I's reward message and ACT II's streak message live in the same
   * table for the same child, so every assertion below says WHICH CAUSE it is
   * about rather than trusting insertion order. */
  const childMessageRows = (h: GoldenHousehold, category?: string): Promise<any[]> =>
    category
      ? world.raw<any[]>(
          `SELECT * FROM "child_messages"
             WHERE "family_id" = $1::uuid AND "category" = $2
             ORDER BY "created_at", "id"`,
          h.familyId,
          category,
        )
      : world.raw<any[]>(
          `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
          h.familyId,
        );

  const decisionRows = (h: GoldenHousehold, eventType?: string): Promise<any[]> =>
    eventType
      ? world.raw<any[]>(
          `SELECT * FROM "notification_decisions"
             WHERE "family_id" = $1::uuid AND "event_type" = $2
             ORDER BY "created_at", "id"`,
          h.familyId,
          eventType,
        )
      : world.raw<any[]>(
          `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
          h.familyId,
        );

  const fire = (input: NotificationEventInput) =>
    runWithTenant({ familyId: input.familyId, actorType: 'SYSTEM', actorId: 'golden-e2e-06' }, () =>
      engine.handleEvent(input),
    );

  /** The same event for both children: a nine-day streak, achieved. */
  const fireStreak = (h: GoldenHousehold, suffix: string, at: Date) =>
    fire({
      familyId: h.familyId,
      childId: h.childId,
      eventType: 'STREAK_ACHIEVED',
      sourceEventId: `golden:e2e06:${h.label}:${suffix}`,
      trigger: 'STREAK_WATCH',
      streak: { days: 9, atRisk: false, hoursUntilBreak: null },
      now: at,
    });

  // =========================================================================
  // ACT I — WHAT A CHILD HEARS TODAY, WHEN THEY EARN SOMETHING
  // =========================================================================

  describe('ACT I — the real HTTP loop: a child earns a reward on their own device', () => {
    it('the loop runs end to end, and the child inbox is reachable from the device token', async () => {
      const program = await request(world.http)
        .post(`${P}/reward-programs`)
        .set(asParent(older))
        .send({
          childId: older.childId,
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
        .set(asChild(older))
        .send({ programId: program.body.id });
      const submitted = await request(world.http)
        .post(`${P}/self/achievements/${started.body.id}/submit`)
        .set(asChild(older))
        .send({ selfConfirmed: true });
      expect(submitted.body.status).toBe('VERIFIED');

      await world.drainOutbox();

      const inbox = await request(world.http).get(`${P}/life-intelligence/self/messages`).set(asChild(older));
      expect(inbox.status).toBe(200);
      expect(Array.isArray(inbox.body)).toBe(true);
    });

    /**
     * PF-E-006, HALF ONE — SILENCE. **CLOSED BY `F6-006`, AND THIS IS THE
     * PROOF, FROM THE PRODUCTION PATH.**
     *
     * WHAT THIS TEST SAID BEFORE, VERBATIM:
     *
     *     it('MEASURED — the child is told NOTHING when they earn a reward')
     *     expect(await childMessageRows(older)).toHaveLength(0);
     *
     * The parent got a notification (E2E-01 proved it). The child, whose app is
     * the product's whole differentiator, got nothing:
     * `NotificationRewardConsumer` was the only subscriber to `REWARD_GRANTED`
     * and it targeted `PARENT`. There was no `targetAudience: 'CHILD'` producer
     * anywhere on the reward path.
     *
     * NOTHING ABOVE THIS TEST CHANGED — the same five HTTP calls in ACT I's
     * first test, the same outbox drain, no engine call and no test double. The
     * consumer now fires a SECOND cause for the child, and every property this
     * scenario's header lists is asserted below ON THE PRODUCTION ROW rather
     * than on an engine call written by this file.
     */
    it('the child IS told when they earn a reward — Arabic, age-banded, from the catalogue, behind the gate', async () => {
      const rows = await childMessageRows(older, 'REWARD_GRANTED_CHILD');
      expect(rows).toHaveLength(1);
      const [message] = rows;

      // ARABIC. `older` is twelve, the household registered through
      // `/auth/register` with no `locale` sent — the way the mobile app
      // registers one — so this is also PF-E-002 holding on a production path.
      expect(message.body).toMatch(ARABIC_LETTERS);
      expect(message.body).not.toMatch(WESTERN_DIGITS);

      // FROM LOCALIZATION, byte-identical. The decision row names the copy key
      // and the tone band; rendering that key at that band must reproduce the
      // stored sentence exactly, which is what «the string is not typed into a
      // service» means as an assertion.
      const [decision] = await decisionRows(older, 'REWARD_GRANTED_CHILD');
      expect(decision).toBeDefined();
      expect(decision.target_audience).toBe('CHILD');
      expect(decision.locale).toBe('ar');
      expect(decision.age_band).toBe('11-13');
      expect(decision.copy_key).toBe('REWARD_GRANTED_CHILD');
      const rendered = renderNotificationCopy({
        key: decision.copy_key,
        audience: 'CHILD',
        toneBand: '11-13',
        locale: 'ar',
        variables: {},
      });
      expect(message.body).toBe(rendered.body);
      expect(message.title).toBe(rendered.title);
      expect(hasEnumOrPlaceholderLeak(message.body)).toBe(false);
      expect(hasEnumOrPlaceholderLeak(message.title)).toBe(false);

      // AGE-APPROPRIATE: inside the SAFETY ceiling `age-band.ts` sets for a
      // twelve-year-old — the ceiling the tone engine composes UNDER, read from
      // that module rather than restated here.
      const ceiling = profileForAge(12);
      expect(countWords(message.body)).toBeLessThanOrEqual(ceiling.maxWords);
      expect(message.body.length).toBeLessThanOrEqual(ceiling.maxChars);

      // NON-PUNITIVE — CONTEXT §3 principle 7.
      for (const word of PUNITIVE_VOCABULARY) {
        expect(message.body).not.toContain(word);
        expect(message.title).not.toContain(word);
      }

      // GATED AND KEYED. `PENDING`, undelivered, and carrying the PRODUCER's
      // own key plus the `:child` audience facet — the parent's notification
      // for the same reward carries the same key without it.
      expect(message.approval_status).toBe('PENDING');
      expect(message.delivered_at).toBeNull();
      expect(message.source_event_id).toMatch(/^evt:.+:child$/);

      // AND THE CHILD DOES NOT SEE IT YET. The wedge did not become a way
      // around §5.8's approval gate.
      const inbox = await request(world.http).get(`${P}/life-intelligence/self/messages`).set(asChild(older));
      expect(inbox.body).toHaveLength(0);
    });

    /**
     * `PE-N-001` IS THE REASON THIS TEST EXISTS.
     *
     * That defect dropped EVERY child notification for months while every
     * component reported success: a notification type was validated against a
     * whitelist of recommendation types, and the two vocabularies do not share
     * a single member. The child path fails QUIETLY by default, and a producer
     * that speaks the wrong vocabulary looks exactly like a household that
     * happened to be capped.
     *
     * So the two vocabularies are asserted to still be disjoint, on the real
     * `SafetyEngineService` from the booted app. If someone ever adds a
     * notification type to `ALLOWED_RECOMMENDATION_TYPES`, or renames one into
     * a collision, this fails HERE — beside the scenario that measured the
     * silence — rather than in production, one dropped message at a time.
     */
    it('PE-N-001 GUARD — the notification vocabulary and the recommendation whitelist are still disjoint', () => {
      const safety = world.app.get(SafetyEngineService);
      const childFacingTypes = Object.entries(NOTIFICATION_CLASSES)
        .filter(([, entry]) => entry.audience === 'CHILD' || entry.audience === 'BOTH')
        .map(([type]) => type);
      expect(childFacingTypes.length).toBeGreaterThan(5);

      for (const type of childFacingTypes) {
        // Under the RECOMMENDATION vocabulary every one of them is refused —
        // that IS `PE-N-001`, still true, and it is why the marker exists.
        const asRecommendation = safety.validate(type, 'عنوان', 'نص');
        expect(`${type}:${asRecommendation.isSafe}`).toBe(`${type}:false`);
        // Under the CHILD_MESSAGE vocabulary (`null`) the unsafe-pattern scan
        // still runs and safe copy passes. That is the half that protects.
        expect(safety.validate(null, 'عنوان', 'نص').isSafe).toBe(true);
      }

      // And the spyware scan is NOT weakened by the null: it is the half of
      // `validate` that actually protects a child, and it still bites.
      expect(safety.validate(null, 'Title', 'spy on your child').isSafe).toBe(false);
    });

    /**
     * PF-E-006, HALF TWO — THE DEAD ENGLISH GENERATOR, STILL DEAD, AND NOW
     * DEMONSTRABLY SUPERSEDED.
     *
     * `evaluateSmartNotificationCandidates` WAS the only function in `src/`
     * that built a `targetAudience: 'CHILD'` candidate. Its three sentences are
     * English string literals written inline — not catalogue keys, not
     * localised, not age-banded, not safety-filtered. Its only caller is
     * `SmartNotificationIntegrationService.processSignals`, and `processSignals`
     * has NO caller at all: no controller, no consumer, no scheduled job.
     *
     * `F6-006` did NOT wire it, and did not delete it. It added a real producer
     * on the reward path instead, and the test above proves that producer
     * speaks Arabic from the catalogue. This test is kept UNCHANGED and is now
     * a different statement: the English generator is still there, still
     * unreachable, and is the thing a future commit should delete rather than
     * connect. Its three types are the three the coverage guard reports as
     * having no producer, which is how the two files agree.
     */
    it('the legacy signal generator is STILL hardcoded English, and still has no caller', () => {
      const candidates = evaluateSmartNotificationCandidates({
        currentHourOfDay: 15,
        screenMinutesLast90: 120,
        isCurrentlyInBlockedOrCriticalApp: false,
        hydration: { actualMl: 100, targetMl: 1000 },
        studyTask: { isIncomplete: true, usualStudyWindowStarted: true },
        exerciseStreak: { streakDays: 4, todayComplete: false },
      });

      expect(candidates).toHaveLength(3);
      for (const candidate of candidates) {
        expect(candidate.targetAudience).toBe('CHILD');
        // Not one Arabic letter in a message addressed to a child of ABNY.
        expect(candidate.title).not.toMatch(ARABIC_LETTERS);
        expect(candidate.body).not.toMatch(ARABIC_LETTERS);
        // And not one of them is a key into `COPY_CATALOGUE`'s rendering.
        expect(COPY_CATALOGUE[candidate.title]).toBeUndefined();
      }
      expect(candidates[0].body).toContain('water');
    });
  });

  // =========================================================================
  // ACT II — WHAT THE ENGINE PUTS IN THE CHILD'S INBOX
  // =========================================================================

  describe('ACT II — the engine, through its real entry point, for two children of different ages', () => {
    const bodies: Record<string, string> = {};

    it('a twelve-year-old receives ARABIC, from the catalogue, inside their safety ceiling', async () => {
      const result = await fireStreak(older, 'first', goldenAt('12:10'));

      expect(result.decision.targetAudience).toBe('CHILD');
      expect(result.outcome?.decision).toBe('SEND');

      const [message] = await childMessageRows(older, 'STREAK_ACHIEVED');
      expect(message).toBeDefined();
      bodies.older = message.body;

      // THE GATE. A message to a child is `PENDING` and undelivered until a
      // parent says so — the engine does not, and cannot, bypass it.
      expect(message.approval_status).toBe('PENDING');
      expect(message.delivered_at).toBeNull();

      // THE IDEMPOTENCY KEY. The PRODUCER's key — the engine never invents one,
      // because "what makes this the same notification" is a decision the call
      // site has to have made — plus an explicit `:child` AUDIENCE FACET. The
      // facet is why one cause may legitimately notify a parent AND a child
      // without either deduplicating the other away, and why it is a facet
      // rather than an accident of two different tables.
      expect(message.source_event_id).toBe(`golden:e2e06:${older.label}:first:child`);
      expect(message.source_event_id.startsWith(`golden:e2e06:${older.label}:first`)).toBe(true);

      // ARABIC, WITH ARABIC-INDIC DIGITS.
      expect(message.body).toMatch(ARABIC_LETTERS);
      expect(message.body).not.toMatch(WESTERN_DIGITS);
      expect(message.body).toMatch(AR_INDIC_DIGITS);

      // FROM LOCALIZATION — byte-identical to what the catalogue renders for
      // this key, this tone band and this locale. Nothing was typed in a
      // service, and no enum or unresolved placeholder survived.
      // FILTERED BY CAUSE. ACT I's reward loop now writes decision rows of its
      // own (`F6-003`), so «the first row for this household» is no longer the
      // same thing as «the row for this streak».
      const [decision] = await decisionRows(older, 'STREAK_ACHIEVED');
      expect(decision.age_band).toBe('11-13');
      expect(decision.locale).toBe('ar');
      const rendered = renderNotificationCopy({
        key: decision.copy_key,
        audience: 'CHILD',
        toneBand: '11-13',
        locale: 'ar',
        variables: { days: 9 },
      });
      expect(message.body).toBe(rendered.body);
      expect(message.title).toBe(rendered.title);
      expect(hasEnumOrPlaceholderLeak(message.body)).toBe(false);
      expect(hasEnumOrPlaceholderLeak(message.title)).toBe(false);

      // NON-PUNITIVE.
      for (const word of PUNITIVE_VOCABULARY) {
        expect(message.body).not.toContain(word);
        expect(message.title).not.toContain(word);
      }

      // AND INSIDE THE SAFETY CEILING for a twelve-year-old, checked against
      // `age-band.ts` — the ceiling the tone engine is composed UNDER, not a
      // number restated here.
      const ceiling = profileForAge(12);
      expect(countWords(message.body)).toBeLessThanOrEqual(ceiling.maxWords);
      expect(message.body.length).toBeLessThanOrEqual(ceiling.maxChars);
    });

    it('a seven-year-old receives a DIFFERENT sentence for the identical event', async () => {
      const result = await fireStreak(younger, 'first', goldenAt('12:10'));
      expect(result.decision.targetAudience).toBe('CHILD');

      const [message] = await childMessageRows(younger, 'STREAK_ACHIEVED');
      bodies.younger = message.body;

      const [decision] = await decisionRows(younger, 'STREAK_ACHIEVED');
      expect(decision.age_band).toBe('5-7');
      expect(decision.locale).toBe('ar');

      // THE ASSERTION THIS SCENARIO EXISTS FOR: the same event, two children,
      // two sentences. A product that sent one string to both would be a
      // translation layer, not a coach.
      expect(bodies.younger).not.toBe(bodies.older);

      // The younger child gets the playful register — shorter, and with an
      // emoji the older child does not get.
      expect(countWords(bodies.younger)).toBeLessThanOrEqual(countWords(bodies.older));
      expect(/\p{Extended_Pictographic}/u.test(bodies.younger)).toBe(true);
      expect(/\p{Extended_Pictographic}/u.test(bodies.older)).toBe(false);

      // Still Arabic, still non-punitive, still inside the (narrower) ceiling.
      expect(message.body).toMatch(ARABIC_LETTERS);
      const ceiling = profileForAge(7);
      expect(countWords(message.body)).toBeLessThanOrEqual(ceiling.maxWords);
      expect(message.body.length).toBeLessThanOrEqual(ceiling.maxChars);
      for (const word of PUNITIVE_VOCABULARY) {
        expect(message.body).not.toContain(word);
      }
    });

    it('THE REPLAY — the same cause delivered again is ONE row, refused by the database', async () => {
      const before = await childMessageRows(older, 'STREAK_ACHIEVED');
      expect(before).toHaveLength(1);

      // Twice more, and well past the fatigue guard's five-minute duplicate
      // window so a pass here cannot be credited to the window.
      await fireStreak(older, 'first', goldenAt('12:25'));
      await fireStreak(older, 'first', goldenAt('12:55'));

      const after = await childMessageRows(older, 'STREAK_ACHIEVED');
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(before[0].id);
    });

    it('a DIFFERENT cause is a different message — the key deduplicates, not the type', async () => {
      await fireStreak(older, 'second', goldenAt('13:30'));
      const rows = await childMessageRows(older);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      // Whatever the fatigue policy decided about the second one, the two
      // causes are distinguishable: no row carries the other's key.
      const keys = rows.map((row) => row.source_event_id);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  // =========================================================================
  // ACT III — THE PARENT LETS IT THROUGH, AND ONLY THEN DOES THE CHILD SEE IT
  // =========================================================================

  describe('ACT III — the approval gate is the product, not a formality', () => {
    it("the child's own inbox does not show a PENDING message", async () => {
      const inbox = await request(world.http).get(`${P}/life-intelligence/self/messages`).set(asChild(older));
      expect(inbox.status).toBe(200);
      expect(inbox.body).toHaveLength(0);
    });

    it('the parent can SEE what is waiting, approve it, and only then does it reach the child', async () => {
      const pending = await request(world.http)
        .get(`${P}/life-intelligence/communication/pending`)
        .set(asParent(older));
      expect(pending.status).toBe(200);
      expect(pending.body.length).toBeGreaterThanOrEqual(1);
      const waiting = pending.body.find((m: any) => m.childName === older.childName);
      expect(waiting).toBeDefined();

      const approved = await request(world.http)
        .post(`${P}/life-intelligence/communication/${older.childId}/${waiting.id}/approve`)
        .set(asParent(older))
        .send({});
      expect([200, 201]).toContain(approved.status);

      const inbox = await request(world.http).get(`${P}/life-intelligence/self/messages`).set(asChild(older));
      expect(inbox.body.length).toBeGreaterThanOrEqual(1);
      const delivered = inbox.body.find((m: any) => m.id === waiting.id);
      expect(delivered).toBeDefined();
      expect(delivered.body).toMatch(ARABIC_LETTERS);
    });

    it("family B's parent cannot approve family A's child message — and is told it does not exist", async () => {
      const pending = await request(world.http)
        .get(`${P}/life-intelligence/communication/pending`)
        .set(asParent(younger));
      const theirs = pending.body[0];
      expect(theirs).toBeDefined();

      const stolen = await request(world.http)
        .post(`${P}/life-intelligence/communication/${younger.childId}/${theirs.id}/approve`)
        .set(asParent(older))
        .send({});

      // 404 and not 403: confirming that the message exists would leak the
      // existence of another household's child.
      expect(stolen.status).toBe(404);
    });
  });
});
