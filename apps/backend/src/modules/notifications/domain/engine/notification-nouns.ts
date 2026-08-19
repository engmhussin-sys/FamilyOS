/**
 * ============================================================================
 * SPRINT F1 — THE SERVER-OWNED NOUNS THE CATALOGUE'S SENTENCES INTERPOLATE.
 * ============================================================================
 *
 * TWO DEFECT-LEDGER ENTRIES SAID «THIS NOUN HAS NO SERVER-SIDE SOURCE», and
 * both were right about the absence and wrong about it being a column:
 *
 *   `GOAL_ALMOST_DONE`      declares `variables: ['done', 'total', 'unitNoun']`
 *                           and THREE of its four tone bands interpolate
 *                           `{unitNoun}`. Without it `substitute` leaves the
 *                           placeholder in the string, `hasEnumOrPlaceholderLeak`
 *                           rejects the render, and the whole sentence degrades
 *                           to `GENERIC` — «لديك تحديث جديد داخل التطبيق».
 *   `DAILY_GOAL_COMPLETED`  declares `variables: ['goalTitle']`, and the only
 *                           candidate text anybody had found was device-supplied
 *                           `metadata`: client prose, which must never be
 *                           rendered as if the server wrote it.
 *
 * WHERE THE NOUNS BELONG, and why this file is beside `notification-copy.ts`
 * rather than in a new column. A unit noun is not a fact about a household — it
 * is part of the SENTENCE, in the same way `AR_ORDINALS` is. It varies with the
 * LOCALE and with the COUNT, neither of which any producer knows: the locale is
 * resolved by `NotificationContextAssembler` and the count is the producer's
 * own arithmetic. A column on `reward_programs` would have had to be written in
 * one language, by a parent, with no count to agree with — i.e. it would have
 * been the wrong shape for the problem as well as a migration.
 *
 * ---------------------------------------------------------------------------
 * ARABIC COUNTED NOUNS, AND THE ONE CASE THIS FILE REFUSES TO SAY.
 *
 * Arabic inflects the counted noun (التمييز) by the number in front of it, and
 * getting it wrong is not a rounding error — «٥ آية» and «٢ آيات» read to an
 * Arabic-speaking child the way «5 ayah» and «2 ayahses» read in English. The
 * rule, in full:
 *
 *   1        SINGULAR         ١ آية
 *   2        DUAL             آيتان
 *   3..10    PLURAL OF PAUCITY (جمع القلة)   ٥ آيات
 *   >= 11    SINGULAR again (تمييز مفرد)     ١١ آية
 *
 * THE DUAL IS DELIBERATELY UNSAYABLE HERE, and `arabicCountedNoun` returns
 * `null` for it. Every template that takes a unit noun prints the NUMERAL
 * first — «أنجزت {done} من {total} {unitNoun}» — and Arabic does not write the
 * dual after a numeral: the correct form is «آيتان» ALONE or «من آيتين», and
 * both need the template restructured around them. «٢ آيتان» and «٢ آيات» are
 * each wrong in a way a child would notice.
 *
 * So the noun is UNAVAILABLE for a count of two, and the caller's contract is
 * to stay silent rather than to guess: `canNameUnits` exists precisely so a
 * PRODUCER can decline to produce, which is the only outcome that is neither a
 * wrong plural nor a `GENERIC` stub. Saying nothing to a child is always safe;
 * saying it wrong is not.
 *
 * ENGLISH is the simple case and is still handled by the same function rather
 * than by an `if` at the call site, because a producer must be able to ask ONE
 * question — «can this sentence be said?» — and get an answer that is true in
 * every locale this product ships. A producer does not know the household's
 * locale, so it must only state facts whose sentence is correct in ALL of them.
 *
 * FRAMEWORK-FREE, like the rest of `domain/engine`.
 */

import type { NotificationLocale } from './notification-context';

/**
 * WHAT ONE COMPLETED ATTEMPT OF A PROGRAM IS, as a closed union.
 *
 * NOT a raw activity code and never rendered: `notification-copy.ts`'s own rule
 * is that no backend enum reaches a user-visible string, and
 * `hasEnumOrPlaceholderLeak` would refuse one that did. This token's only job is
 * to select a row below.
 */
export type GoalUnitKind =
  | 'AYAH'
  | 'SURAH'
  | 'JUZ'
  | 'REVIEW'
  | 'RECITATION'
  | 'EXERCISE'
  | 'TASK'
  | 'SESSION';

/** The three Arabic forms plus the two English ones. Data, not a formatter:
 * Arabic broken plurals are irregular (مهمة -> مهام, تمرين -> تمارين) and no
 * rule derives them. */
interface CountedNoun {
  readonly arOne: string;
  readonly arTwo: string;
  readonly arFew: string;
  readonly enOne: string;
  readonly enMany: string;
}

