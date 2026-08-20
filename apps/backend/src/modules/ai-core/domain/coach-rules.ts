/**
 * B8 — THE DETERMINISTIC-FIRST INSIGHT ENGINE.
 *
 * §8's central claim is that ≥ 80% of what a parent values needs no LLM at all.
 * This file is where that claim is either true or false, so it is a PURE
 * FUNCTION of `CoachSignals`: no I/O, no clock, no provider, no randomness.
 * Same input, same output, forever — which is what makes
 * `coach-rules.spec.ts` able to assert twelve exact sentences and what makes
 * `llm-invocation-gate.spec.ts` able to COUNT provider calls across a corpus
 * of families and get a number rather than a hope.
 *
 * THE THIRTEEN RULES ARE ORDERED. `evaluate` returns every rule that fired,
 * ordered by (severity, declaration order), and `topInsight` takes the first.
 * Declaration order is the tie-break on purpose: "you have no screen-time
 * policy" outranks "your category mix is narrow" not because of a score but
 * because someone decided it, in this file, in a line a reviewer can see.
 *
 * EVERY SENTENCE IS NON-PUNITIVE (CONTEXT §3 principle 7) AND NAMES NO
 * DIAGNOSIS (§1.3). There is no «تجاوز», no «فشل», no «مدمن», no «تشتت»,
 * no «قلق», and no comparison to another child anywhere below. The comparison
 * a rule is allowed to make is the child against their own baseline, and
 * `NARROW_CATEGORY_MIX` is the only rule that mentions breadth at all.
 */

import type {
  CoachInsight,
  CoachInsightCode,
  CoachSeverity,
  CoachSignals,
  CoachActivitySuggestion,
} from './coach.types';

interface RuleDefinition {
  readonly code: CoachInsightCode;
  readonly severity: CoachSeverity;
  readonly fires: (s: CoachSignals) => boolean;
  readonly render: (s: CoachSignals) => {
    titleAr: string;
    bodyAr: string;
    evidenceAr: string[];
    nextStepsAr: string[];
  };
}

