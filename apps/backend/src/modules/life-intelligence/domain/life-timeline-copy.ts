/**
 * ============================================================================
 * THE LIFE TIMELINE'S OWN COPY, AND THE ONLY PLACE ITS TITLES EXIST.
 * ============================================================================
 *
 * WHAT WAS THERE, MEASURED. Fourteen English string literals, written inline in
 * seven engines, into `life_timeline_events.title` — «Earned a reward»,
 * «Reached Level 3», «Logged today's first meal», «Started building the "…"
 * habit». `life_timeline_events` IS «سجل حياة الطفل» (CONTEXT §1): the artefact
 * a parent in Cairo or Riyadh keeps and re-reads, in a product whose first
 * language is Arabic and whose only two markets are EG and SA.
 *
 * None of those strings was a raw enum and none contained a placeholder, so
 * every generic leak check in this repository passed them. They were simply the
 * wrong language — the failure mode a leak check cannot see, and `e2e-13`
 * pinned `title: 'Earned a reward'` to the byte until this file existed.
 *
 * WHY A MODULE AND NOT FOURTEEN CORRECTED LITERALS. The same argument
 * `notification-copy.ts` makes for notifications, and it is not weaker here just
 * because the surface is quieter: copy that lives next to the logic that decided
 * to write it means changing a word means editing an engine, and it is how the
 * fourteen drifted into two languages, three tenses and two voices in the first
 * place. One module, one register, one place a translator or a product owner
 * looks.
 *
 * THE REGISTER, and it is deliberately not the child's. A timeline entry is a
 * RECORD, read by a parent (and later by the child themselves) about something
 * that already happened — so it is third person and past tense («أكمل…»,
 * «حصل على…»), not the child-facing second person the notification catalogue
 * uses («حصلت على…»). The two surfaces are different audiences and this file
 * does not pretend otherwise.
 *
 * DIGITS. `formatArabicNumber` writes Arabic-Indic digits, for the same
 * `PF-E-002` reason `notification-copy.ts` does: Arabic prose with Latin
 * numerals reads as a translation. Values that arrive ALREADY RENDERED — a
 * habit's own title, a badge's own title, `RewardProgram.targetSummaryAr` —
 * are interpolated verbatim, because re-writing somebody else's stored string
 * is not this module's business.
 */

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

export function formatArabicNumber(value: number | string): string {
  return String(value).replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)]);
}

/** Arabic quotation marks, so an interpolated title reads as a quotation rather
 * than as a fragment: «عادة القراءة». */
function quoted(text: string): string {
  return `«${text.trim()}»`;
}

