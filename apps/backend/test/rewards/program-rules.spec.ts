/**
 * PROGRAM AUTHORING AND PROGRAM RULES — the deterministic halves.
 *
 * Everything here is a pure function, so these are the assertions that stay
 * meaningful whatever the database is doing: the target spec against the REAL
 * surah table, the reward spec including the screen-time ceiling, the multiplier
 * ladder, and the eleven per-program rules.
 */
import {
  CATEGORY_ACTIVITIES,
  CATEGORY_STREAK_KIND,
  PROGRAM_ACTIVITIES,
  PROGRAM_CATEGORIES,
  PROGRAM_CATEGORY_LABEL_AR,
  activityBelongsToCategory,
  isProgramCategory,
} from '../../src/shared/rewards/program-taxonomy';
import { describeTargetSpec, validateTargetSpec } from '../../src/shared/rewards/target-spec';
import {
  FULFILLABLE_REWARD_TYPES,
  MAX_ACTIVE_BONUS_MINUTES,
  MAX_SCREEN_TIME_GRANT_MINUTES,
  PROGRAM_REWARD_TYPES,
  REWARD_TYPE_TO_LEDGER,
  canTransitionFulfilment,
  validateRewardSpec,
} from '../../src/shared/rewards/reward-spec';
import {
  BASE_MULTIPLIER_BPS,
  STREAK_BONUS_THRESHOLDS,
  achievementGrantKeyPrefix,
  applyMultiplier,
  multiplierBpsForStreak,
  thresholdBonusForStreak,
} from '../../src/shared/rewards/streak-multiplier';
import { composeIdempotencyKey } from '../../src/shared/events/idempotency';
import {
  MAX_OPEN_ATTEMPTS_PER_DAY,
  ageInYears,
  checkProgramEligibility,
  localDateString,
  weekWindow,
} from '../../src/modules/rewards-engine/domain/program-rules';

describe('the program taxonomy', () => {
  it('has the 18 categories the brief lists, with Arabic labels', () => {
    expect(PROGRAM_CATEGORIES).toHaveLength(18);
    for (const c of PROGRAM_CATEGORIES) {
      expect(PROGRAM_CATEGORY_LABEL_AR[c].trim().length).toBeGreaterThan(0);
      expect(CATEGORY_ACTIVITIES[c].length).toBeGreaterThan(0);
      expect(CATEGORY_STREAK_KIND[c]).toBeDefined();
    }
  });

  it('every activity offered by a category is a real activity', () => {
    for (const c of PROGRAM_CATEGORIES) {
      for (const a of CATEGORY_ACTIVITIES[c]) {
        expect(PROGRAM_ACTIVITIES).toContain(a);
      }
    }
  });

  it('rejects a category/activity pairing that makes no sense', () => {
    expect(activityBelongsToCategory('SPORT', 'QURAN_MEMORIZE_JUZ')).toBe(false);
    expect(activityBelongsToCategory('QURAN', 'QURAN_MEMORIZE_AYAH_RANGE')).toBe(true);
  });

  it('is closed — an invented category is not a category', () => {
    expect(isProgramCategory('ASTROLOGY')).toBe(false);
  });
});

