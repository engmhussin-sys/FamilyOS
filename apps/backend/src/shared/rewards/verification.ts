/**
 * THE VERIFICATION CONTRACT.
 *
 * CONTEXT §3 principle 2 (AI ADVISORY ONLY) and the brief's own hard rule:
 * a child completing a timer must NOT automatically earn the reward. Every
 * method below therefore declares, as DATA rather than as a comment, whether it
 * may auto-approve or must escalate to a parent. `AchievementVerificationService`
 * reads this table; it has no `if (method === ...)` chain.
 *
 * NAMING, stated because an earlier draft of this file differed: the method
 * names the brief spells out are used VERBATIM — `PARENT_CONFIRMATION`,
 * `QUIZ`, `ASSESSMENT_SCORE`, `SELF_CHECK`, `DURATION`, `RECITATION_SUBMISSION`,
 * `COMPLETION_ARTIFACT`. `CODE_CHALLENGE` and `DURATION_PLUS_QUIZ` are kept as
 * two ADDITIONAL methods (the PROGRAMMING category and the "time AND proof"
 * combination genuinely need them); they are additive, not substitutes.
 *
 * Framework-free — no NestJS, no Prisma. The strategies themselves
 * (`src/modules/rewards-engine/domain/verification-strategies.ts`) are pure
 * functions over `VerificationInput`, which is what makes each one
 * unit-testable without a database.
 */

