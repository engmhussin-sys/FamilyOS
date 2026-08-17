/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-10 — G10/G11/G12/G13. WHOSE LANGUAGE IS IT, AND WHO DECIDED?
 * ============================================================================
 *
 * THE PRODUCT CLAIM. ABNY is an Arabic-first product for Arab households
 * (CONTEXT §1), and «Arabic-first» is a claim about the DEFAULT, not about the
 * only option: a household whose owner reads English must get English, and
 * neither audience may ever be shown the raw material the copy is made of.
 *
 * FOUR SCENARIOS, TWO AXES — audience × locale — and each cell is a row in a
 * real table after a real reward earned over real HTTP:
 *
 *   G10  ARABIC CHILD    `child_messages`  · Arabic letters, Arabic-Indic digits,
 *                        inside the §11.3 ceiling for THIS child's band
 *   G11  ARABIC PARENT   `notifications`   · Arabic, carrying the child's own name
 *   G12  ENGLISH CHILD   `child_messages`  · English, and STILL inside the band
 *   G13  ENGLISH PARENT  `notifications`   · English, carrying the child's name
 *
 * WHAT «FROM LOCALIZATION» IS ASSERTED TO MEAN, so it is not a matter of taste.
 * Each stored string is compared BYTE-FOR-BYTE with what `renderNotificationCopy`
 * produces for the copy key, tone band and locale that the DECISION ROW itself
 * names. Not «contains Arabic», not «looks localized» — identical. A string typed
 * into a service cannot pass that, and neither can a string rendered at the
 * wrong band or the wrong locale.
 *
 * AND WHERE THE LOCALE COMES FROM IS ASSERTED, NOT ASSUMED. `PF-E-002` is this
 * codebase's record of a default locale that was not Arabic reaching an Arab
 * household. So ACT III takes ONE household, flips `users.locale` on the OWNER
 * row, fires a SECOND cause, and requires the decision to follow the column.
 * Same family, same child, same event type, same band — the single variable is
 * that column, which is what makes it evidence about the column.
 *
 * ON THE AGE BAND. Two of the four cells use a SEVEN-year-old and two a
 * TWELVE-year-old, because a ceiling that is not per-child is not a ceiling: the
 * §11.3 limits are read from `age-band.ts` at the child's real age rather than
 * restated here, and the two children are asserted to receive DIFFERENT
 * sentences for the identical event.
 *
 * Real PostgreSQL, real Redis, real booted app, real HTTP. Nothing stubbed.
 */