const UNIT_NOUNS: Readonly<Record<GoalUnitKind, CountedNoun>> = Object.freeze({
  AYAH: { arOne: 'آية', arTwo: 'آيتان', arFew: 'آيات', enOne: 'ayah', enMany: 'ayahs' },
  SURAH: { arOne: 'سورة', arTwo: 'سورتان', arFew: 'سور', enOne: 'surah', enMany: 'surahs' },
  JUZ: { arOne: 'جزء', arTwo: 'جزآن', arFew: 'أجزاء', enOne: 'juz', enMany: 'ajza' },
  REVIEW: { arOne: 'مراجعة', arTwo: 'مراجعتان', arFew: 'مراجعات', enOne: 'review', enMany: 'reviews' },
  RECITATION: { arOne: 'تلاوة', arTwo: 'تلاوتان', arFew: 'تلاوات', enOne: 'recitation', enMany: 'recitations' },
  EXERCISE: { arOne: 'تمرين', arTwo: 'تمرينان', arFew: 'تمارين', enOne: 'exercise', enMany: 'exercises' },
  TASK: { arOne: 'مهمة', arTwo: 'مهمتان', arFew: 'مهام', enOne: 'task', enMany: 'tasks' },
  SESSION: { arOne: 'جلسة', arTwo: 'جلستان', arFew: 'جلسات', enOne: 'session', enMany: 'sessions' },
});

/**
 * ACTIVITY -> WHAT ONE COMPLETED ATTEMPT OF IT IS.
 *
 * Keyed on `program-taxonomy.ts`'s `ProgramActivity`, which is a closed list a
 * human typed and the DTO validates, so this map cannot be fed a value the
 * product does not know. It is `string`-keyed rather than typed against
 * `ProgramActivity` on purpose: the value arrives out of a `VARCHAR(40)` column
 * and a lookup that only compiles is a lookup that is unsafe at runtime.
 *
 * EVERY ROW IS TRUE OF ONE ATTEMPT, and where it would not be, the row says
 * `SESSION` instead of inventing a unit:
 *
 *   QURAN_MEMORIZE_AYAH   `validateTargetSpec` enforces `toAyah === fromAyah`,
 *                         so one attempt IS one ayah. The only activity where a
 *                         finer noun than «جلسة» is a fact rather than a guess.
 *   QURAN_MEMORIZE_SURAH  one attempt is one surah; `QURAN_MEMORIZE_JUZ`, one
 *   QURAN_MEMORIZE_JUZ    juz. Both are what the activity's own name says.
 *   QURAN_REVIEW          «مراجعة» and «تلاوة» are the product's own Arabic for
 *   QURAN_RECITATION      these two activities (`PROGRAM_ACTIVITY_LABEL_AR`).
 *   CODE_EXERCISE         a coding exercise and a workout are both «تمرين», and
 *   PHYSICAL_ACTIVITY     that is the word this product already uses for them.
 *   CHORE                 «مهمة» — a household task.
 *   everything else       `SESSION`. `READ_PAGES` with a target of «٢٠ صفحة»
 *                         completes TWENTY pages in ONE attempt, so counting
 *                         attempts and calling them pages would be a false
 *                         sentence; the attempt is a session and is named one.
 */
const UNIT_KIND_BY_ACTIVITY: Readonly<Record<string, GoalUnitKind>> = Object.freeze({
  QURAN_MEMORIZE_AYAH: 'AYAH',
  QURAN_MEMORIZE_AYAH_RANGE: 'SESSION',
  QURAN_MEMORIZE_SURAH: 'SURAH',
  QURAN_MEMORIZE_JUZ: 'JUZ',
  QURAN_REVIEW: 'REVIEW',
  QURAN_RECITATION: 'RECITATION',
  QURAN_TAFSIR: 'SESSION',
  MEMORIZE_TEXT: 'SESSION',
  READ_PAGES: 'SESSION',
  SOLVE_PROBLEMS: 'SESSION',
  CODE_EXERCISE: 'EXERCISE',
  PRACTICE_SESSION: 'SESSION',
  PHYSICAL_ACTIVITY: 'EXERCISE',
  CHORE: 'TASK',
  GENERIC_SESSION: 'SESSION',
});

/**
 * The unit kind for a `reward_programs.activity`, or `null` for a value this
 * server does not know — a row inserted out of band, or an activity added to
 * the taxonomy without a noun. `null` is what stops the sentence, and stopping
 * is the correct answer: a program whose activity has no noun has no
 * `GOAL_ALMOST_DONE` sentence, not a generic one.
 */
export function goalUnitKindForActivity(activity: string | null | undefined): GoalUnitKind | null {
  if (typeof activity !== 'string') return null;
  return UNIT_KIND_BY_ACTIVITY[activity] ?? null;
}

/**
 * THE COUNTED NOUN, or `null` when this product cannot say it correctly.
 *
 * `count` must be a non-negative integer; anything else is a caller bug and is
 * answered with `null` rather than with a guess. Zero has no counted-noun form
 * that reads naturally after a numeral in either language and no template here
 * ever prints one, so it is refused too.
 */
