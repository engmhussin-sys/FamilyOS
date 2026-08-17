/**
 * THE CHILD-FACING LEARNING CATALOGUE — a READ-ONLY PROJECTION of the taxonomy
 * the parent catalogue already serves.
 *
 * WHY THIS FILE EXISTS AT ALL. `domain_chooser.dart` records the gap in the
 * child app's own words: «The fuller flow in the product brief — child picks a
 * domain, the Smart Reward Engine proposes a suitable activity and duration
 * inside it — needs a child-facing route that does not exist. `reward-programs`
 * is parent-only […] neither serves a catalogue or an activity proposal.» The
 * device could see the goals a parent had already created and nothing else, so
 * «إيه اللي عايز تتعلمه النهاردة؟» had no answer beyond "whatever is already on
 * the list".
 *
 * WHAT IT IS NOT. It is not a second taxonomy. Every code, every Arabic label
 * and every policy value below is READ from the constants the parent catalogue
 * is built from — `PROGRAM_CATEGORIES`, `PROGRAM_CATEGORY_LABEL_AR`,
 * `CATEGORY_ACTIVITIES`, `PROGRAM_ACTIVITY_LABEL_AR`, `VERIFICATION_MATRIX`,
 * `CATEGORY_STREAK_KIND`, `PROGRAM_REWARD_TYPES` — plus the `RewardProgram`
 * column defaults, restated here as named constants so a reader can see where
 * each number came from. Nothing here is a new source of truth.
 *
 * FRAMEWORK-FREE on purpose, the same discipline as `program-rules.ts` and
 * `verification.ts`: no NestJS, no Prisma, no request object. The only input is
 * the child's age in whole years, which means the whole projection is a pure
 * function and a test can assert "the served values do not depend on anything
 * the caller sent" by construction rather than by inspection.
 *
 * THE FIELDS THAT ARE DELIBERATELY ABSENT. The brief asks each item to carry an
 * age range, a points RANGE and a content type. Two of those have no source in
 * this repository:
 *
 *   - a per-activity age range. `RewardProgram.minAge` is a PARENT-SET column
 *     whose schema default is `0`; there is no table, constant or migration
 *     anywhere that says "QURAN_MEMORIZE_JUZ starts at 10". So
 *     `ageRange.recommendedMinAge` / `recommendedMaxAge` are `null` and the
 *     schema default is reported separately, under its real name, as
 *     `programDefaultMinAge`. Inventing "suitable from 7" would have become the
 *     number a real child is measured against.
 *   - a points RANGE. The server knows exactly ONE points figure per age band
 *     (`SUGGESTED_POINTS_BY_AGE`, the table `RewardSuggestionService` drafts
 *     from). A minimum and a maximum do not exist, so `reward.range` is `null`
 *     and `reward.suggestedAmount` carries the one real number.
 *
 * `contentKind` IS sourced: it is `CATEGORY_STREAK_KIND`, the existing
 * classification of what sort of thing a category is (quran / reading /
 * exercise / learning / behaviour). A media-format content type (video, text,
 * interactive) has no model in this backend and is not invented here.
 */
import {
  CATEGORY_ACTIVITIES,
  CATEGORY_STREAK_KIND,
  PROGRAM_ACTIVITY_LABEL_AR,
  PROGRAM_CATEGORIES,
  PROGRAM_CATEGORY_LABEL_AR,
  type ProgramActivity,
  type ProgramCategory,
  type ProgramDifficulty,
  type ProgramFrequency,
  type StreakKind,
} from '../../../shared/rewards/program-taxonomy';
import type { ProgramRewardType } from '../../../shared/rewards/reward-spec';
import {
  VERIFICATION_MATRIX,
  type VerificationMethod,
  type VerificationMethodSpec,
} from '../../../shared/rewards/verification';
import { ageBandFor, ageBandProfile, type AgeBand } from '../../ai-core/domain/age-band';

// ---------------------------------------------------------------------------
// THE AGE TABLES — extracted from `RewardSuggestionService`, not copied
// ---------------------------------------------------------------------------
//
// These four functions were private methods on `RewardSuggestionService`
// (`rankCategories` and `draftFor`). They are moved HERE, and that service now
// calls them, so there is exactly ONE table in the backend that says "what a
// nine-year-old is offered, for how long, for how many points". A copy would
// have meant the catalogue could drift from the drafts the parent actually
// accepts — the child would be shown 20 points and the accepted program would
// pay 30, and nothing would fail.