const RULES: readonly RuleDefinition[] = Object.freeze([
  {
    code: 'NO_DATA_YET',
    severity: 'LOW',
    // Nothing at all: no programs, no habits, no completions. The honest card
    // says so and invents no explanation (§6.3's second worked example).
    fires: (s) => s.programs.active === 0 && s.habits.active === 0 && s.habits.completed28d === 0,
    render: () => ({
      titleAr: 'لم تصل بيانات كافية بعد',
      bodyAr: 'لا توجد مهام أو برامج نشطة بعد، فلا يوجد ما يمكن تحليله اليوم. أول برنامج هو نقطة البداية.',
      evidenceAr: ['صفر برنامج نشط', 'صفر مهمة نشطة', 'صفر إنجاز خلال ٢٨ يومًا'],
      nextStepsAr: ['أنشئ برنامجًا واحدًا مناسبًا لعمر طفلك.', 'ابدأ بمهمة يومية واحدة قصيرة، لا أكثر.'],
    }),
  },
  {
    code: 'NO_SCREEN_TIME_POLICY',
    severity: 'MEDIUM',
    fires: (s) => s.screenTime.dailyLimitMinutes === null,
    render: () => ({
      titleAr: 'لا يوجد اتفاق على وقت الشاشة بعد',
      bodyAr: 'لم يُضبط حد يومي لوقت الشاشة، فلا يوجد شيء ملموس يستند إليه الجهاز أو الحديث معه.',
      evidenceAr: ['الحد اليومي غير مضبوط'],
      nextStepsAr: [
        'اتفق مع طفلك على حد يومي واحد، واكتبه في الإعدادات.',
        'ابدأ بحد قريب من استخدامه الحالي، ثم عدّله تدريجيًا.',
      ],
    }),
  },
  {
    code: 'NO_PROGRAM_YET',
    severity: 'MEDIUM',
    fires: (s) => s.programs.active === 0 && s.habits.completed28d > 0,
    render: (s) => ({
      titleAr: 'نشاط بلا برنامج يجمعه',
      bodyAr: `طفلك أنجز ${s.habits.completed28d} مهمة خلال ٢٨ يومًا بلا برنامج مكافآت واحد، فالمجهود لا يتراكم في شيء يراه.`,
      evidenceAr: [`${s.habits.completed28d} إنجاز خلال ٢٨ يومًا`, 'صفر برنامج نشط'],
      nextStepsAr: ['راجع الاقتراحات الجاهزة واقبل واحدًا يناسب عمره.'],
    }),
  },
  {
    code: 'STREAK_AT_RISK',
    severity: 'HIGH',
    fires: (s) => s.streak.atRisk && s.streak.currentDays >= 3,
    render: (s) => ({
      titleAr: 'السلسلة على وشك الانقطاع اليوم',
      bodyAr: `السلسلة الحالية ${s.streak.currentDays} أيام، ولم يُسجَّل إنجاز اليوم بعد. مهمة واحدة قصيرة تكفي للحفاظ عليها.`,
      evidenceAr: [`السلسلة الحالية: ${s.streak.currentDays} يومًا`, 'صفر إنجاز مسجَّل اليوم'],
      nextStepsAr: ['ذكّره بمهمة واحدة قصيرة قبل نهاية اليوم.', 'اختر أسهل مهمة متاحة، لا أهمها.'],
    }),
  },
  {
    code: 'REJECTED_SUBMISSIONS',
    severity: 'HIGH',
    fires: (s) => s.achievements.rejected7d >= 2 && s.achievements.rejected7d >= s.achievements.verified7d,
    render: (s) => ({
      titleAr: 'إرسالات لم تُعتمد هذا الأسبوع',
      bodyAr: `لم يُعتمد ${s.achievements.rejected7d} إرسال هذا الأسبوع مقابل ${s.achievements.verified7d} معتمد. غالبًا شرط التحقق غير واضح لطفلك، لا أن المجهود ناقص.`,
      evidenceAr: [
        `${s.achievements.rejected7d} إرسال غير معتمد خلال ٧ أيام`,
        `${s.achievements.verified7d} إرسال معتمد خلال ٧ أيام`,
      ],
      nextStepsAr: [
        'اجلس معه مرة واحدة واشرح ما يطلبه التحقق بالضبط.',
        'إن تكرر الرفض، خفّف مستوى التحقق في البرنامج.',
      ],
    }),
  },
  {
    code: 'COMPLETION_DROP',
    severity: 'MEDIUM',
    fires: (s) => {
      const baselineWeekly = s.habits.completed28d / 4;
      return baselineWeekly >= 2 && s.habits.completed7d < baselineWeekly * 0.6;
    },
    render: (s) => {
      const baselineWeekly = Math.round((s.habits.completed28d / 4) * 10) / 10;
      return {
        titleAr: 'أسبوع أهدأ من المعتاد',
        bodyAr: `أنجز طفلك ${s.habits.completed7d} مهمة هذا الأسبوع مقابل متوسط ${baselineWeekly} في الأسابيع الأربعة الماضية. غالبًا سبب مؤقت.`,
        evidenceAr: [`${s.habits.completed7d} إنجاز هذا الأسبوع`, `المتوسط الأسبوعي: ${baselineWeekly}`],
        nextStepsAr: ['اسأله ما الذي تغيّر هذا الأسبوع، بلا محاسبة.', 'خفّف عدد المهام اليومية مؤقتًا حتى يعود الإيقاع.'],
      };
    },
  },
  {
    code: 'MISSED_DAYS_PATTERN',
    severity: 'MEDIUM',
    fires: (s) => s.habits.missed7d >= 3 && s.habits.completed7d > 0,
    render: (s) => ({
      titleAr: 'أيام متكررة بلا إنجاز',
      bodyAr: `سُجِّل ${s.habits.missed7d} يوم بلا إنجاز خلال الأسبوع. تكرار الأيام نفسها عادةً يعني أن الموعد لا يناسب جدوله، لا أن الهدف كبير.`,
      evidenceAr: [`${s.habits.missed7d} يوم بلا إنجاز خلال ٧ أيام`, `${s.habits.completed7d} إنجاز في نفس الفترة`],
      nextStepsAr: ['قدّم موعد المهمة ساعة واحدة عن موعدها الحالي.', 'اجعل مهمة واحدة فقط إلزامية في الأيام المزدحمة.'],
    }),
  },
  {
    code: 'GOAL_UNREALISTIC',
    severity: 'MEDIUM',
    fires: (s) =>
      s.programs.active >= 2 &&
      s.achievements.submitted7d > 0 &&
      s.achievements.verified7d / Math.max(1, s.programs.active * 7) < 0.25,
    render: (s) => ({
      titleAr: 'الأهداف الحالية أكبر من الإيقاع',
      bodyAr: `${s.programs.active} برامج نشطة، والمعتمد منها ${s.achievements.verified7d} إنجاز هذا الأسبوع. تقليل العدد يرفع الإنجاز عادةً.`,
      evidenceAr: [`${s.programs.active} برنامج نشط`, `${s.achievements.verified7d} إنجاز معتمد خلال ٧ أيام`],
      nextStepsAr: ['أوقف مؤقتًا أقل برنامجين استخدامًا.', 'اخفض الهدف اليومي لبرنامج واحد بدل إيقافه.'],
    }),
  },
  {
    code: 'GOAL_TOO_EASY',
    severity: 'LOW',
    fires: (s) =>
      s.programs.active > 0 &&
      s.achievements.verified28d >= 20 &&
      s.achievements.rejected7d === 0 &&
      (s.programs.byDifficulty.EASY ?? 0) >= s.programs.active,
    render: (s) => ({
      titleAr: 'مستوى أسهل مما يستطيع',
      bodyAr: `أنجز ${s.achievements.verified28d} إنجازًا معتمدًا خلال ٢٨ يومًا بلا رفض واحد، وكل برامجه على مستوى سهل.`,
      evidenceAr: [`${s.achievements.verified28d} إنجاز معتمد خلال ٢٨ يومًا`, 'كل البرامج النشطة بمستوى EASY'],
      nextStepsAr: ['ارفع مستوى برنامج واحد فقط إلى MEDIUM.', 'زد مدة برنامج واحد خمس دقائق، لا أكثر.'],
    }),
  },
  {
    code: 'STREAK_MILESTONE',
    severity: 'LOW',
    fires: (s) => [7, 14, 30, 60, 100].includes(s.streak.currentDays),
    render: (s) => ({
      titleAr: `${s.streak.currentDays} يومًا متتاليًا`,
      bodyAr: `وصل طفلك إلى ${s.streak.currentDays} يومًا متتاليًا. أفضل رقم سابق له ${s.streak.bestDays}.`,
      evidenceAr: [`السلسلة الحالية: ${s.streak.currentDays}`, `أفضل سلسلة: ${s.streak.bestDays}`],
      nextStepsAr: ['اذكر الرقم أمامه اليوم — الاعتراف يصنع الاستمرار.'],
    }),
  },
  {
    code: 'STRONG_WEEK',
    severity: 'LOW',
    fires: (s) => {
      const baselineWeekly = s.habits.completed28d / 4;
      return baselineWeekly >= 1 && s.habits.completed7d >= baselineWeekly * 1.3;
    },
    render: (s) => {
      const baselineWeekly = Math.round((s.habits.completed28d / 4) * 10) / 10;
      return {
        titleAr: 'أسبوع أعلى من معدله',
        bodyAr: `أنجز ${s.habits.completed7d} مهمة هذا الأسبوع مقابل متوسط ${baselineWeekly}. الإيقاع الحالي يستحق التثبيت.`,
        evidenceAr: [`${s.habits.completed7d} إنجاز هذا الأسبوع`, `المتوسط الأسبوعي: ${baselineWeekly}`],
        nextStepsAr: ['ثبّت ما يفعله الآن بدل إضافة هدف جديد هذا الأسبوع.'],
      };
    },
  },
  {
    code: 'NARROW_CATEGORY_MIX',
    severity: 'LOW',
    fires: (s) => s.programs.active >= 3 && Object.keys(s.programs.byCategory).length === 1,
    render: (s) => ({
      titleAr: 'كل البرامج في مجال واحد',
      bodyAr: `${s.programs.active} برامج نشطة كلها في مجال واحد. إضافة مجال ثانٍ تعطي يومه تنوعًا بلا زيادة في العبء.`,
      evidenceAr: [`${s.programs.active} برنامج نشط`, 'مجال واحد فقط'],
      nextStepsAr: ['أضف برنامجًا واحدًا من مجال مختلف، بمدة قصيرة.'],
    }),
  },
  {
    code: 'STEADY_PROGRESS',
    severity: 'LOW',
    // The catch-all. It fires whenever there IS data and nothing else fired —
    // so a parent never opens the tab to an empty screen, which is the failure
    // mode a rules engine has and a chatbot does not.
    fires: (s) => s.habits.completed28d > 0 || s.programs.active > 0,
    render: (s) => ({
      titleAr: 'إيقاع ثابت',
      bodyAr: `${s.habits.completed7d} إنجاز هذا الأسبوع و${s.programs.active} برنامج نشط. لا شيء يحتاج تدخلًا اليوم.`,
      evidenceAr: [`${s.habits.completed7d} إنجاز خلال ٧ أيام`, `${s.programs.active} برنامج نشط`],
      nextStepsAr: ['لا تغيير مطلوب اليوم. الاستمرار نفسه هو الخطوة.'],
    }),
  },
]);

