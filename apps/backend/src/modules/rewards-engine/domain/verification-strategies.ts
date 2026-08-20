/**
 * THE VERIFICATION STRATEGY REGISTRY.
 *
 * Nine strategies, each a PURE function of `VerificationInput` -> a
 * `VerificationOutcome`. Zero I/O, zero Prisma, zero NestJS — the same
 * discipline `rewards-rules.ts`, `streak-calculator.ts` and `health-rules.ts`
 * already use in this repository, and the reason every branch below is
 * unit-testable without a database.
 *
 * THE RULE THE WHOLE SPRINT TURNS ON: a strategy can return `PASSED`, but only
 * the ENGINE decides whether a PASS is allowed to become a grant, by consulting
 * `VERIFICATION_MATRIX[method].canAutoApprove`. A strategy that must escalate
 * cannot accidentally auto-approve, because its own return value is not the
 * final word — `verify()` below applies the matrix afterwards, in one place.
 *
 * And nothing here is reachable from a child-authenticated write path: the
 * engine runs on the server's own clock and the server's own measurements, and
 * the grant that may follow runs inside a consumer, after the event.
 */
import {
  DEFAULT_PASS_SCORE_PERCENT,
  FOREGROUND_TOLERANCE_MINUTES,
  VERIFICATION_MATRIX,
  verificationMethodUnavailability,
  type VerificationInput,
  type VerificationMethod,
  type VerificationOutcome,
} from '../../../shared/rewards/verification';

export type VerificationStrategy = (input: VerificationInput) => VerificationOutcome;

const pass = (
  reasonCode: string,
  messageAr: string,
  scorePercent: number | null = null,
): VerificationOutcome => ({ result: 'PASSED', scorePercent, reasonCode, messageAr });

const fail = (
  reasonCode: string,
  messageAr: string,
  scorePercent: number | null = null,
): VerificationOutcome => ({ result: 'FAILED', scorePercent, reasonCode, messageAr });

const escalate = (
  reasonCode: string,
  messageAr: string,
  scorePercent: number | null = null,
): VerificationOutcome => ({ result: 'ESCALATED', scorePercent, reasonCode, messageAr });

/** `quizCorrect / quizTotal` as a whole percent, or null when not submitted. */
function quizScore(input: VerificationInput): number | null {
  const { quizCorrect, quizTotal } = input.submission;
  if (typeof quizCorrect !== 'number' || typeof quizTotal !== 'number' || quizTotal <= 0) return null;
  if (quizCorrect < 0 || quizCorrect > quizTotal) return null;
  return Math.round((quizCorrect / quizTotal) * 100);
}

function testScore(input: VerificationInput): number | null {
  const { testsPassed, testsTotal } = input.submission;
  if (typeof testsPassed !== 'number' || typeof testsTotal !== 'number' || testsTotal <= 0) return null;
  if (testsPassed < 0 || testsPassed > testsTotal) return null;
  return Math.round((testsPassed / testsTotal) * 100);
}

function threshold(input: VerificationInput): number {
  return input.passScorePercent > 0 ? input.passScorePercent : DEFAULT_PASS_SCORE_PERCENT;
}

/**
 * THE ANTI-GAMING CHECK, and the only place time-on-task is decided.
 *
 * Two conditions, both required, both explained in `verification.ts`:
 *   (a) the device's FOREGROUND minutes reach the program's required duration;
 *   (b) those foreground minutes are not more than the server's own wall-clock
 *       window (plus one minute of clock tolerance) — a device claiming 40
 *       foreground minutes inside a 5-minute server window is lying, and the
 *       server can prove it without trusting the device at all.
 *
 * A missing `foregroundMinutes` is a FAIL, not a fallback to wall clock.
 * Falling back would mean an older client silently gets the weaker rule, which
 * is exactly how an anti-gaming control stops being one.
 */
type DurationCheck =
  | { ok: true; foreground: number }
  | { ok: false; reasonCode: string; messageAr: string };