/**
 * Which domains the server SUGGESTS at a given age. Verbatim the list
 * `RewardSuggestionService.rankCategories` has ranked by since F4.
 *
 * NOTE WHAT THIS IS NOT: it is not a permission and not an age gate. A category
 * absent from a band is still fully returned by the catalogue — see
 * `CatalogueSuitability`.
 */
export function suggestedCategoriesForAge(ageYears: number): readonly ProgramCategory[] {
  if (ageYears < 8) return ['QURAN', 'READING', 'HABITS', 'MANNERS', 'ARABIC', 'SPORT'];
  if (ageYears < 12) return ['QURAN', 'READING', 'MATH', 'ARABIC', 'ENGLISH', 'SPORT'];
  return ['QURAN', 'STUDY', 'PROGRAMMING', 'ENGLISH', 'SCIENCE', 'SPORT'];
}

/** Minutes the server drafts at this age. `RewardSuggestionService`'s own table. */
export function suggestedDurationMinutesForAge(ageYears: number): number {
  return ageYears < 8 ? 10 : ageYears < 12 ? 20 : 30;
}

/** Points the server drafts at this age. `RewardSuggestionService`'s own table. */
export function suggestedPointsForAge(ageYears: number): number {
  return ageYears < 8 ? 10 : ageYears < 12 ? 20 : 30;
}

/** Difficulty the server drafts at this age. `RewardSuggestionService`'s own. */
export function suggestedDifficultyForAge(ageYears: number): ProgramDifficulty {
  return ageYears < 8 ? 'EASY' : 'MEDIUM';
}

/**
 * The verification method the server drafts for a domain — the same rule
 * `RewardSuggestionService.draftFor` applies, and for the same stated reason:
 * «Advisory drafts NEVER propose a weak verification level.» There is no branch
 * here that can produce `SELF_CHECK`.
 */
export function suggestedVerificationForCategory(category: ProgramCategory): VerificationMethod {
  return category === 'QURAN' ? 'RECITATION_SUBMISSION' : 'PARENT_CONFIRMATION';
}

// ---------------------------------------------------------------------------
// `RewardProgram` COLUMN DEFAULTS, restated under their real names
// ---------------------------------------------------------------------------
//
// Every value below is the `@default(...)` on the matching column in
// `schema.prisma`'s `RewardProgram`. They are named here so the response can
// say "this is what a program looks like before a parent changes anything"
// without a Prisma import in a pure module, and so a schema change that moves
// one of them is a one-line diff rather than a hunt through a controller.

export const PROGRAM_DEFAULT_FREQUENCY: ProgramFrequency = 'DAILY';
export const PROGRAM_DEFAULT_MAX_PER_DAY = 1;
export const PROGRAM_DEFAULT_MAX_PER_WEEK = 7;
export const PROGRAM_DEFAULT_MIN_AGE = 0;
export const PROGRAM_DEFAULT_REQUIRES_PARENT_APPROVAL = false;
/** 10000 = 1.00x. The CEILING a program allows, never the applied multiplier. */
export const PROGRAM_DEFAULT_STREAK_MULTIPLIER_BPS = 30000;

// ---------------------------------------------------------------------------
// ARABIC LABELS FOR THE ENUMS A CHILD WOULD OTHERWISE READ AS CODES
// ---------------------------------------------------------------------------
//
// «No raw enum, code or status may be the thing a child reads.» Categories,
// activities and verification methods already carry server-authored Arabic in
// `shared/rewards/*`. Four enums did not, because until now only a PARENT app
// rendered them: difficulty, frequency, verification strength and the streak
// kind. Their labels are declared here — a translation of an existing closed
// enum, not new product data, and every one of them is `Record<Enum, string>`
// so adding a value to the enum is a compile error rather than a code leaking
// into a six-year-old's screen.

export const DIFFICULTY_LABEL_AR: Readonly<Record<ProgramDifficulty, string>> = {
  EASY: 'سهل',
  MEDIUM: 'متوسط',
  HARD: 'صعب',
};

export const FREQUENCY_LABEL_AR: Readonly<Record<ProgramFrequency, string>> = {
  DAILY: 'كل يوم',
  WEEKLY: 'كل أسبوع',
  ONCE: 'مرة واحدة',
};

export const VERIFICATION_STRENGTH_LABEL_AR: Readonly<
  Record<VerificationMethodSpec['strength'], string>
> = {
  WEAK: 'إثبات بسيط',
  MODERATE: 'إثبات متوسط',
  STRONG: 'إثبات قوي',
};

export const CONTENT_KIND_LABEL_AR: Readonly<Record<StreakKind, string>> = {
  quran: 'قرآن',
  reading: 'قراءة',
  exercise: 'نشاط بدني',
  learning: 'تعلّم',
  behaviour: 'سلوك وعادات',
};