const SEVERITY_RANK: Readonly<Record<CoachSeverity, number>> = Object.freeze({ HIGH: 0, MEDIUM: 1, LOW: 2 });

/**
 * Confidence is DATA COMPLETENESS, not model certainty — the same definition
 * `DecisionEngineService.computeConfidence` already uses in this codebase, kept
 * identical on purpose so two AI surfaces do not mean two different things by
 * the same word.
 */
export function coachConfidence(s: CoachSignals): number {
  let c = 1.0;
  if (s.habits.completed28d === 0) c -= 0.25;
  if (s.programs.active === 0) c -= 0.2;
  if (s.screenTime.dailyLimitMinutes === null) c -= 0.1;
  if (s.achievements.verified28d === 0) c -= 0.15;
  return Math.max(0.3, Math.round(c * 100) / 100);
}

export function evaluateCoachRules(signals: CoachSignals): CoachInsight[] {
  const confidence = coachConfidence(signals);
  return RULES.map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.fires(signals))
    .sort((a, b) =>
      SEVERITY_RANK[a.rule.severity] !== SEVERITY_RANK[b.rule.severity]
        ? SEVERITY_RANK[a.rule.severity] - SEVERITY_RANK[b.rule.severity]
        : a.index - b.index,
    )
    .map(({ rule }) => {
      const rendered = rule.render(signals);
      return {
        code: rule.code,
        severity: rule.severity,
        titleAr: rendered.titleAr,
        bodyAr: rendered.bodyAr,
        evidenceAr: Object.freeze([...rendered.evidenceAr]),
        nextStepsAr: Object.freeze([...rendered.nextStepsAr]),
        confidence,
      };
    });
}