describe('validateTargetSpec — the Quran path', () => {
  const quran = (spec: Record<string, unknown>) =>
    validateTargetSpec('QURAN', 'QURAN_MEMORIZE_AYAH_RANGE', spec);

  it('accepts the flagship target: Al-Mulk, ayahs 1–5', () => {
    expect(quran({ surahNumber: 67, fromAyah: 1, toAyah: 5 })).toEqual([]);
  });

  it('REJECTS surah 115', () => {
    const errors = quran({ surahNumber: 115, fromAyah: 1, toAyah: 5 });
    expect(errors.map((e) => e.code)).toContain('SURAH_OUT_OF_RANGE');
  });

  it('REJECTS ayah 300 of Al-Mulk, and says the real count in Arabic', () => {
    const errors = quran({ surahNumber: 67, fromAyah: 1, toAyah: 300 });
    expect(errors.map((e) => e.code)).toContain('AYAH_OUT_OF_SURAH');
    expect(errors.find((e) => e.code === 'AYAH_OUT_OF_SURAH')!.messageAr).toContain('30');
  });

  it('REJECTS an inverted range', () => {
    expect(quran({ surahNumber: 67, fromAyah: 10, toAyah: 2 }).map((e) => e.code)).toContain(
      'AYAH_RANGE_INVERTED',
    );
  });

  it('REJECTS an activity outside its category', () => {
    expect(validateTargetSpec('SPORT', 'QURAN_MEMORIZE_JUZ', {}).map((e) => e.code)).toEqual([
      'ACTIVITY_NOT_IN_CATEGORY',
    ]);
  });

  it('REJECTS juz 31 — there are 30', () => {
    expect(
      validateTargetSpec('QURAN', 'QURAN_MEMORIZE_JUZ', { juzNumber: 31 }).map((e) => e.code),
    ).toContain('JUZ_OUT_OF_RANGE');
  });

  it('returns EVERY problem at once, so a parent fixes the form in one pass', () => {
    const errors = validateTargetSpec('QURAN', 'QURAN_MEMORIZE_AYAH_RANGE', {
      surahNumber: 200,
      fromAyah: 0,
      repetitions: -1,
    });
    expect(errors.length).toBeGreaterThan(1);
  });

  it('describes the target in readable Arabic for the parent queue', () => {
    expect(describeTargetSpec('QURAN_MEMORIZE_AYAH_RANGE', { surahNumber: 67, fromAyah: 1, toAyah: 5 })).toBe(
      'الآيات 1–5 من سورة الملك',
    );
  });
});

describe('validateRewardSpec — seven types, one ceiling', () => {
  it('knows all seven product reward types', () => {
    expect(PROGRAM_REWARD_TYPES).toHaveLength(7);
    expect([...PROGRAM_REWARD_TYPES]).toEqual([
      'POINTS',
      'SCREEN_TIME',
      'PHYSICAL_REWARD',
      'DIGITAL_REWARD',
      'PRIVILEGE',
      'PARENT_APPROVAL_REWARD',
      'CUSTOM_REWARD',
    ]);
  });

  it('REUSE: POINTS maps onto the existing XP ledger type, not a second currency', () => {
    expect(REWARD_TYPE_TO_LEDGER.POINTS).toBe('XP');
  });

  it('accepts 20 points — the flagship reward', () => {
    expect(validateRewardSpec({ type: 'POINTS', amount: 20 })).toEqual([]);
  });

  it('rejects a zero or fractional amount', () => {
    expect(validateRewardSpec({ type: 'POINTS', amount: 0 }).map((e) => e.code)).toContain(
      'REWARD_AMOUNT_INVALID',
    );
    expect(validateRewardSpec({ type: 'POINTS', amount: 2.5 }).map((e) => e.code)).toContain(
      'REWARD_AMOUNT_INVALID',
    );
  });

  it(`caps a single SCREEN_TIME grant at ${MAX_SCREEN_TIME_GRANT_MINUTES} minutes`, () => {
    expect(validateRewardSpec({ type: 'SCREEN_TIME', amount: 61 }).map((e) => e.code)).toContain(
      'SCREEN_TIME_ABOVE_MAX',
    );
    expect(validateRewardSpec({ type: 'SCREEN_TIME', amount: 60 })).toEqual([]);
  });

  it('bounds the TTL of a screen-time grant — a bonus that never expires is a policy change', () => {
    expect(
      validateRewardSpec({ type: 'SCREEN_TIME', amount: 30, expiresInHours: 0 }).map((e) => e.code),
    ).toContain('SCREEN_TIME_TTL_INVALID');
    expect(MAX_ACTIVE_BONUS_MINUTES).toBeGreaterThan(MAX_SCREEN_TIME_GRANT_MINUTES);
  });

  it('the five parent-delivered types enter the fulfilment queue; points and screen time do not', () => {
    expect(FULFILLABLE_REWARD_TYPES.has('PHYSICAL_REWARD')).toBe(true);
    expect(FULFILLABLE_REWARD_TYPES.has('CUSTOM_REWARD')).toBe(true);
    expect(FULFILLABLE_REWARD_TYPES.has('POINTS')).toBe(false);
    expect(FULFILLABLE_REWARD_TYPES.has('SCREEN_TIME')).toBe(false);
  });

  it('the fulfilment state machine has no way out of a terminal state', () => {
    expect(canTransitionFulfilment('PENDING', 'APPROVED')).toBe(true);
    expect(canTransitionFulfilment('APPROVED', 'FULFILLED')).toBe(true);
    expect(canTransitionFulfilment('DECLINED', 'FULFILLED')).toBe(false);
    expect(canTransitionFulfilment('FULFILLED', 'APPROVED')).toBe(false);
    expect(canTransitionFulfilment('PENDING', 'FULFILLED')).toBe(false);
  });
});

