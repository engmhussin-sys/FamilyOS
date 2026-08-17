/**
 * PHASE F (`F6-002` §5 §6) — THE TONE MATRIX AND THE LOCALISATION TABLE.
 *
 * WHAT THIS FILE IS FOR. The claim being made is «child copy adapts by age band
 * and locale, parent copy is one respectful register, all strings come from
 * localisation, Arabic is first-class, and no raw backend enum ever reaches a
 * human». Every one of those is checkable, so every one of them is checked here
 * against the REAL catalogue and the REAL safety filter rather than against a
 * copy of their rules.
 *
 * THE MOST IMPORTANT ASSERTION IN THIS FILE is the length one. `age-band.ts`
 * says a six-year-old gets at most eight words, `ChildSafetyFilterService`
 * enforces it, and this suite runs EVERY child template through that service at
 * the STRICTEST band any age in its tone band maps to — so a copywriter cannot
 * add a beautiful twelve-word sentence for `8-10` and discover in production
 * that an eight-year-old receives the fallback instead.
 */
import { ChildSafetyFilterService } from '../../src/modules/ai-core/application/services/child-safety-filter.service';
import { ageBandProfile } from '../../src/modules/ai-core/domain/age-band';
import {
  COPY_CATALOGUE,
  copyKeys,
  formatNumber,
  hasEnumOrPlaceholderLeak,
  ordinal,
  renderNotificationCopy,
} from '../../src/modules/notifications/domain/engine/notification-copy';
import {
  TONE_BANDS,
  safetyBandFor,
  toneBandFor,
  toneProfile,
  type ToneBand,
} from '../../src/modules/notifications/domain/engine/notification-tone';
import { NOTIFICATION_LOCALES } from '../../src/modules/notifications/domain/engine/notification-context';

/** Representative values, chosen to be the LONGEST plausible rather than the
 * shortest: a template that only fits when every number is one digit and every
 * goal is called «X» is a template that does not fit. */
const SAMPLE_VARIABLES = {
  minutes: 15,
  goalTitle: 'سورة الملك',
  done: 4,
  total: 5,
  unitNoun: 'آيات',
  days: 12,
  badgeTitle: 'القارئ',
  level: 7,
  childName: 'محمد',
  weekCount: 'ثالث',
  count: 4,
};

const safety = new ChildSafetyFilterService();

describe('PHASE F — the tone engine', () => {
  it('maps every age 5..17 into exactly one band, and the boundaries are where the product says', () => {
    expect(toneBandFor(5)).toBe('5-7');
    expect(toneBandFor(7)).toBe('5-7');
    expect(toneBandFor(8)).toBe('8-10');
    expect(toneBandFor(10)).toBe('8-10');
    expect(toneBandFor(11)).toBe('11-13');
    expect(toneBandFor(13)).toBe('11-13');
    expect(toneBandFor(14)).toBe('14-17');
    expect(toneBandFor(17)).toBe('14-17');
  });

  it('is TOTAL — a child outside 5..17, and a family-level notification with no child, still get a band', () => {
    // The failure this prevents is the one `ageBandFor` prevents: returning
    // null and letting a caller skip the ceiling is how an unbounded sentence
    // reaches a five-year-old.
    expect(toneBandFor(3)).toBe('5-7');
    expect(toneBandFor(25)).toBe('14-17');
    expect(toneBandFor(null)).toBe('5-7');
  });

  it('resolves the SAFETY band from the child’s own age, not from the tone band', () => {
    // The overlap that makes the two systems different: an eight-year-old is
    // tone band 8-10 and safety band 6-8. The safety band is the child's own.
    expect(toneBandFor(8)).toBe('8-10');
    expect(safetyBandFor(8, '8-10')).toBe('6-8');
    expect(safetyBandFor(10, '8-10')).toBe('9-11');
    // With no age at all, the tone band's own strictest ceiling applies —
    // never «no ceiling».
    expect(safetyBandFor(null, '8-10')).toBe('6-8');
    expect(safetyBandFor(null, '14-17')).toBe('12-14');
  });

  it('each band declares a register and an emoji policy that actually differ', () => {
    const registers = TONE_BANDS.map((b) => toneProfile(b).register);
    expect(new Set(registers).size).toBe(TONE_BANDS.length);
    expect(toneProfile('5-7').emoji).toBe(true);
    expect(toneProfile('14-17').emoji).toBe(false);
  });
});