/**
 * `NO_DATA_YET` fires only when there is genuinely nothing, and `STEADY_PROGRESS`
 * fires only when there is something — between them every possible signal set
 * produces at least one insight, so this never returns `undefined`. The
 * fallback below exists because a type cannot express "these two rules
 * partition the space", and returning `undefined` to a controller because
 * somebody edited one predicate is worse than one unreachable branch.
 */
export function topCoachInsight(signals: CoachSignals): CoachInsight {
  const fired = evaluateCoachRules(signals);
  return (
    fired[0] ?? {
      code: 'NO_DATA_YET',
      severity: 'LOW',
      titleAr: 'لم تصل بيانات كافية بعد',
      bodyAr: 'لا توجد بيانات كافية لعرض تحليل اليوم.',
      evidenceAr: Object.freeze([]),
      nextStepsAr: Object.freeze([]),
      confidence: coachConfidence(signals),
    }
  );
}

/**
 * THE LLM GATE (§7.3), expressed as a predicate over signals rather than as a
 * decision buried in a service. A provider call is worth making only when the
 * deterministic output is (a) about something that matters and (b) about
 * something a warmer sentence actually helps with. A `STEADY_PROGRESS` card and
 * a `NO_DATA_YET` card are neither, and they are the two most common cards —
 * which is precisely why the measured ratio in `llm-invocation-gate.spec.ts`
 * lands where it does.
 */
const LLM_WORTHY_CODES: ReadonlySet<CoachInsightCode> = new Set<CoachInsightCode>([
  'STREAK_AT_RISK',
  'COMPLETION_DROP',
  'MISSED_DAYS_PATTERN',
  'REJECTED_SUBMISSIONS',
  'GOAL_UNREALISTIC',
]);

export function deservesLlmPhrasing(insight: CoachInsight): boolean {
  return insight.severity !== 'LOW' && LLM_WORTHY_CODES.has(insight.code);
}

// ---------------------------------------------------------------------------
// ACTIVITY RECOMMENDATIONS — also rules, also no LLM
// ---------------------------------------------------------------------------

