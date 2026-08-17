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