function checkDuration(input: VerificationInput): DurationCheck {
  const fg = input.foregroundMinutes;
  if (fg === null || !Number.isFinite(fg) || fg < 0) {
    return {
      ok: false,
      reasonCode: 'FOREGROUND_EVIDENCE_MISSING',
      messageAr: 'لم يصل قياس زمن العمل داخل التطبيق. أعد المحاولة من تطبيق محدَّث.',
    };
  }
  if (fg > input.elapsedMinutes + FOREGROUND_TOLERANCE_MINUTES) {
    return {
      ok: false,
      reasonCode: 'FOREGROUND_EXCEEDS_ELAPSED',
      messageAr: 'زمن العمل المُبلَّغ أكبر من الزمن الحقيقي بين البدء والإرسال.',
    };
  }
  if (fg < input.requiredDurationMinutes) {
    return {
      ok: false,
      reasonCode: 'DURATION_NOT_SATISFIED',
      messageAr: `زمن العمل ${fg} دقيقة من أصل ${input.requiredDurationMinutes} — أكمل الوقت ثم أرسل مرة أخرى.`,
    };
  }
  return { ok: true, foreground: fg };
}

export const DURATION: VerificationStrategy = (input) => {
  const check = checkDuration(input);
  return check.ok
    ? pass('DURATION_SATISFIED', 'اكتملت المدة المطلوبة من العمل الفعلي.')
    : fail(check.reasonCode, check.messageAr);
};

export const SELF_CHECK: VerificationStrategy = (input) =>
  input.submission.selfConfirmed === true
    ? pass('SELF_CONFIRMED', 'تم تأكيد الإنجاز ذاتيًا.')
    : fail('SELF_NOT_CONFIRMED', 'لم يُؤكَّد الإنجاز بعد.');

/** Never auto-approves. The server records that a decision is OWED, and stops. */
export const PARENT_CONFIRMATION: VerificationStrategy = () =>
  escalate('AWAITING_PARENT', 'بانتظار تأكيد ولي الأمر.');

export const QUIZ: VerificationStrategy = (input) => {
  const score = quizScore(input);
  if (score === null) return fail('QUIZ_NOT_SUBMITTED', 'لم تُرسَل إجابات الاختبار.');
  return score >= threshold(input)
    ? pass('QUIZ_PASSED', `النتيجة ${score}% — اجتزت العتبة.`, score)
    : fail('QUIZ_BELOW_THRESHOLD', `النتيجة ${score}% والعتبة ${threshold(input)}%. جرّب مرة أخرى.`, score);
};

/**
 * The child submits, a parent decides. Only the reference is stored — NO audio
 * processing is built in this sprint, and this docstring says so rather than
 * the report claiming a capability that does not exist.
 */
export const RECITATION_SUBMISSION: VerificationStrategy = (input) =>
  input.submission.submissionRef
    ? escalate('RECITATION_AWAITING_REVIEW', 'تم استلام التسميع، وهو بانتظار المراجعة.')
    : fail('RECITATION_MISSING', 'لم يُرفَق تسجيل التسميع.');

/** Same shape as RECITATION_SUBMISSION and deliberately so: an artifact is
 * evidence a human looks at. No image classification is built. */
export const COMPLETION_ARTIFACT: VerificationStrategy = (input) =>
  input.submission.submissionRef
    ? escalate('ARTIFACT_AWAITING_REVIEW', 'تم استلام دليل الإنجاز، وهو بانتظار المراجعة.')
    : fail('ARTIFACT_MISSING', 'لم يُرفَق دليل الإنجاز.');

/**
 * REUSE: the score comes from the existing `LearningAssessment` model, read by
 * the engine before the strategy runs. No new score table was created for this.
 *
 * WHY THE FIRST BRANCH ESCALATES INSTEAD OF FAILING, AND WHY IT IS NOT A ZERO.
 *
 * `LearningAssessment` has no writer anywhere in `src/`, so `latestAssessment
 * Score` returns `null` for every child, forever. Before this branch existed
 * that `null` fell through to `ASSESSMENT_NOT_FOUND` — a FAILED verdict reading
 * «لا يوجد تقييم مسجَّل لهذه المادة بعد», observed three times in a row against
 * a real database, burning the child's three attempts on a condition no code
 * path in this product can satisfy. That is a punitive answer to a defect the
 * child had no part in (CONTEXT §3 principle 7), and a parent whose program was
 * created before the create-time guard landed still owns one.
 *
 * Three candidates: FAIL (what it did — blames the child), score it zero or
 * from a proxy (a reward the child did not earn, explicitly refused), or hand
 * it to the only party who can actually judge the work. ESCALATED is the third,
 * and it is what this file already does wherever the server cannot produce the
 * input it would need — `CODE_CHALLENGE` since B5, `RECITATION_SUBMISSION` from
 * the start. No grant, no crash, no invented score, and the child's effort is
 * not thrown away.
 *
 * `assessmentSourceAvailable` is the ratchet. It is read from
 * `UNAVAILABLE_VERIFICATION_METHODS`, whose `ASSESSMENT_SCORE` entry a build
 * failure deletes the day a writer lands; this branch then stops being
 * reachable and `ASSESSMENT_NOT_FOUND` below — the honest answer for a child
 * who simply has not sat the assessment — becomes live again by itself.
 */