export function goalUnitNoun(
  kind: GoalUnitKind | null | undefined,
  count: number,
  locale: NotificationLocale,
): string | null {
  if (!kind) return null;
  const noun = UNIT_NOUNS[kind];
  if (!noun) return null;
  if (!Number.isInteger(count) || count < 1) return null;

  if (locale === 'en') return count === 1 ? noun.enOne : noun.enMany;

  // Arabic. See the header for the four cases and for why the dual is refused.
  if (count === 1) return noun.arOne;
  if (count === 2) return null;
  if (count <= 10) return noun.arFew;
  return noun.arOne;
}

/**
 * «CAN THE PRODUCT SAY THIS SENTENCE, IN EVERY LANGUAGE IT SHIPS?»
 *
 * The question a PRODUCER asks before stating a fact whose sentence needs a
 * noun. It is deliberately not «can it say it in Arabic»: a producer runs before
 * the assembler has resolved the household's locale, so the only safe test is
 * the conjunction over every locale. Arabic is the constraining one today, which
 * is the correct default for an Arabic-first product.
 */
export function canNameUnits(kind: GoalUnitKind | null | undefined, count: number): boolean {
  return goalUnitNoun(kind, count, 'ar') !== null && goalUnitNoun(kind, count, 'en') !== null;
}

/**
 * ==========================================================================
 * THE DAILY GOALS THIS PRODUCT ACTUALLY HAS, AND THEIR SERVER-OWNED NAMES.
 * ==========================================================================
 *
 * `DAILY_GOAL_COMPLETED` was on the defect ledger for «no server-owned Arabic
 * name for a daily goal exists», with the evidence that
 * `TYPE_SPECS.DAILY_GOAL_COMPLETED.aggregateType = 'DailyGoal'` names a model
 * with no table behind it. Both halves of that are true OF THE DEVICE-INGESTED
 * PATH, and neither is true of the product's own daily goals.
 *
 * WHAT A «DAILY GOAL» IS HERE, read out of `src/` rather than out of the type
 * table: `HealthEngineService` is the ONLY thing in this codebase that emits the
 * name `DAILY_GOAL_COMPLETED` server-side, and it emits exactly two of them —
 *
 *   `logHydration`  when the day's millilitres cross `computeHydrationTargetMl`,
 *                   a target derived from the child's AGE on the family's
 *                   calendar and summed over the family's business day.
 *   `logActivity`   when the day's minutes cross the 60-minute activity target
 *                   (`ACTIVITY_TARGET_MINUTES`, the same constant the progress
 *                   screen and the streak question already use).
 *
 * Both targets are the SERVER'S; both crossings are computed from stored rows;
 * neither takes a title, a label or any other string from a device. So the name
 * of the goal is the server's to write, and this is where it is written.
 *
 * KEYED ON THE ORIGINATING DOMAIN EVENT TYPE (`HYDRATION_GOAL_COMPLETED` /
 * `ACTIVITY_GOAL_COMPLETED`, both already in `DOMAIN_EVENT_TYPES`) rather than
 * on a new word invented at the notification layer — the same rule
 * `NotificationEventFacts.cause` states for itself.
 *
 * THE ARABIC IS A NOUN PHRASE, not a sentence, because the four tone bands wrap
 * it differently: «أنهيت {goalTitle} اليوم» and «أكملت هدف {goalTitle} اليوم كما
 * خططت» must both read naturally, so «شرب الماء» works and «هدف شرب الماء» would
 * have doubled the word هدف in the second.
 */
const DAILY_GOAL_NAMES: Readonly<Record<string, Readonly<Record<NotificationLocale, string>>>> =
  Object.freeze({
    HYDRATION_GOAL_COMPLETED: { ar: 'شرب الماء', en: 'your water goal' },
    ACTIVITY_GOAL_COMPLETED: { ar: 'النشاط البدني', en: 'your activity goal' },
  });

/** The two causes a `DAILY_GOAL_COMPLETED` producer may state, as a closed
 * union — named so that `notification-producer-chain.guard.spec.ts` can expand
 * it and so a third daily goal cannot be added without a name. */
export type DailyGoalCause = 'HYDRATION_GOAL_COMPLETED' | 'ACTIVITY_GOAL_COMPLETED';

/**
 * The goal's own name in the household's language, or `null` for a cause this
 * server has no name for — at which point the sentence must not be sent, the
 * same contract as `goalUnitNoun`.
 */
export function dailyGoalName(
  cause: string | null | undefined,
  locale: NotificationLocale,
): string | null {
  if (typeof cause !== 'string') return null;
  return DAILY_GOAL_NAMES[cause]?.[locale] ?? null;
}

/** Every daily-goal cause this file names, for the specs that assert the two
 * halves of the product agree about the list. */
export function dailyGoalCauses(): readonly string[] {
  return Object.keys(DAILY_GOAL_NAMES);
}
