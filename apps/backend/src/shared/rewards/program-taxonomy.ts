/**
 * THE PROGRAM TAXONOMY — categories and the activities each one offers.
 *
 * Shape decision, stated because the brief asks for both forms: this file is
 * the ENUM (a closed `as const` union, so a typo is a compile error), and
 * migration 0006 seeds `reward_program_categories` / `reward_program_activities`
 * FROM this list. The database copy is what a report or an admin UI reads; the
 * code copy is what validates a create request without a round trip.
 *
 * "So new ones don't need a migration": adding a category is a row in
 * `reward_program_categories` — `reward_programs.category` is a TEXT column with
 * an FK to that table, not a PostgreSQL enum, precisely so a new category is an
 * INSERT and not an `ALTER TYPE`. The `as const` list below is the set the
 * SERVER knows how to validate today; a row added out-of-band is accepted by the
 * FK and rejected by the DTO, which is the honest ordering (a category with no
 * activities cannot be programmed against anyway).
 *
 * Framework-free, same discipline as `src/shared/events/*`.
 */

export const PROGRAM_CATEGORIES = [
  'QURAN',
  'HADITH',
  'FIQH',
  'MANNERS',
  'STUDY',
  'SCIENCE',
  'MATH',
  'PROGRAMMING',
  'READING',
  'SPORT',
  'ENGLISH',
  'ARABIC',
  'SKILLS',
  'HOUSEWORK',
  'HEALTH',
  'HABITS',
  'VOLUNTEERING',
  'CREATIVITY',
] as const;