export const VERIFICATION_METHODS = [
  'DURATION',
  'SELF_CHECK',
  'PARENT_CONFIRMATION',
  'QUIZ',
  'RECITATION_SUBMISSION',
  'ASSESSMENT_SCORE',
  'COMPLETION_ARTIFACT',
  'CODE_CHALLENGE',
  'DURATION_PLUS_QUIZ',
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

const METHOD_SET: ReadonlySet<string> = new Set(VERIFICATION_METHODS);
export function isVerificationMethod(v: string): v is VerificationMethod {
  return METHOD_SET.has(v);
}

/** `PASSED` -> reward path. `FAILED` -> ACHIEVEMENT_REJECTED. `ESCALATED` ->
 * waits for a parent; NO event, NO grant, NO notification of a reward. */
export type VerificationResult = 'PASSED' | 'FAILED' | 'ESCALATED';

export interface VerificationMethodSpec {
  readonly method: VerificationMethod;
  /**
   * Whether a PASS decided by the server alone is sufficient. `false` means
   * the strategy can only ever return ESCALATED or FAILED — a parent decides.
   */
  readonly canAutoApprove: boolean;
  /** How much this method is worth as evidence (CONTEXT §3 principle 9). */
  readonly strength: 'WEAK' | 'MODERATE' | 'STRONG';
  /** Must a parent CHOOSE it explicitly (never a default)? */
  readonly requiresExplicitChoice: boolean;
  /**
   * `SELF_CHECK` is the low-trust method the brief restricts to low-trust
   * activities. This flag is what `RewardProgramService` reads to reject
   * "SELF_CHECK on a QURAN memorisation program" at create time — the
   * restriction is enforced, not documented.
   */
  readonly lowTrustOnly: boolean;
  readonly labelAr: string;
  readonly rationaleAr: string;
}

export const VERIFICATION_MATRIX: Readonly<Record<VerificationMethod, VerificationMethodSpec>> = {
  DURATION: {
    method: 'DURATION',
    canAutoApprove: true,
    strength: 'WEAK',
    // The weakest evidence there is — it proves time passed, not that anything
    // happened. A parent must choose it deliberately.
    requiresExplicitChoice: true,
    lowTrustOnly: false,
    labelAr: 'مدة العمل الفعلية',
    rationaleAr:
      'أضعف مستوى: يثبت الزمن داخل التطبيق فقط لا الإنجاز. يعتمد على زمن الواجهة الأمامية (foreground) لا على ساعة الحائط. يجب اختياره صراحة.',
  },
  SELF_CHECK: {
    method: 'SELF_CHECK',
    canAutoApprove: true,
    strength: 'WEAK',
    requiresExplicitChoice: false,
    lowTrustOnly: true,
    labelAr: 'تأكيد ذاتي',
    rationaleAr:
      'الطفل يؤكد الإنجاز بنفسه — مسموح فقط للأنشطة منخفضة المخاطر (عادات، أعمال منزلية، صحة، رياضة، سلوك، تطوع).',
  },
  PARENT_CONFIRMATION: {
    method: 'PARENT_CONFIRMATION',
    canAutoApprove: false,
    strength: 'STRONG',
    requiresExplicitChoice: false,
    lowTrustOnly: false,
    labelAr: 'تأكيد الوالد',
    rationaleAr: 'لا يمنح الخادم شيئًا: القرار للوالد دائمًا.',
  },
  QUIZ: {
    method: 'QUIZ',
    canAutoApprove: true,
    strength: 'MODERATE',
    requiresExplicitChoice: false,
    lowTrustOnly: false,
    labelAr: 'اختبار قصير',
    rationaleAr: 'يُقارن الحاصل بعتبة النجاح المحدّدة في البرنامج، خادميًا.',
  },
  RECITATION_SUBMISSION: {
    method: 'RECITATION_SUBMISSION',
    canAutoApprove: false,
    strength: 'STRONG',
    requiresExplicitChoice: false,
    lowTrustOnly: false,
    labelAr: 'تسميع مُسجَّل',
    rationaleAr:
      'يُخزَّن مرجع التسجيل فقط؛ لا يوجد أي تحليل صوتي (audio ML) في هذا الـ sprint. المراجعة بشرية ثم قرار الوالد.',
  },
  ASSESSMENT_SCORE: {
    method: 'ASSESSMENT_SCORE',
    canAutoApprove: true,
    strength: 'MODERATE',
    requiresExplicitChoice: false,
    lowTrustOnly: false,
    labelAr: 'درجة تقييم دراسي',
    rationaleAr: 'يُعاد استخدام LearningAssessment القائم — لا جدول درجات جديد.',
  },
  COMPLETION_ARTIFACT: {
    method: 'COMPLETION_ARTIFACT',
    canAutoApprove: false,
    strength: 'STRONG',
    requiresExplicitChoice: false,
    lowTrustOnly: false,
    labelAr: 'دليل إنجاز مرفق',
    rationaleAr:
      'صورة أو ملف يرفعه الطفل كدليل. يُخزَّن المرجع فقط والقرار للوالد — لا تحليل آلي للمحتوى في هذا الـ sprint.',
  },
  CODE_CHALLENGE: {
    method: 'CODE_CHALLENGE',
    canAutoApprove: true,
    strength: 'MODERATE',
    requiresExplicitChoice: false,
    lowTrustOnly: false,
    labelAr: 'تحدٍّ برمجي',
    rationaleAr: 'نتيجة الاختبارات (ناجح/إجمالي) تُقارن بالعتبة خادميًا.',
  },
  DURATION_PLUS_QUIZ: {
    method: 'DURATION_PLUS_QUIZ',
    canAutoApprove: true,
    strength: 'MODERATE',
    requiresExplicitChoice: false,
    lowTrustOnly: false,
    labelAr: 'مدة + اختبار',
    rationaleAr: 'الشرطان معًا: المدة المطلوبة واجتياز الاختبار. فشل أحدهما = فشل.',
  },
};

export function canAutoApprove(method: VerificationMethod): boolean {
  return VERIFICATION_MATRIX[method].canAutoApprove;
}

/**
 * The categories on which `SELF_CHECK` is acceptable — "low-trust activities
 * only", as data. Everything else (Quran, Hadith, Fiqh, every academic
 * category) needs real evidence, and asking for it is not punitive: it is what
 * makes the reward mean something.
 */
export const SELF_CHECK_ALLOWED_CATEGORIES: ReadonlySet<string> = new Set([
  'HABITS',
  'HOUSEWORK',
  'HEALTH',
  'SPORT',
  'MANNERS',
  'VOLUNTEERING',
]);

/** What a strategy is given. Everything here is SERVER-KNOWN or
 * server-recorded — nothing a child can assert about its own reward. */
export interface VerificationInput {
  readonly method: VerificationMethod;
  /** From the program. */
  readonly requiredDurationMinutes: number;
  /** From the program's `verificationConfig`. */
  readonly passScorePercent: number;
  /**
   * SERVER-MEASURED wall-clock minutes from `startedAt` to `submittedAt`.
   * Never client-claimed, and never on its own sufficient — see
   * `foregroundMinutes`.
   */
  readonly elapsedMinutes: number;
  /**
   * ANTI-GAMING, and the reason `DURATION` is not "time-on-wall-clock".
   * Foreground (app-visible) minutes the device reports for this attempt. The
   * `DURATION` strategy requires BOTH:
   *
   *   foregroundMinutes >= requiredDurationMinutes            (real time on task)
   *   foregroundMinutes <= elapsedMinutes + tolerance         (physically possible)
   *
   * Wall clock alone passes for a child who pressed start, put the phone down
   * and came back an hour later. Foreground alone passes for a device that
   * simply lies. Requiring both bounds the lie by real elapsed time, so a
   * fabricated 20 minutes still costs 20 real minutes of holding the attempt
   * open — which is the honest attempt.
   */
  readonly foregroundMinutes: number | null;
  /** What the child submitted. Evidence, not a decision. */
  readonly submission: VerificationSubmission;
  /** Reused `LearningAssessment.scorePercent`, when the method is
   * ASSESSMENT_SCORE. */
  readonly assessmentScorePercent: number | null;
  /** Program-level override — a parent can force a human decision on anything. */
  readonly requiresParentApproval: boolean;
}

export interface VerificationSubmission {
  readonly selfConfirmed?: boolean;
  readonly quizCorrect?: number;
  readonly quizTotal?: number;
  /** Opaque reference to an uploaded recitation or artifact. NO audio and NO
   * image processing is built in this sprint — this is a reference and nothing
   * else, and the report says so rather than implying a capability. */
  readonly submissionRef?: string;
  readonly testsPassed?: number;
  readonly testsTotal?: number;
  readonly note?: string;
}

export interface VerificationOutcome {
  readonly result: VerificationResult;
  /** 0..100 when the method produces a score, null otherwise. */
  readonly scorePercent: number | null;
  /** Machine-readable, stored on the attempt row. */
  readonly reasonCode: string;
  readonly messageAr: string;
}

export const DEFAULT_PASS_SCORE_PERCENT = 70;

/**
 * Clock tolerance for the foreground check, in minutes. A device's foreground
 * accounting and the server's `startedAt`/`submittedAt` are two different
 * clocks; one minute absorbs the rounding without opening a useful gap.
 */
export const FOREGROUND_TOLERANCE_MINUTES = 1;

/** How many times a child may re-submit one achievement before it locks and a
 * parent must decide. Non-punitive (CONTEXT §3 principle 7): locking escalates
 * to a human, it never says "you failed". */
export const MAX_VERIFICATION_ATTEMPTS = 3;