export const REWARD_TYPE_LABEL_AR: Readonly<Record<ProgramRewardType, string>> = {
  POINTS: 'نقاط',
  SCREEN_TIME: 'وقت شاشة إضافي',
  PHYSICAL_REWARD: 'مكافأة ملموسة',
  DIGITAL_REWARD: 'مكافأة رقمية',
  PRIVILEGE: 'امتياز',
  PARENT_APPROVAL_REWARD: 'مكافأة يقرّرها ولي الأمر',
  CUSTOM_REWARD: 'مكافأة مخصّصة',
};

// ---------------------------------------------------------------------------
// THE RESPONSE SHAPE
// ---------------------------------------------------------------------------

export interface CatalogueChildContext {
  readonly ageYears: number;
  /** From `ai-core/domain/age-band.ts` — the ONE age-band derivation in this
   * backend. There is deliberately no second implementation here. */
  readonly ageBand: AgeBand;
  readonly ageBandLabelAr: string;
}

export interface CatalogueVerification {
  readonly method: VerificationMethod;
  readonly labelAr: string;
  readonly rationaleAr: string;
  /** Machine field for the Smart Reward/Learning Engine. Its Arabic twin is
   * `strengthLabelAr`; a client renders that one. */
  readonly strength: VerificationMethodSpec['strength'];
  readonly strengthLabelAr: string;
  readonly canAutoApprove: boolean;
  readonly requiresExplicitChoice: boolean;
}

export interface CatalogueReward {
  readonly type: ProgramRewardType;
  readonly typeLabelAr: string;
  /** The one real figure the server holds for this age. */
  readonly suggestedAmount: number;
  readonly suggestedLabelAr: string;
  /**
   * EXPLICITLY ABSENT. No minimum/maximum points band exists anywhere in this
   * repository; see this file's header. A client must render
   * `suggestedAmount`, and a client that wants a range needs a product
   * decision first, not a number from here.
   */
  readonly range: null;
  readonly rangeNoteAr: string;
}

export interface CatalogueAgeRange {
  /** `RewardProgram.minAge`'s schema default. A real value under its real name
   * — not a recommendation, and not an age gate for this activity. */
  readonly programDefaultMinAge: number;
  /** EXPLICITLY ABSENT — no per-activity age range exists in this repository. */
  readonly recommendedMinAge: null;
  readonly recommendedMaxAge: null;
  readonly noteAr: string;
}

/**
 * ANNOTATE, NEVER HIDE — and the convention is the product's, not this file's.
 *
 * `domain_chooser.dart`: «A domain with nothing available today is DIMMED,
 * never hidden and never locked — the same treatment `GoalCard` gives an
 * unavailable goal, for the same reason (it is still theirs, it is just not
 * now).» A catalogue that silently dropped domains would teach a child the
 * product is smaller than it is, and a nine-year-old who wants to learn to code
 * would never learn that PROGRAMMING exists.
 *
 * So EVERY category and EVERY activity is returned at EVERY age, and the age
 * derivation produces a flag plus a non-punitive Arabic sentence. `hidden` is
 * `false` for every item this function can build; it is in the shape so a
 * client renders from the field rather than from the assumption, and so a
 * future decision to hide something is a visible diff here.
 */
export interface CatalogueSuitability {
  readonly suggestedAtThisAge: boolean;
  readonly hidden: false;
  readonly noteAr: string;
}

export interface CatalogueLimits {
  readonly frequency: ProgramFrequency;
  readonly frequencyLabelAr: string;
  readonly maxPerDay: number;
  readonly maxPerWeek: number;
  readonly streakMultiplierMaxBps: number;
}

export interface CatalogueItem {
  /** Stable, derived: `CATEGORY:ACTIVITY`. Not a database id — nothing in this
   * response is a row, which is what makes the surface cacheable and safe. */
  readonly id: string;
  readonly activityCode: ProgramActivity;
  readonly domainCode: ProgramCategory;
  readonly domainLabelAr: string;
  readonly titleAr: string;
  readonly descriptionAr: string;
  readonly ageRange: CatalogueAgeRange;
  readonly difficulty: ProgramDifficulty;
  readonly difficultyLabelAr: string;
  readonly estimatedDurationMinutes: number;
  readonly verification: CatalogueVerification;
  readonly reward: CatalogueReward;
  /**
   * DERIVED FROM THE MATRIX, not from a request and not from a guess. A program
   * created with the defaults has `requiresParentApproval: false`, so the
   * EFFECTIVE answer to "does a human decide this?" is exactly
   * `!VERIFICATION_MATRIX[method].canAutoApprove` — the same gate
   * `AchievementService.verify` applies after the strategy runs.
   */
  readonly requiresParentApproval: boolean;
  readonly requiresParentApprovalNoteAr: string;
  readonly contentKind: StreakKind;
  readonly contentKindLabelAr: string;
  readonly limits: CatalogueLimits;
  readonly suitability: CatalogueSuitability;
}