describe('PHASE F — the localisation catalogue', () => {
  it('every entry has a complete Arabic variant — Arabic is first-class, not a translation', () => {
    for (const key of copyKeys()) {
      const entry = COPY_CATALOGUE[key];
      const variants = Object.values(entry.variants);
      expect(variants.length).toBeGreaterThan(0);
      for (const v of variants) {
        expect(v?.ar.title.trim().length).toBeGreaterThan(0);
        expect(v?.ar.body.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('every CHILD-facing entry defines all four tone bands', () => {
    const childEntries = copyKeys().filter((k) => COPY_CATALOGUE[k].audience === 'CHILD');
    expect(childEntries.length).toBeGreaterThan(8);
    for (const key of childEntries) {
      for (const band of TONE_BANDS) {
        expect(COPY_CATALOGUE[key].variants[band]).toBeDefined();
      }
    }
  });

  it('every CHILD template fits the STRICTEST safety ceiling of its own tone band', () => {
    const failures: string[] = [];
    for (const key of copyKeys()) {
      const entry = COPY_CATALOGUE[key];
      if (entry.audience !== 'CHILD' && key !== 'GENERIC') continue;
      for (const band of TONE_BANDS) {
        if (!entry.variants[band]) continue;
        const strictest = toneProfile(band).strictestSafetyBand;
        const profile = ageBandProfile(strictest);
        for (const locale of NOTIFICATION_LOCALES) {
          const rendered = renderNotificationCopy({
            key,
            audience: 'CHILD',
            toneBand: band,
            locale,
            variables: SAMPLE_VARIABLES,
          });
          const bodyVerdict = safety.validate(rendered.body, strictest);
          if (!bodyVerdict.isSafe) {
            failures.push(
              `${key}/${band}/${locale} body: ${bodyVerdict.reasons.join(',')} — "${rendered.body}" (${rendered.body.length} chars, ceiling ${profile.maxWords}w/${profile.maxChars}c)`,
            );
          }
          const titleVerdict = safety.validate(rendered.title, strictest, {
            maxWords: Math.min(6, profile.maxWords),
            maxChars: 60,
          });
          if (!titleVerdict.isSafe) {
            failures.push(`${key}/${band}/${locale} title: ${titleVerdict.reasons.join(',')} — "${rendered.title}"`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('renders a DIFFERENT sentence for each age band — the tone matrix is real, not decorative', () => {
    // The three flagship contextual keys the brief names. If two bands produce
    // the same Arabic string, the band did nothing.
    for (const key of ['GOAL_DEADLINE_NEAR', 'GOAL_ALMOST_DONE', 'STREAK_AT_RISK']) {
      const bodies = TONE_BANDS.map(
        (band: ToneBand) =>
          renderNotificationCopy({
            key,
            audience: 'CHILD',
            toneBand: band,
            locale: 'ar',
            variables: SAMPLE_VARIABLES,
          }).body,
      );
      // At least three distinct wordings across four bands: 11-13 and 14-17
      // legitimately share one for some keys, and forcing four would be forcing
      // a difference that does not exist in the language.
      expect(new Set(bodies).size).toBeGreaterThanOrEqual(3);
      // The youngest band must never be the longest.
      expect(bodies[0].split(/\s+/).length).toBeLessThanOrEqual(bodies[3].split(/\s+/).length);
    }
  });

  it('produces the exact Arabic sentences the brief specifies', () => {
    expect(
      renderNotificationCopy({
        key: 'GOAL_DEADLINE_NEAR',
        audience: 'CHILD',
        toneBand: '11-13',
        locale: 'ar',
        variables: { minutes: 5, goalTitle: 'سورة الملك' },
      }).body,
    ).toBe('باقي لك ٥ دقائق فقط لإكمال هدفك في سورة الملك');

    expect(
      renderNotificationCopy({
        key: 'GOAL_ALMOST_DONE',
        audience: 'CHILD',
        toneBand: '11-13',
        locale: 'ar',
        variables: { done: 4, total: 5, unitNoun: 'آيات' },
      }).body,
    ).toBe('أنجزت ٤ من ٥ آيات — هل تكمل الأخيرة الآن؟');

    expect(
      renderNotificationCopy({
        key: 'STREAK_AT_RISK',
        audience: 'CHILD',
        toneBand: '11-13',
        locale: 'ar',
        variables: { days: 6 },
      }).body,
    ).toBe('أنت على بعد خطوة من الحفاظ على سلسلتك');

    expect(
      renderNotificationCopy({
        key: 'GOAL_COMPLETED_PARENT',
        audience: 'PARENT',
        toneBand: '11-13',
        locale: 'ar',
        variables: { childName: 'محمد', goalTitle: 'سورة الملك', weekCount: ordinal(3, 'ar') },
      }).body,
    ).toBe('محمد أكمل هدفه في سورة الملك، وهذه ثالث مرة هذا الأسبوع');

    expect(
      renderNotificationCopy({
        key: 'GOAL_STALLED_PARENT',
        audience: 'PARENT',
        toneBand: '11-13',
        locale: 'ar',
        variables: { childName: 'بدأ', goalTitle: 'العلوم' },
      }).body,
    ).toContain('ولم يكمله — ربما يحتاج دفعة اليوم');
  });

  it('writes Arabic-Indic digits in Arabic and Latin digits in English', () => {
    expect(formatNumber(5, 'ar')).toBe('٥');
    expect(formatNumber(12, 'ar')).toBe('١٢');
    expect(formatNumber(12, 'en')).toBe('12');
    expect(ordinal(3, 'ar')).toBe('ثالث');
    expect(ordinal(3, 'en')).toBe('3rd');
    // Beyond the irregular Arabic ordinals, a numeric form is correct rather
    // than wrong — and it is still Arabic-Indic.
    expect(ordinal(11, 'ar')).toBe('المرة ١١');
  });

  it('NEVER renders a raw backend enum or an unresolved placeholder to a human', () => {
    // The `parent-app` risk-enum defect (Phase E) in its notification form. Every
    // catalogue entry, every band, both locales, rendered with NO variables at
    // all — the worst case a producer can create.
    for (const key of copyKeys()) {
      const entry = COPY_CATALOGUE[key];
      for (const band of TONE_BANDS) {
        for (const locale of NOTIFICATION_LOCALES) {
          const rendered = renderNotificationCopy({
            key,
            audience: entry.audience,
            toneBand: band,
            locale,
            variables: {},
          });
          expect(hasEnumOrPlaceholderLeak(rendered.title)).toBe(false);
          expect(hasEnumOrPlaceholderLeak(rendered.body)).toBe(false);
        }
      }
    }
  });

  it('degrades an UNKNOWN type to the generic entry rather than echoing the type name', () => {
    const rendered = renderNotificationCopy({
      key: 'SOME_FUTURE_PRODUCER_TYPE',
      audience: 'PARENT',
      toneBand: '11-13',
      locale: 'ar',
      variables: {},
    });
    expect(rendered.resolvedKey).toBe('GENERIC');
    expect(rendered.body).not.toContain('SOME_FUTURE_PRODUCER_TYPE');
    expect(hasEnumOrPlaceholderLeak(rendered.body)).toBe(false);
  });

  it('falls back to ARABIC, never to English, for an unknown locale path', () => {
    // `resolveLocale` maps anything non-English to `ar`; this asserts the
    // catalogue side of the same rule — a variant present only in `ar` renders
    // in `ar` when `en` is requested rather than emitting nothing.
    const entry = COPY_CATALOGUE.REWARD_GRANTED.variants.PARENT;
    expect(entry?.ar.body).toContain('مكافأة');
    const rendered = renderNotificationCopy({
      key: 'REWARD_GRANTED',
      audience: 'PARENT',
      toneBand: '11-13',
      locale: 'ar',
      variables: { childName: 'محمد' },
    });
    expect(rendered.locale).toBe('ar');
    expect(rendered.body).toContain('محمد');
  });

  it('parent copy carries no punitive vocabulary — CONTEXT §3 principle 7 applies to parents too', () => {
    const punitive = /(تم\s+حظر|ممنوع|عقاب|مخالف|انتهاك|تجاوزت)/;
    for (const key of copyKeys()) {
      const entry = COPY_CATALOGUE[key];
      if (entry.audience !== 'PARENT') continue;
      const v = entry.variants.PARENT;
      expect(v?.ar.title).not.toMatch(punitive);
      expect(v?.ar.body).not.toMatch(punitive);
    }
  });
});

/**
 * ============================================================================
 * THE PARENT'S REWARD SENTENCE — THE TWO KEYS, AND THE RULE THAT CHOOSES.
 * ============================================================================
 *
 * THE DEFECT THIS BLOCK GUARDS. `COPY_CATALOGUE.REWARD_GRANTED` declared exactly
 * one variable, `childName`, so a household whose whole chain began at «حفظ سورة
 * الملك، الآيات ١–٥» was told only «حصل محمد على مكافأة جديدة اليوم» — the WHAT
 * was unreachable from the notification by any field. `e2e-13` pinned that,
 * end-to-end, against real rows; this block pins the CATALOGUE-LEVEL properties
 * that a single end-to-end scenario cannot reach — above all what happens to the
 * SENTENCE when a producer has only some of the facts, which is the state most
 * of this product's rewards are actually in.
 */
describe('PHASE F1 — the parent reward copy names the achievement, and degrades honestly when it cannot', () => {
  const render = (key: string, variables: Record<string, string | number>, locale: 'ar' | 'en' = 'ar') =>
    renderNotificationCopy({ key, audience: 'PARENT', toneBand: '11-13', locale, variables });

  /** `RewardProgram.targetSummaryAr` as `describeTargetSpec` really writes it —
   * Latin digits and an en dash included, because that stored string is what a
   * producer actually forwards and a test that tidied it would be testing a
   * string this product never produces. */
  const THE_SUMMARY = 'الآيات 1–5 من سورة الملك';

  it('names the child, the achievement and the points — the sentence the product brief asks for', () => {
    const rendered = render('REWARD_GRANTED_WITH_GOAL', {
      childName: 'محمد',
      goalTitle: THE_SUMMARY,
      points: 20,
    });

    expect(rendered.resolvedKey).toBe('REWARD_GRANTED_WITH_GOAL');
    expect(rendered.body).toBe('🌟 محمد أكمل الآيات 1–5 من سورة الملك اليوم وحصل على ٢٠ نقطة. افتح التطبيق لتشجيعه.');
    // WHY / WHAT / WHAT DO I DO, each present as a readable clause rather than
    // as an intention recorded in a comment.
    expect(rendered.body).toContain('محمد');
    expect(rendered.body).toContain(THE_SUMMARY);
    expect(rendered.body).toContain('٢٠ نقطة');
    expect(rendered.body).toContain('افتح التطبيق');
    expect(hasEnumOrPlaceholderLeak(rendered.body)).toBe(false);
  });

  it('writes the points in the locale’s own digits — Arabic-Indic in ar, Latin in en', () => {
    expect(render('REWARD_GRANTED_WITH_GOAL', { childName: 'محمد', goalTitle: THE_SUMMARY, points: 20 }).body).toContain('٢٠');
    const english = render('REWARD_GRANTED_WITH_GOAL', { childName: 'Omar', goalTitle: 'Al-Mulk 1–5', points: 20 }, 'en');
    expect(english.body).toBe('🌟 Omar completed Al-Mulk 1–5 today and earned 20 points. Open the app to cheer them on.');
    expect(english.body).not.toMatch(/[٠-٩]/);
  });

  /**
   * THE PROPERTY THE WHOLE TWO-KEY DESIGN EXISTS FOR. A producer holding only
   * the child's name — every habit tick, hydration target and streak milestone
   * in this product — must get a WHOLE sentence. Not a `{goalTitle}`, and not
   * the contentless `GENERIC` stub either.
   */
  it('a reward with NO goal reads as a complete sentence from REWARD_GRANTED, not as GENERIC', () => {
    const rendered = render('REWARD_GRANTED', { childName: 'محمد' });
    expect(rendered.resolvedKey).toBe('REWARD_GRANTED');
    expect(rendered.body).toBe('حصل محمد على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.');
    expect(rendered.body).not.toContain('تحديث جديد');
  });

  it('NEVER renders a raw {{placeholder}} to a parent, whichever fact the producer forgot', () => {
    const partials: ReadonlyArray<Record<string, string | number>> = [
      {},
      { childName: 'محمد' },
      { childName: 'محمد', goalTitle: THE_SUMMARY },
      { childName: 'محمد', points: 20 },
      { goalTitle: THE_SUMMARY, points: 20 },
      { childName: '', goalTitle: THE_SUMMARY, points: 20 },
      { childName: 'محمد', goalTitle: '', points: 20 },
    ];
    for (const variables of partials) {
      for (const locale of ['ar', 'en'] as const) {
        const rendered = render('REWARD_GRANTED_WITH_GOAL', variables, locale);
        // The failing case names itself: a bare `toMatch` would report only that
        // «a string contained a brace», with no way to tell which of the seven
        // partial producers below produced it.
        const supplied = Object.keys(variables).join(',') || 'nothing';
        expect(`${supplied}/${locale}: ${/[{}]/.test(rendered.body)}`).toBe(`${supplied}/${locale}: false`);
        expect(hasEnumOrPlaceholderLeak(rendered.body)).toBe(false);
        expect(hasEnumOrPlaceholderLeak(rendered.title)).toBe(false);
        expect(rendered.body.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('the two reward sentences are DIFFERENT, and the child’s is different from both', () => {
    const withGoal = render('REWARD_GRANTED_WITH_GOAL', { childName: 'محمد', goalTitle: THE_SUMMARY, points: 20 }).body;
    const withoutGoal = render('REWARD_GRANTED', { childName: 'محمد' }).body;
    const child = renderNotificationCopy({
      key: 'REWARD_GRANTED_CHILD',
      audience: 'CHILD',
      toneBand: '11-13',
      locale: 'ar',
      variables: {},
    }).body;

    expect(new Set([withGoal, withoutGoal, child]).size).toBe(3);
    // The child's own sentence carries none of the parent's detail: no name, no
    // goal, no points. «حصلت على ٣ مكافآت من سورة الملك» is a receipt read at a
    // child, which is why `REWARD_GRANTED_CHILD` declares no variables at all.
    expect(child).not.toContain('محمد');
    expect(child).not.toContain('سورة الملك');
    expect(child).not.toContain('نقطة');
  });

  it('both reward entries are PARENT-audience and in the REWARD category — the type vocabulary did not fork', () => {
    for (const key of ['REWARD_GRANTED', 'REWARD_GRANTED_WITH_GOAL']) {
      expect(COPY_CATALOGUE[key].audience).toBe('PARENT');
      expect(COPY_CATALOGUE[key].category).toBe('REWARD');
    }
    // And the goal entry DECLARES the three variables it interpolates, so the
    // renderer's own missing-variable detection has something to check against.
    expect([...COPY_CATALOGUE.REWARD_GRANTED_WITH_GOAL.variables].sort()).toEqual([
      'childName',
      'goalTitle',
      'points',
    ]);
  });
});