describe('the streak ladder', () => {
  it('has the brief exact bonus tiers: 3 days +20, 7 days +100, 30 days special', () => {
    expect([...STREAK_BONUS_THRESHOLDS]).toEqual([3, 7, 30]);
    expect(thresholdBonusForStreak(3)).toBe(20);
    expect(thresholdBonusForStreak(7)).toBe(100);
    expect(thresholdBonusForStreak(30)).toBeGreaterThan(100);
  });

  it('gives no threshold bonus on a non-threshold day', () => {
    for (const d of [0, 1, 2, 4, 6, 8, 29, 31]) expect(thresholdBonusForStreak(d)).toBe(0);
  });

  it('escalates the multiplier by tier and never below 1.00x', () => {
    expect(multiplierBpsForStreak(0)).toBe(BASE_MULTIPLIER_BPS);
    expect(multiplierBpsForStreak(2)).toBe(BASE_MULTIPLIER_BPS);
    expect(multiplierBpsForStreak(3)).toBe(12000);
    expect(multiplierBpsForStreak(7)).toBe(20000);
    expect(multiplierBpsForStreak(45)).toBe(30000);
  });

  it('multiplies in integers — 30 x 1.2 is 36, not 35', () => {
    expect(applyMultiplier(30, 12000)).toBe(36);
    expect(applyMultiplier(20, 10000)).toBe(20);
    expect(applyMultiplier(20, 30000)).toBe(60);
  });

  it('the grant key prefix reproduces the ACHIEVEMENT_VERIFIED key exactly', () => {
    const childId = '11111111-2222-3333-4444-555555555555';
    const achievementId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(achievementGrantKeyPrefix(childId, achievementId, 12000)).toBe(
      composeIdempotencyKey('ACHIEVEMENT_VERIFIED', {
        childId,
        sourceId: achievementId,
        milestone: 12000,
      }),
    );
  });

  it('a different multiplier is a DIFFERENT key — which is why it must be frozen', () => {
    const c = '11111111-2222-3333-4444-555555555555';
    const a = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(achievementGrantKeyPrefix(c, a, 10000)).not.toBe(achievementGrantKeyPrefix(c, a, 20000));
  });
});