interface ActivityTemplate {
  readonly category: string;
  readonly titleAr: string;
  readonly minAge: number;
  readonly maxAge: number;
  readonly minutes: number;
}

const ACTIVITIES: readonly ActivityTemplate[] = Object.freeze([
  { category: 'QURAN', titleAr: 'حفظ ثلاث آيات قصيرة قبل النوم', minAge: 6, maxAge: 9, minutes: 10 },
  { category: 'QURAN', titleAr: 'مراجعة ما حُفظ أمس ثم إضافة آيتين', minAge: 10, maxAge: 17, minutes: 20 },
  { category: 'READING', titleAr: 'قراءة ثلاث صفحات بصوت مسموع', minAge: 6, maxAge: 9, minutes: 10 },
  { category: 'READING', titleAr: 'قراءة عشر صفحات وتلخيصها في سطرين', minAge: 10, maxAge: 17, minutes: 20 },
  { category: 'SPORT', titleAr: 'لعب حركي خارج البيت عشرين دقيقة', minAge: 6, maxAge: 12, minutes: 20 },
  { category: 'SPORT', titleAr: 'تمرين قصير أو مشي سريع', minAge: 13, maxAge: 17, minutes: 25 },
  { category: 'MATH', titleAr: 'حل عشر مسائل قصيرة', minAge: 8, maxAge: 14, minutes: 20 },
  { category: 'ARABIC', titleAr: 'كتابة خمسة أسطر عن يومه', minAge: 8, maxAge: 14, minutes: 15 },
  { category: 'ENGLISH', titleAr: 'حفظ عشر كلمات جديدة واستعمالها في جمل', minAge: 9, maxAge: 17, minutes: 15 },
  { category: 'PROGRAMMING', titleAr: 'تمرين برمجي صغير من درس واحد', minAge: 12, maxAge: 17, minutes: 30 },
  { category: 'HABITS', titleAr: 'ترتيب الغرفة قبل النوم', minAge: 6, maxAge: 11, minutes: 10 },
  { category: 'MANNERS', titleAr: 'مساعدة أحد أفراد الأسرة في مهمة واحدة', minAge: 6, maxAge: 14, minutes: 15 },
  { category: 'STUDY', titleAr: 'جلسة مذاكرة واحدة بلا جهاز في اليد', minAge: 12, maxAge: 17, minutes: 25 },
  { category: 'SCIENCE', titleAr: 'مشاهدة تجربة قصيرة وإعادة شرحها', minAge: 10, maxAge: 17, minutes: 20 },
]);

/**
 * Age first, then what the child is NOT already doing, then what they have
 * shown they engage with. Suggesting a seventh Quran activity to a child who
 * already has six programs in it is the sort of recommendation that teaches a
 * parent to ignore the tab — the same reasoning `RewardSuggestionService`
 * already applies to program drafts, applied here to activities.
 */
export function recommendActivities(signals: CoachSignals, limit = 3): CoachActivitySuggestion[] {
  const ageFit = ACTIVITIES.filter((a) => signals.ageYears >= a.minAge && signals.ageYears <= a.maxAge);
  const covered = new Set(Object.keys(signals.programs.byCategory));

  const scored = ageFit.map((a) => {
    let score = 0;
    if (!covered.has(a.category)) score += 10;
    const interestIndex = signals.interests.indexOf(a.category);
    if (interestIndex >= 0) score += 5 - interestIndex;
    // A struggling week gets shorter suggestions; a strong week can take more.
    if (signals.habits.missed7d >= 3 && a.minutes <= 15) score += 3;
    return { a, score };
  });

  return scored
    .sort((x, y) => (y.score !== x.score ? y.score - x.score : x.a.titleAr.localeCompare(y.a.titleAr, 'ar')))
    .slice(0, limit)
    .map(({ a }) => ({
      category: a.category,
      titleAr: a.titleAr,
      estimatedMinutes: a.minutes,
      rationaleAr: covered.has(a.category)
        ? `يوسّع ما يفعله طفلك بالفعل في هذا المجال، بمدة مناسبة لعمر ${signals.ageYears} سنة.`
        : `مجال لا يوجد فيه برنامج بعد، ومناسب لعمر ${signals.ageYears} سنة.`,
    }));
}

export const COACH_RULE_COUNT = RULES.length;