export type ProgramCategory = (typeof PROGRAM_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(PROGRAM_CATEGORIES);

export function isProgramCategory(value: string): value is ProgramCategory {
  return CATEGORY_SET.has(value);
}

/** The Arabic labels from the brief, verbatim. Seeded into the reference table. */
export const PROGRAM_CATEGORY_LABEL_AR: Readonly<Record<ProgramCategory, string>> = {
  QURAN: 'قرآن',
  HADITH: 'حديث',
  FIQH: 'فقه',
  MANNERS: 'أدب وسلوك',
  STUDY: 'دراسة',
  SCIENCE: 'علوم',
  MATH: 'رياضيات',
  PROGRAMMING: 'برمجة',
  READING: 'قراءة',
  SPORT: 'رياضة',
  ENGLISH: 'إنجليزي',
  ARABIC: 'عربي',
  SKILLS: 'مهارات',
  HOUSEWORK: 'أعمال منزلية',
  HEALTH: 'صحة',
  HABITS: 'عادات',
  VOLUNTEERING: 'تطوع',
  CREATIVITY: 'إبداع',
};

/**
 * ACTIVITIES. Quran is modelled properly (seven distinct activities, each with
 * a different target shape); every other category gets a generic activity set
 * rather than a fabricated taxonomy nobody asked for — an honest absence beats
 * an invented one, and `GENERIC_SESSION` carries the same `durationMinutes`
 * contract the brief specifies at the program level.
 */
export const PROGRAM_ACTIVITIES = [
  // -- Quran, modelled properly --
  'QURAN_MEMORIZE_AYAH',
  'QURAN_MEMORIZE_AYAH_RANGE',
  'QURAN_MEMORIZE_SURAH',
  'QURAN_MEMORIZE_JUZ',
  'QURAN_REVIEW',
  'QURAN_RECITATION',
  'QURAN_TAFSIR',
  // -- everything else --
  'MEMORIZE_TEXT',
  'READ_PAGES',
  'SOLVE_PROBLEMS',
  'CODE_EXERCISE',
  'PRACTICE_SESSION',
  'PHYSICAL_ACTIVITY',
  'CHORE',
  'GENERIC_SESSION',
] as const;

export type ProgramActivity = (typeof PROGRAM_ACTIVITIES)[number];

const ACTIVITY_SET: ReadonlySet<string> = new Set(PROGRAM_ACTIVITIES);

export function isProgramActivity(value: string): value is ProgramActivity {
  return ACTIVITY_SET.has(value);
}

export const PROGRAM_ACTIVITY_LABEL_AR: Readonly<Record<ProgramActivity, string>> = {
  QURAN_MEMORIZE_AYAH: 'حفظ آية',
  QURAN_MEMORIZE_AYAH_RANGE: 'حفظ مجموعة آيات',
  QURAN_MEMORIZE_SURAH: 'حفظ سورة',
  QURAN_MEMORIZE_JUZ: 'حفظ جزء',
  QURAN_REVIEW: 'مراجعة',
  QURAN_RECITATION: 'تلاوة',
  QURAN_TAFSIR: 'تفسير',
  MEMORIZE_TEXT: 'حفظ نص',
  READ_PAGES: 'قراءة صفحات',
  SOLVE_PROBLEMS: 'حل مسائل',
  CODE_EXERCISE: 'تمرين برمجي',
  PRACTICE_SESSION: 'جلسة تدريب',
  PHYSICAL_ACTIVITY: 'نشاط بدني',
  CHORE: 'مهمة منزلية',
  GENERIC_SESSION: 'جلسة',
};

/** The activities each category may use. A program whose activity is not in
 * its category's list is rejected at the DTO layer — this is what stops
 * "category: SPORT, activity: QURAN_MEMORIZE_JUZ". */
export const CATEGORY_ACTIVITIES: Readonly<Record<ProgramCategory, readonly ProgramActivity[]>> = {
  QURAN: [
    'QURAN_MEMORIZE_AYAH',
    'QURAN_MEMORIZE_AYAH_RANGE',
    'QURAN_MEMORIZE_SURAH',
    'QURAN_MEMORIZE_JUZ',
    'QURAN_REVIEW',
    'QURAN_RECITATION',
    'QURAN_TAFSIR',
  ],
  HADITH: ['MEMORIZE_TEXT', 'GENERIC_SESSION'],
  FIQH: ['MEMORIZE_TEXT', 'PRACTICE_SESSION', 'GENERIC_SESSION'],
  MANNERS: ['PRACTICE_SESSION', 'GENERIC_SESSION'],
  STUDY: ['READ_PAGES', 'SOLVE_PROBLEMS', 'PRACTICE_SESSION', 'GENERIC_SESSION'],
  SCIENCE: ['READ_PAGES', 'SOLVE_PROBLEMS', 'PRACTICE_SESSION', 'GENERIC_SESSION'],
  MATH: ['SOLVE_PROBLEMS', 'PRACTICE_SESSION', 'GENERIC_SESSION'],
  PROGRAMMING: ['CODE_EXERCISE', 'PRACTICE_SESSION', 'GENERIC_SESSION'],
  READING: ['READ_PAGES', 'GENERIC_SESSION'],
  SPORT: ['PHYSICAL_ACTIVITY', 'GENERIC_SESSION'],
  ENGLISH: ['MEMORIZE_TEXT', 'READ_PAGES', 'PRACTICE_SESSION', 'GENERIC_SESSION'],
  ARABIC: ['MEMORIZE_TEXT', 'READ_PAGES', 'PRACTICE_SESSION', 'GENERIC_SESSION'],
  SKILLS: ['PRACTICE_SESSION', 'GENERIC_SESSION'],
  HOUSEWORK: ['CHORE', 'GENERIC_SESSION'],
  HEALTH: ['PHYSICAL_ACTIVITY', 'PRACTICE_SESSION', 'GENERIC_SESSION'],
  HABITS: ['PRACTICE_SESSION', 'GENERIC_SESSION'],
  VOLUNTEERING: ['CHORE', 'GENERIC_SESSION'],
  CREATIVITY: ['PRACTICE_SESSION', 'GENERIC_SESSION'],
};

export function activityBelongsToCategory(
  category: ProgramCategory,
  activity: ProgramActivity,
): boolean {
  return CATEGORY_ACTIVITIES[category].includes(activity);
}

/**
 * Which streak bucket a category contributes to. The brief names five:
 * Quran, reading, exercise, learning, good behaviour. Everything else maps to
 * `learning` rather than growing a sixth bucket nobody asked for.
 */
export const STREAK_KINDS = ['quran', 'reading', 'exercise', 'learning', 'behaviour'] as const;
export type StreakKind = (typeof STREAK_KINDS)[number];

export const CATEGORY_STREAK_KIND: Readonly<Record<ProgramCategory, StreakKind>> = {
  QURAN: 'quran',
  HADITH: 'quran',
  FIQH: 'learning',
  MANNERS: 'behaviour',
  STUDY: 'learning',
  SCIENCE: 'learning',
  MATH: 'learning',
  PROGRAMMING: 'learning',
  READING: 'reading',
  SPORT: 'exercise',
  ENGLISH: 'learning',
  ARABIC: 'learning',
  SKILLS: 'learning',
  HOUSEWORK: 'behaviour',
  HEALTH: 'exercise',
  HABITS: 'behaviour',
  VOLUNTEERING: 'behaviour',
  CREATIVITY: 'learning',
};

/** `daily` | `weekly` — the cadence a program repeats on. */
export const PROGRAM_FREQUENCIES = ['DAILY', 'WEEKLY', 'ONCE'] as const;
export type ProgramFrequency = (typeof PROGRAM_FREQUENCIES)[number];

export const PROGRAM_DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
export type ProgramDifficulty = (typeof PROGRAM_DIFFICULTIES)[number];

export const PROGRAM_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];