import {
  P,
  ageTheHousehold,
  asParent,
  asChild,
  bootGoldenWorld,
  describeGolden,
  freezeGoldenClock,
  goldenAt,
  GOLDEN_NOON,
  type GoldenHousehold,
  type GoldenWorld,
} from './golden-world';
import {
  hasEnumOrPlaceholderLeak,
  renderNotificationCopy,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import { countWords, profileForAge } from '../../src/modules/ai-core/domain/age-band';

import request = require('supertest');

const ARABIC_LETTERS = /[؀-ۿ]/;
const LATIN_LETTERS = /[A-Za-z]/;
const WESTERN_DIGITS = /[0-9]/;
const ARABIC_INDIC_DIGITS = /[٠-٩]/;

/** CONTEXT §3 principle 7, verbatim — forbidden to a child in either language. */
const PUNITIVE_VOCABULARY = ['ممنوع', 'تجاوزت', 'فشلت', 'محظور', 'عقاب', 'blocked', 'punish', 'failed'];

describeGolden('GOLDEN E2E-10 — G10/G11/G12/G13: the language of the household, and the column that decides it', () => {
  let world: GoldenWorld;
  /** G10 + G11: the default household — nothing about locale was ever sent. */
  let arabic: GoldenHousehold;
  /** G12 + G13: the same product, an English-reading owner. */
  let english: GoldenHousehold;
  /** The band control: a seven-year-old in the Arabic household's own language. */
  let younger: GoldenHousehold;

  const AGE_ARABIC = 12;
  const AGE_ENGLISH = 12;
  const AGE_YOUNGER = 7;

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('golden E2E-10 (locale)');
    const year = Number(GOLDEN_NOON.toISOString().slice(0, 4));
    arabic = await world.register('e2e10ar', {
      childName: 'محمد',
      childDateOfBirth: `${year - AGE_ARABIC}-01-05`,
    });
    english = await world.register('e2e10en', {
      childName: 'Yusuf',
      childDateOfBirth: `${year - AGE_ENGLISH}-01-05`,
    });
    younger = await world.register('e2e10y', {
      childName: 'سلمى',
      childDateOfBirth: `${year - AGE_YOUNGER}-01-05`,
    });
    for (const h of [arabic, english, younger]) await ageTheHousehold(world, h, goldenAt('08:00'));

    // THE ONLY FIXTURE DIFFERENCE BETWEEN THE TWO HOUSEHOLDS, and it is the
    // column the assembler reads: `familyMember(role=OWNER).user.locale`. The
    // registration flow sends no locale — which is how the mobile app registers
    // one — so `arabic` keeps migration `0019`'s Arabic default untouched, and
    // that untouched default is itself `PF-E-002` holding.
    await world.sys('the English household’s owner reads English', () =>
      world.prisma.user.update({ where: { id: english.ownerUserId }, data: { locale: 'en' } }),
    );
  }, 240_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  // ---------------------------------------------------------------- helpers

  const childMessages = (h: GoldenHousehold, category: string): Promise<any[]> =>
    world.raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid AND "category" = $2
         ORDER BY "created_at", "id"`,
      h.familyId,
      category,
    );

  const parentNotifications = (h: GoldenHousehold, type: string): Promise<any[]> =>
    world.raw<any[]>(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid AND "type" = $2
         ORDER BY "created_at", "id"`,
      h.familyId,
      type,
    );

  const decision = async (h: GoldenHousehold, eventType: string): Promise<any> => {
    const found = await world.raw<any[]>(
      `SELECT * FROM "notification_decisions"
         WHERE "family_id" = $1::uuid AND "event_type" = $2
         ORDER BY "created_at", "id"`,
      h.familyId,
      eventType,
    );
    expect(found).toHaveLength(1);
    return found[0];
  };

  /** The real product loop, six HTTP calls, no engine call and no double. */
  async function earnAReward(h: GoldenHousehold, unit: string): Promise<void> {
    const program = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(h))
      .send({
        childId: h.childId,
        category: 'HOUSEWORK',
        activity: 'CHORE',
        targetSpec: { quantity: 1, unit },
        durationMinutes: 10,
        verificationLevel: 'SELF_CHECK',
        rewardSpec: { type: 'POINTS', amount: 10 },
      });
    expect([200, 201]).toContain(program.status);
    const started = await request(world.http)
      .post(`${P}/self/achievements/start`)
      .set(asChild(h))
      .send({ programId: program.body.id });
    const submitted = await request(world.http)
      .post(`${P}/self/achievements/${started.body.id}/submit`)
      .set(asChild(h))
      .send({ selfConfirmed: true });
    expect(submitted.body.status).toBe('VERIFIED');
    const drain = await world.drainOutbox();
    expect(drain.failed).toBe(0);
  }

  /**
   * THE «FROM LOCALIZATION» ASSERTION, ONCE. The decision row names the copy key,
   * the tone band and the locale; rendering THAT triple must reproduce the stored
   * row exactly. Everything else in this file is a property of the sentence; this
   * is the property of its PROVENANCE.
   */
  function assertRenderedFromCatalogue(
    row: { title: string; body: string },
    d: { copy_key: string; age_band: string | null; locale: string; target_audience: string },
    variables: Readonly<Record<string, string | number>>,
  ): void {
    const rendered = renderNotificationCopy({
      key: d.copy_key,
      audience: d.target_audience as 'CHILD' | 'PARENT',
      toneBand: (d.age_band ?? 'PARENT') as any,
      locale: d.locale as 'ar' | 'en',
      variables,
    });
    expect(row.title).toBe(rendered.title);
    expect(row.body).toBe(rendered.body);
    // AND NO RAW MATERIAL. Not an `ALL_CAPS_SNAKE` enum, not an unresolved
    // `{placeholder}` — the two ways a catalogue leaks its own internals.
    expect(hasEnumOrPlaceholderLeak(row.title)).toBe(false);
    expect(hasEnumOrPlaceholderLeak(row.body)).toBe(false);
  }

  beforeAll(async () => {
    await earnAReward(arabic, 'مهمة');
    await earnAReward(english, 'task');
    await earnAReward(younger, 'مهمة');
  }, 240_000);

  // =========================================================================
  // G10 — THE ARABIC CHILD
  // =========================================================================

  describe('G10 — the Arabic child: the wedge, in the product’s first language', () => {
    it('the message is Arabic with Arabic-Indic digits, from the catalogue, at THIS child’s band', async () => {
      const rows = await childMessages(arabic, 'REWARD_GRANTED_CHILD');
      expect(rows).toHaveLength(1);
      const [message] = rows;
      const d = await decision(arabic, 'REWARD_GRANTED_CHILD');

      expect(d.target_audience).toBe('CHILD');
      expect(d.locale).toBe('ar');
      expect(message.body).toMatch(ARABIC_LETTERS);
      // `PF-E-002`: Arabic prose with Latin numerals reads as a translation.
      expect(message.body).not.toMatch(WESTERN_DIGITS);
      expect(message.title).not.toMatch(WESTERN_DIGITS);

      assertRenderedFromCatalogue(message, d, {});
    });

    it('and it fits inside the §11.3 ceiling for a twelve-year-old, read from `age-band.ts` rather than restated', async () => {
      const [message] = await childMessages(arabic, 'REWARD_GRANTED_CHILD');
      const ceiling = profileForAge(AGE_ARABIC);
      expect(countWords(message.body)).toBeLessThanOrEqual(ceiling.maxWords);
      expect(message.body.length).toBeLessThanOrEqual(ceiling.maxChars);
    });

    it('non-punitive, and still behind the §5.8 approval gate — the wedge is not a way around it', async () => {
      const [message] = await childMessages(arabic, 'REWARD_GRANTED_CHILD');
      for (const word of PUNITIVE_VOCABULARY) {
        expect(`${word}:${message.body.includes(word)}`).toBe(`${word}:false`);
        expect(`${word}:${message.title.includes(word)}`).toBe(`${word}:false`);
      }
      expect(message.approval_status).toBe('PENDING');
      expect(message.delivered_at).toBeNull();
    });

    it('THE BAND IS THE CHILD’S OWN — a seven-year-old gets a DIFFERENT sentence for the identical event', async () => {
      const [twelve] = await childMessages(arabic, 'REWARD_GRANTED_CHILD');
      const [seven] = await childMessages(younger, 'REWARD_GRANTED_CHILD');
      const dSeven = await decision(younger, 'REWARD_GRANTED_CHILD');

      expect(dSeven.locale).toBe('ar');
      expect(dSeven.age_band).not.toBe((await decision(arabic, 'REWARD_GRANTED_CHILD')).age_band);
      expect(seven.body).not.toBe(twelve.body);
      assertRenderedFromCatalogue(seven, dSeven, {});

      const ceiling = profileForAge(AGE_YOUNGER);
      expect(countWords(seven.body)).toBeLessThanOrEqual(ceiling.maxWords);
      expect(seven.body.length).toBeLessThanOrEqual(ceiling.maxChars);
    });
  });

  // =========================================================================
  // G11 — THE ARABIC PARENT
  // =========================================================================

  describe('G11 — the Arabic parent: the same fact, a different message', () => {
    it('the notification is Arabic, from the catalogue, and names the child rather than saying «your child»', async () => {
      const rows = await parentNotifications(arabic, 'REWARD_GRANTED');
      expect(rows).toHaveLength(1);
      const [notification] = rows;
      const d = await decision(arabic, 'REWARD_GRANTED');

      expect(d.target_audience).toBe('PARENT');
      expect(d.locale).toBe('ar');
      expect(notification.body).toMatch(ARABIC_LETTERS);
      // «طفلك» fails in a household with three children — this is the product
      // reason the name is a copy variable at all.
      expect(notification.body).toContain(arabic.childName);
      assertRenderedFromCatalogue(notification, d, { childName: arabic.childName });
    });

    it('the child’s and the parent’s sentences are NOT the same string — two audiences, two messages about one fact', async () => {
      const [childMessage] = await childMessages(arabic, 'REWARD_GRANTED_CHILD');
      const [notification] = await parentNotifications(arabic, 'REWARD_GRANTED');
      expect(childMessage.body).not.toBe(notification.body);
      // And the child's copy carries NO parent-facing detail: the child's own
      // name is the parent's sentence, not the child's.
      expect(childMessage.body).not.toContain(arabic.childName);
    });
  });

  // =========================================================================
  // G12 + G13 — ENGLISH, BOTH AUDIENCES
  // =========================================================================

  describe('G12 — the English child: the locale is honoured, and the ceiling still is', () => {
    it('the message is English, from the catalogue at locale `en`, with no Arabic left in it', async () => {
      const rows = await childMessages(english, 'REWARD_GRANTED_CHILD');
      expect(rows).toHaveLength(1);
      const [message] = rows;
      const d = await decision(english, 'REWARD_GRANTED_CHILD');

      expect(d.target_audience).toBe('CHILD');
      expect(d.locale).toBe('en');
      expect(message.body).toMatch(LATIN_LETTERS);
      expect(message.body).not.toMatch(ARABIC_LETTERS);
      // Symmetry with `PF-E-002`: an English sentence must not carry Arabic-Indic
      // digits either. A locale is a whole answer or it is a half-translation.
      expect(message.body).not.toMatch(ARABIC_INDIC_DIGITS);

      assertRenderedFromCatalogue(message, d, {});
    });

    it('an English sentence is held to the SAME §11.3 ceiling — the band is about the child, not the language', async () => {
      const [message] = await childMessages(english, 'REWARD_GRANTED_CHILD');
      const ceiling = profileForAge(AGE_ENGLISH);
      expect(countWords(message.body)).toBeLessThanOrEqual(ceiling.maxWords);
      expect(message.body.length).toBeLessThanOrEqual(ceiling.maxChars);
    });

    it('non-punitive in English too, and behind the same approval gate', async () => {
      const [message] = await childMessages(english, 'REWARD_GRANTED_CHILD');
      for (const word of PUNITIVE_VOCABULARY) {
        expect(`${word}:${message.body.toLowerCase().includes(word.toLowerCase())}`).toBe(`${word}:false`);
      }
      expect(message.approval_status).toBe('PENDING');
      expect(message.delivered_at).toBeNull();
    });

    it('AND IT IS A DIFFERENT STRING FROM THE ARABIC ONE — identical event, identical band, different locale', async () => {
      const [ar] = await childMessages(arabic, 'REWARD_GRANTED_CHILD');
      const [en] = await childMessages(english, 'REWARD_GRANTED_CHILD');
      const dAr = await decision(arabic, 'REWARD_GRANTED_CHILD');
      const dEn = await decision(english, 'REWARD_GRANTED_CHILD');
      // Same key, same band: so the ONLY thing that differs is the locale, and
      // the two sentences differ. That is the whole claim of G12.
      expect(dEn.copy_key).toBe(dAr.copy_key);
      expect(dEn.age_band).toBe(dAr.age_band);
      expect(en.body).not.toBe(ar.body);
    });
  });

  describe('G13 — the English parent', () => {
    it('the notification is English, from the catalogue, and names the child', async () => {
      const rows = await parentNotifications(english, 'REWARD_GRANTED');
      expect(rows).toHaveLength(1);
      const [notification] = rows;
      const d = await decision(english, 'REWARD_GRANTED');

      expect(d.locale).toBe('en');
      expect(notification.body).toMatch(LATIN_LETTERS);
      expect(notification.body).not.toMatch(ARABIC_LETTERS);
      expect(notification.body).toContain(english.childName);
      assertRenderedFromCatalogue(notification, d, { childName: english.childName });
    });

    it('and it is a different string from the Arabic parent’s, for the same event', async () => {
      const [ar] = await parentNotifications(arabic, 'REWARD_GRANTED');
      const [en] = await parentNotifications(english, 'REWARD_GRANTED');
      expect(en.body).not.toBe(ar.body);
    });
  });

  // =========================================================================
  // THE PROVENANCE OF THE LOCALE ITSELF
  // =========================================================================

  describe('THE COLUMN — `user.locale` on the family OWNER is what decided all of the above', () => {
    /**
     * PAIRED BY CAUSE, NOT BY ORDER — and the first draft of this block was
     * ordered and wrong.
     *
     * Five of the eight golden files FREEZE the clock, so every row this suite
     * writes carries the SAME `created_at` and `ORDER BY created_at, id` degrades
     * to ordering by a random UUID. The block below read `messages[0]` expecting
     * the English one and got the Arabic one — a flake that would have been green
     * roughly half the time, which is the worst possible outcome for a test about
     * provenance.
     *
     * So each `child_messages` row is joined to the DECISION that produced it on
     * the key the producer composed (`{decision.source_event_id}:child`). That is
     * not merely order-independent — it is a stronger claim: this sentence came
     * from THIS decision, rather than «one of the sentences is Arabic».
     */
    const pairedChildMessages = async (
      h: GoldenHousehold,
    ): Promise<ReadonlyArray<{ locale: string; body: string; title: string; decision: any }>> => {
      const [decisions, messages] = await Promise.all([
        world.raw<any[]>(
          `SELECT * FROM "notification_decisions"
             WHERE "family_id" = $1::uuid AND "event_type" = 'REWARD_GRANTED_CHILD'`,
          h.familyId,
        ),
        childMessages(h, 'REWARD_GRANTED_CHILD'),
      ]);
      return decisions.map((d) => {
        const match = messages.filter((m) => m.source_event_id === `${d.source_event_id}:child`);
        // ONE message per decision, or the causal key is not doing its job.
        expect(match).toHaveLength(1);
        return { locale: d.locale, body: match[0].body, title: match[0].title, decision: d };
      });
    };

    it('flipping the owner’s locale flips the NEXT decision, in the SAME household, for the SAME child', async () => {
      // The English household has already produced `en` rows above. Now the
      // owner switches to Arabic, a SECOND cause is fired through the real
      // product loop, and the decision must follow the column. One variable.
      const before = await decision(english, 'REWARD_GRANTED_CHILD');
      expect(before.locale).toBe('en');

      await world.sys('the owner switches to Arabic', () =>
        world.prisma.user.update({ where: { id: english.ownerUserId }, data: { locale: 'ar' } }),
      );

      await earnAReward(english, 'second task');

      const paired = await pairedChildMessages(english);
      expect(paired).toHaveLength(2);
      // Two causes, two locales — one each, in some order.
      expect(paired.map((p) => p.locale).sort()).toEqual(['ar', 'en']);

      // AND THE STORED SENTENCE FOLLOWED ITS OWN DECISION. A decision row saying
      // `ar` beside a row that is still English is the worse failure, because the
      // ledger would then be describing something that did not happen.
      for (const p of paired) {
        if (p.locale === 'ar') {
          expect(p.body).toMatch(ARABIC_LETTERS);
        } else {
          expect(p.body).not.toMatch(ARABIC_LETTERS);
        }
        assertRenderedFromCatalogue(p, p.decision, {});
      }
    });

    it('a locale nobody supports degrades to ARABIC, not to an enum or an empty string — `PF-E-002`’s own direction', async () => {
      await world.sys('an unsupported locale', () =>
        world.prisma.user.update({ where: { id: english.ownerUserId }, data: { locale: 'fr-FR' } }),
      );

      await earnAReward(english, 'third task');

      const paired = await pairedChildMessages(english);
      expect(paired).toHaveLength(3);
      // `resolveLocale` answers `ar` for anything it does not recognise, which is
      // the honest default for an Arabic-first product rather than a fallback to
      // English or — worse — to the raw tag. So `fr-FR` adds a SECOND `ar`.
      expect(paired.map((p) => p.locale).sort()).toEqual(['ar', 'ar', 'en']);
      for (const p of paired.filter((x) => x.locale === 'ar')) {
        expect(p.body).toMatch(ARABIC_LETTERS);
        expect(hasEnumOrPlaceholderLeak(p.body)).toBe(false);
        // And never the raw tag itself, which is the leak this asserts against.
        expect(p.body).not.toContain('fr');
      }
    });
  });
});