export interface CatalogueDomain {
  readonly code: ProgramCategory;
  readonly labelAr: string;
  readonly contentKind: StreakKind;
  readonly contentKindLabelAr: string;
  readonly activityCount: number;
  readonly suitability: CatalogueSuitability;
  readonly items: readonly CatalogueItem[];
}

export interface LearningCatalogue {
  readonly child: CatalogueChildContext;
  readonly domains: readonly CatalogueDomain[];
  readonly totals: { readonly domains: number; readonly activities: number };
}

/** The `domains` list without the nested activities — the first screen of the
 * child's chooser, which needs chips and counts and nothing else. */
export type LearningCatalogueDomainsOnly = {
  readonly child: CatalogueChildContext;
  readonly domains: readonly Omit<CatalogueDomain, 'items'>[];
  readonly totals: LearningCatalogue['totals'];
};

// ---------------------------------------------------------------------------
// THE PROJECTION
// ---------------------------------------------------------------------------

const AGE_RANGE_NOTE_AR =
  'الحد الأدنى للعمر يحدّده ولي الأمر عند إنشاء البرنامج، ولا يوجد حد ثابت لهذا النشاط.';

const REWARD_RANGE_NOTE_AR = 'هذه نقاط مقترحة لعمرك، وولي الأمر هو من يحدّد المكافأة النهائية.';

function suitabilityFor(
  category: ProgramCategory,
  ageYears: number,
  suggested: ReadonlySet<ProgramCategory>,
): CatalogueSuitability {
  const isSuggested = suggested.has(category);
  return {
    suggestedAtThisAge: isSuggested,
    hidden: false,
    // NON-PUNITIVE (CONTEXT §3 principle 7): the "not suggested" sentence says
    // the thing is open to you, it does not say you are too young for it.
    noteAr: isSuggested
      ? `مقترح لعمرك (${ageYears} سنة).`
      : `متاح لك — واقتراحاتنا لعمر ${ageYears} سنة تبدأ من مجالات أخرى.`,
  };
}

function verificationFor(category: ProgramCategory): CatalogueVerification {
  const method = suggestedVerificationForCategory(category);
  const spec = VERIFICATION_MATRIX[method];
  return {
    method,
    labelAr: spec.labelAr,
    rationaleAr: spec.rationaleAr,
    strength: spec.strength,
    strengthLabelAr: VERIFICATION_STRENGTH_LABEL_AR[spec.strength],
    canAutoApprove: spec.canAutoApprove,
    requiresExplicitChoice: spec.requiresExplicitChoice,
  };
}