describe('checkProgramEligibility — the eleven rules, server-side', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');
  const program = {
    status: 'ACTIVE',
    expiresAt: null as Date | null,
    frequency: 'DAILY' as const,
    maxPerDay: 1,
    maxPerWeek: 7,
    minAge: 0,
    difficulty: 'MEDIUM' as const,
    childId: null as string | null,
  };
  const input = (over: Record<string, unknown> = {}) => ({
    childId: 'child-a',
    childAgeYears: 10,
    verifiedToday: 0,
    verifiedThisWeek: 0,
    openToday: 0,
    now,
    ...over,
    // AFTER the spread on purpose: `over.program` is a PARTIAL override, and
    // letting the raw spread win would silently drop every default field.
    program: { ...program, ...((over.program as object) ?? {}) },
  });

  it('allows a fresh, active, in-scope program', () => {
    expect(checkProgramEligibility(input() as never)).toBeNull();
  });

  it('blocks a paused or archived program', () => {
    expect(checkProgramEligibility(input({ program: { status: 'PAUSED' } }) as never)?.code).toBe(
      'PROGRAM_NOT_ACTIVE',
    );
  });

  it('blocks an expired program', () => {
    expect(
      checkProgramEligibility(input({ program: { expiresAt: new Date('2026-06-01T00:00:00Z') } }) as never)?.code,
    ).toBe('PROGRAM_EXPIRED');
  });

  it('CHILD ELIGIBILITY: a program addressed to another child is not available', () => {
    expect(checkProgramEligibility(input({ program: { childId: 'child-b' } }) as never)?.code).toBe(
      'PROGRAM_NOT_FOR_CHILD',
    );
  });

  it('MIN AGE is enforced, and the message is not punitive', () => {
    const v = checkProgramEligibility(input({ program: { minAge: 12 }, childAgeYears: 9 }) as never);
    expect(v?.code).toBe('CHILD_BELOW_MIN_AGE');
    expect(v?.messageAr).not.toMatch(/ممنوع|محظور/);
  });

  it('MAX PER DAY blocks the second completion of the day', () => {
    expect(checkProgramEligibility(input({ verifiedToday: 1 }) as never)?.code).toBe('MAX_PER_DAY_REACHED');
    expect(
      checkProgramEligibility(input({ program: { maxPerDay: 3 }, verifiedToday: 2 }) as never),
    ).toBeNull();
  });

  it('MAX PER WEEK blocks once the weekly allowance is used', () => {
    expect(
      checkProgramEligibility(input({ program: { maxPerWeek: 3 }, verifiedThisWeek: 3 }) as never)?.code,
    ).toBe('MAX_PER_WEEK_REACHED');
  });

  it('FREQUENCY=ONCE means ever, not once per day', () => {
    expect(
      checkProgramEligibility(
        input({ program: { frequency: 'ONCE', maxPerDay: 5, maxPerWeek: 20 }, verifiedThisWeek: 1 }) as never,
      )?.code,
    ).toBe('PROGRAM_ALREADY_COMPLETED');
  });

  it('one open attempt at a time', () => {
    expect(MAX_OPEN_ATTEMPTS_PER_DAY).toBe(1);
    expect(checkProgramEligibility(input({ openToday: 1 }) as never)?.code).toBe('ATTEMPT_ALREADY_OPEN');
  });
});

/**
 * CHANGED IN B2 (PA-B-001). Every assertion below previously passed a `Date`
 * and got a UTC answer. The three helpers now REQUIRE an IANA zone, so the
 * existing cases are re-expressed with `'UTC'` — proving the migration changed
 * no behaviour for a UTC family — and new cases prove it changed the behaviour
 * that was wrong.
 */
describe('date helpers', () => {
  it('computes whole years and handles a birthday not yet reached', () => {
    expect(ageInYears(new Date('2015-04-01'), new Date('2026-06-15'), 'UTC')).toBe(11);
    expect(ageInYears(new Date('2015-12-01'), new Date('2026-06-15'), 'UTC')).toBe(10);
  });

  it('the week window is 7 days inclusive', () => {
    const w = weekWindow(new Date('2026-06-15T12:00:00Z'), 'UTC');
    expect(w.to).toBe('2026-06-15');
    expect(w.from).toBe('2026-06-09');
  });

  it('formats YYYY-MM-DD', () => {
    expect(localDateString(new Date('2026-06-15T23:59:00Z'), 'UTC')).toBe('2026-06-15');
  });

  it('B2: the SAME instant is a different program day in Cairo, Riyadh and UTC', () => {
    // 21:30Z is 00:30 the NEXT day in both launch markets in August.
    const instant = new Date('2026-06-15T21:30:00Z');
    expect(localDateString(instant, 'UTC')).toBe('2026-06-15');
    expect(localDateString(instant, 'Africa/Cairo')).toBe('2026-06-16');
    expect(localDateString(instant, 'Asia/Riyadh')).toBe('2026-06-16');
  });

  it('B2: the maxPerWeek window is 6 CALENDAR days back, not 6 x 86,400,000 ms', () => {
    // Africa/Cairo's 2026 spring transition is 2026-04-24 (a 23-hour day).
    // Millisecond arithmetic over this window lands on the wrong `from`.
    const w = weekWindow(new Date('2026-04-27T10:00:00Z'), 'Africa/Cairo');
    expect(w.to).toBe('2026-04-27');
    expect(w.from).toBe('2026-04-21');
  });

  it('B2: age is decided on the family calendar, so a birthday is not a day late', () => {
    // 21:30Z on the 15th is already the 16th in Cairo — the child's birthday.
    const instant = new Date('2026-06-15T21:30:00Z');
    expect(ageInYears(new Date('2015-06-16'), instant, 'Africa/Cairo')).toBe(11);
    expect(ageInYears(new Date('2015-06-16'), instant, 'UTC')).toBe(10);
  });
});