export const TIMELINE_COPY_AR = Object.freeze({
  // ---- REWARDS ------------------------------------------------------------

  /**
   * THE ENTRY `e2e-13` EXISTS TO PIN, and the reason it takes an argument.
   *
   * «حصل على مكافأة» answers WHEN and not WHAT, which is the same defect the
   * parent's notification had: a timeline of twenty identical rows is a counter,
   * not a life record. `summaryAr` is `RewardProgram.targetSummaryAr` — derived
   * ONCE by `describeTargetSpec` at program creation and carried on the
   * completion — so this composes nothing and re-derives nothing.
   *
   * The argument is OPTIONAL because most completions are not programs: a habit
   * tick, a hydration goal and a streak milestone have no target summary and
   * never will, and the generic sentence is the honest answer for them rather
   * than an invented one.
   */
  rewardGranted: (summaryAr: string | null): string =>
    summaryAr ? `أكمل ${summaryAr} وحصل على مكافأة` : 'حصل على مكافأة جديدة',

  badgeAwarded: (badgeTitle: string): string => `حصل على وسام ${quoted(badgeTitle)}`,

  levelUp: (level: number): string => `وصل إلى المستوى ${formatArabicNumber(level)}`,

  // ---- HABITS -------------------------------------------------------------

  firstHabitCompletion: (habitTitle: string): string => `بدأ بناء عادة ${quoted(habitTitle)}`,

  // ---- FAITH --------------------------------------------------------------

  firstPracticeLog: (practiceTitle: string): string => `بدأ ${quoted(practiceTitle)}`,

  // ---- LEARNING -----------------------------------------------------------

  learningGoalCompleted: (goalTitle: string): string => `أكمل هدف ${quoted(goalTitle)}`,

  // ---- HEALTH -------------------------------------------------------------

  firstNutritionLogToday: (): string => 'سجّل أول وجبة اليوم',

  hydrationTargetReached: (): string => 'أتم هدف شرب الماء اليوم',

  activityTargetReached: (): string => 'أتم هدف النشاط البدني اليوم',

  /**
   * `activityType` IS NOT TRANSLATABLE TODAY, and the honest thing is to say so
   * rather than to interpolate it. The English title this replaces was
   * `Joined a group activity: ${input.activityType}` — and `activityType` is a
   * free-form string a client sends (`IActivityLog.activityType: string`, no
   * catalogue, no union), so the old title could put `FOOTBALL` — a raw
   * `ALL_CAPS` token — straight into a user-visible string, which is
   * `notification-copy.ts` rule 2 broken one table over.
   *
   * So the title is the fact, in Arabic, and the client's own word moves to
   * `metadata`, where a machine reads it and no parent does. When the product
   * gives group activities a real catalogue with `labelAr`, this signature is
   * already the shape that takes it.
   */
  firstGroupActivity: (labelAr: string | null = null): string =>
    labelAr ? `شارك في نشاط جماعي: ${labelAr}` : 'شارك في نشاط جماعي',

  // ---- DIGITAL WELLBEING --------------------------------------------------

  firstWellbeingSnapshot: (): string => 'بدأ تتبّع التوازن الرقمي اليومي',

  healthyUsagePattern: (): string => 'نمط استخدام صحي هذا الأسبوع',

  /**
   * THE OTHER LEAK IN THIS FAMILY OF TITLES. What was here was
   * `Recurring pattern: ${anomaly.code.replace(/_/g, ' ').toLowerCase()}` —
   * a backend enum lower-cased into a user-visible string, which is the
   * `parent-app` risk-enum defect (Phase E) in the timeline. The code stays in
   * `metadata`; the parent reads a sentence.
   */
  recurringPattern: (code: string): string => {
    const labelAr = BEHAVIOR_PATTERN_LABEL_AR[code];
    return labelAr ? `نمط متكرر: ${labelAr}` : 'نمط متكرر يستحق الانتباه';
  },
});

/**
 * The nine `BehaviorPatternCode` values, in Arabic. A closed union in
 * `digital-wellbeing.types.ts`, so this table is complete rather than
 * best-effort — and an unknown code still degrades to the generic sentence
 * above rather than to the code itself.
 *
 * NON-PUNITIVE, deliberately, even though these are the NEGATIVE patterns:
 * CONTEXT §3 principle 7 governs what a household reads, and «ارتفاع في
 * الاستخدام» is an observation a parent can act on where «إفراط» is a verdict
 * on a child in a record that child will one day read.
 */
const BEHAVIOR_PATTERN_LABEL_AR: Readonly<Record<string, string>> = Object.freeze({
  EXCESSIVE_USAGE: 'ارتفاع في وقت الاستخدام',
  NIGHT_USAGE_INCREASE: 'ارتفاع في الاستخدام الليلي',
  GAMING_SPIKE: 'ارتفاع في وقت الألعاب',
  SOCIAL_SPIKE: 'ارتفاع في وقت التواصل الاجتماعي',
  STUDY_DECLINE: 'انخفاض في وقت المذاكرة',
  FRAGMENTED_ATTENTION: 'تشتّت في الانتباه',
  LONG_SESSION: 'جلسات استخدام طويلة',
  WEEKEND_SHIFT: 'تغيّر في نمط عطلة نهاية الأسبوع',
  HEALTHY_PATTERN: 'نمط استخدام صحي',
});