export const ASSESSMENT_SCORE: VerificationStrategy = (input) => {
  if (!input.assessmentSourceAvailable) {
    return escalate(
      'ASSESSMENT_SOURCE_UNAVAILABLE',
      verificationMethodUnavailability('ASSESSMENT_SCORE')?.childMessageAr ??
        'هذه المهمة مربوطة بدرجة تقييم دراسي غير متاحة بعد. أرسلنا محاولتك إلى ولي الأمر.',
    );
  }
  if (input.assessmentScorePercent === null) {
    return fail('ASSESSMENT_NOT_FOUND', 'لا يوجد تقييم مسجَّل لهذه المادة بعد.');
  }
  const score = Math.round(input.assessmentScorePercent);
  return score >= threshold(input)
    ? pass('ASSESSMENT_PASSED', `نتيجة التقييم ${score}%.`, score)
    : fail('ASSESSMENT_BELOW_THRESHOLD', `نتيجة التقييم ${score}% والعتبة ${threshold(input)}%.`, score);
};

export const CODE_CHALLENGE: VerificationStrategy = (input) => {
  const score = testScore(input);
  if (score === null) return fail('CODE_TESTS_NOT_SUBMITTED', 'لم تُرسَل نتيجة الاختبارات.');
  return score >= threshold(input)
    ? pass('CODE_TESTS_PASSED', `نجحت ${score}% من الاختبارات.`, score)
    : fail('CODE_TESTS_BELOW_THRESHOLD', `نجحت ${score}% من الاختبارات والعتبة ${threshold(input)}%.`, score);
};

/** BOTH conditions. The duration is checked first so a child who passed the
 * quiz but skipped the work gets the honest reason, not the flattering one. */
export const DURATION_PLUS_QUIZ: VerificationStrategy = (input) => {
  const check = checkDuration(input);
  if (!check.ok) return fail(check.reasonCode, check.messageAr, quizScore(input));
  return QUIZ(input);
};

export const VERIFICATION_STRATEGIES: Readonly<Record<VerificationMethod, VerificationStrategy>> = {
  DURATION,
  SELF_CHECK,
  PARENT_CONFIRMATION,
  QUIZ,
  RECITATION_SUBMISSION,
  ASSESSMENT_SCORE,
  COMPLETION_ARTIFACT,
  CODE_CHALLENGE,
  DURATION_PLUS_QUIZ,
};

/**
 * THE ONE PLACE A VERIFICATION OUTCOME IS DECIDED.
 *
 * Two gates are applied AFTER the strategy, in this order, and neither can be
 * bypassed by a strategy returning the wrong thing:
 *
 *   1. `requiresParentApproval` on the program — a parent may force a human
 *      decision on ANY program regardless of its method.
 *   2. `canAutoApprove` from the matrix — a PASS from a method that may not
 *      auto-approve becomes ESCALATED, never a grant.
 *
 * A FAILED result is never upgraded by either gate: failing and then waiting
 * for a parent is a worse experience than failing and retrying, and it would
 * bury a parent's queue under every mistyped quiz.
 */
export function verify(input: VerificationInput): VerificationOutcome {
  const strategy = VERIFICATION_STRATEGIES[input.method];
  if (!strategy) {
    return fail('UNKNOWN_METHOD', 'طريقة التحقق غير معروفة.');
  }

  const outcome = strategy(input);
  if (outcome.result !== 'PASSED') return outcome;

  if (input.requiresParentApproval) {
    return {
      ...outcome,
      result: 'ESCALATED',
      reasonCode: 'PROGRAM_REQUIRES_PARENT_APPROVAL',
      messageAr: 'تم استيفاء الشروط، وينتظر الإنجاز موافقة ولي الأمر.',
    };
  }

  if (!VERIFICATION_MATRIX[input.method].canAutoApprove) {
    return {
      ...outcome,
      result: 'ESCALATED',
      reasonCode: 'METHOD_CANNOT_AUTO_APPROVE',
      messageAr: 'هذه الطريقة تتطلّب قرار ولي الأمر.',
    };
  }

  return outcome;
}