function itemFor(
  category: ProgramCategory,
  activity: ProgramActivity,
  ageYears: number,
  suggested: ReadonlySet<ProgramCategory>,
): CatalogueItem {
  const domainLabelAr = PROGRAM_CATEGORY_LABEL_AR[category];
  const titleAr = PROGRAM_ACTIVITY_LABEL_AR[activity];
  const verification = verificationFor(category);
  const durationMinutes = suggestedDurationMinutesForAge(ageYears);
  const points = suggestedPointsForAge(ageYears);
  const difficulty = suggestedDifficultyForAge(ageYears);
  const contentKind = CATEGORY_STREAK_KIND[category];
  const requiresParentApproval =
    PROGRAM_DEFAULT_REQUIRES_PARENT_APPROVAL || !verification.canAutoApprove;

  return {
    id: `${category}:${activity}`,
    activityCode: activity,
    domainCode: category,
    domainLabelAr,
    titleAr,
    // COMPOSED FROM SERVER-AUTHORED ARABIC, not written fresh. Every noun in
    // this sentence is a label that already existed (`PROGRAM_ACTIVITY_LABEL_AR`,
    // `PROGRAM_CATEGORY_LABEL_AR`, `VERIFICATION_MATRIX[...].labelAr`) and the
    // number is the server's own duration table. There is no editorial,
    // per-activity description anywhere in this repository; writing one for
    // each of the 47 pairs is a CONTENT decision and is reported as such rather
    // than invented here.
    descriptionAr: `${titleAr} ضمن ${domainLabelAr} — حوالي ${durationMinutes} دقيقة، والتحقق يكون عن طريق ${verification.labelAr}.`,
    ageRange: {
      programDefaultMinAge: PROGRAM_DEFAULT_MIN_AGE,
      recommendedMinAge: null,
      recommendedMaxAge: null,
      noteAr: AGE_RANGE_NOTE_AR,
    },
    difficulty,
    difficultyLabelAr: DIFFICULTY_LABEL_AR[difficulty],
    estimatedDurationMinutes: durationMinutes,
    verification,
    reward: {
      type: 'POINTS',
      typeLabelAr: REWARD_TYPE_LABEL_AR.POINTS,
      suggestedAmount: points,
      suggestedLabelAr: `${points} ${REWARD_TYPE_LABEL_AR.POINTS}`,
      range: null,
      rangeNoteAr: REWARD_RANGE_NOTE_AR,
    },
    requiresParentApproval,
    requiresParentApprovalNoteAr: requiresParentApproval
      ? 'ولي الأمر هو من يعتمد هذا الإنجاز بعد إرسال الدليل.'
      : 'يتحقق الخادم من هذا الإنجاز بنفسه، ويبقى لولي الأمر أن يطلب اعتماده يدويًا.',
    contentKind,
    contentKindLabelAr: CONTENT_KIND_LABEL_AR[contentKind],
    limits: {
      frequency: PROGRAM_DEFAULT_FREQUENCY,
      frequencyLabelAr: FREQUENCY_LABEL_AR[PROGRAM_DEFAULT_FREQUENCY],
      maxPerDay: PROGRAM_DEFAULT_MAX_PER_DAY,
      maxPerWeek: PROGRAM_DEFAULT_MAX_PER_WEEK,
      streakMultiplierMaxBps: PROGRAM_DEFAULT_STREAK_MULTIPLIER_BPS,
    },
    suitability: suitabilityFor(category, ageYears, suggested),
  };
}

/**
 * THE WHOLE CATALOGUE, from ONE number.
 *
 * The signature is the invariant: `ageYears` is the only input, and it is
 * derived server-side from the child's `dateOfBirth` on the family's calendar.
 * There is no parameter here by which a caller could raise a points figure,
 * weaken a verification method, or lift a daily limit — not because those are
 * checked, but because they are not arguments.
 *
 * Ordering: domains the server suggests at this age first (stable within each
 * group by the declared order of `PROGRAM_CATEGORIES`), which is the same
 * "what you can do now, first" ordering `domainsOf` applies on the device.
 */
export function buildLearningCatalogue(ageYears: number): LearningCatalogue {
  const suggested = new Set<ProgramCategory>(suggestedCategoriesForAge(ageYears));

  const domains: CatalogueDomain[] = PROGRAM_CATEGORIES.map((code) => {
    const category = code as ProgramCategory;
    const activities = CATEGORY_ACTIVITIES[category];
    const contentKind = CATEGORY_STREAK_KIND[category];
    return {
      code: category,
      labelAr: PROGRAM_CATEGORY_LABEL_AR[category],
      contentKind,
      contentKindLabelAr: CONTENT_KIND_LABEL_AR[contentKind],
      activityCount: activities.length,
      suitability: suitabilityFor(category, ageYears, suggested),
      items: activities.map((activity) => itemFor(category, activity, ageYears, suggested)),
    };
  });

  domains.sort((a, b) => {
    if (a.suitability.suggestedAtThisAge !== b.suitability.suggestedAtThisAge) {
      return a.suitability.suggestedAtThisAge ? -1 : 1;
    }
    return PROGRAM_CATEGORIES.indexOf(a.code) - PROGRAM_CATEGORIES.indexOf(b.code);
  });

  const band = ageBandFor(ageYears);
  return {
    child: {
      ageYears,
      ageBand: band,
      ageBandLabelAr: ageBandProfile(band).labelAr,
    },
    domains,
    totals: {
      domains: domains.length,
      activities: domains.reduce((sum, d) => sum + d.items.length, 0),
    },
  };
}

/** The same projection with the activity lists dropped. Derived from
 * `buildLearningCatalogue` rather than built separately, so the two routes can
 * never disagree about which domains exist or how they are ordered. */
export function buildLearningCatalogueDomains(ageYears: number): LearningCatalogueDomainsOnly {
  const full = buildLearningCatalogue(ageYears);
  return {
    child: full.child,
    domains: full.domains.map(({ items: _items, ...domain }) => domain),
    totals: full.totals,
  };
}
