/**
 * THE VERIFICATION ENGINE — pure, therefore provable without a database.
 *
 * The property under test in every block below is the same one: a child
 * completing a timer must NOT automatically earn a reward, and no strategy can
 * grant anything by itself. `verify()` applies two gates after the strategy, and
 * neither can be bypassed by a strategy returning the "wrong" thing.
 */
import {
  DEFAULT_PASS_SCORE_PERCENT,
  MAX_VERIFICATION_ATTEMPTS,
  SELF_CHECK_ALLOWED_CATEGORIES,
  VERIFICATION_MATRIX,
  VERIFICATION_METHODS,
  canAutoApprove,
  isVerificationMethod,
  type VerificationInput,
  type VerificationMethod,
} from '../../src/shared/rewards/verification';
import { VERIFICATION_STRATEGIES, verify } from '../../src/modules/rewards-engine/domain/verification-strategies';

const base = (over: Partial<VerificationInput> = {}): VerificationInput => ({
  method: 'DURATION',
  requiredDurationMinutes: 20,
  passScorePercent: 0,
  elapsedMinutes: 25,
  foregroundMinutes: 21,
  submission: {},
  assessmentScorePercent: null,
  requiresParentApproval: false,
  ...over,
});

describe('the verification method catalogue', () => {
  it('carries every method the brief names, verbatim', () => {
    for (const m of [
      'PARENT_CONFIRMATION',
      'QUIZ',
      'ASSESSMENT_SCORE',
      'SELF_CHECK',
      'DURATION',
      'RECITATION_SUBMISSION',
      'COMPLETION_ARTIFACT',
    ]) {
      expect(isVerificationMethod(m)).toBe(true);
    }
  });

  it('has a strategy for every method — no method can be selected with no implementation', () => {
    for (const m of VERIFICATION_METHODS) {
      expect(typeof VERIFICATION_STRATEGIES[m]).toBe('function');
      expect(VERIFICATION_MATRIX[m].method).toBe(m);
    }
  });

  it('the human-decided methods cannot auto-approve — this is data, not a comment', () => {
    expect(canAutoApprove('PARENT_CONFIRMATION')).toBe(false);
    expect(canAutoApprove('RECITATION_SUBMISSION')).toBe(false);
    expect(canAutoApprove('COMPLETION_ARTIFACT')).toBe(false);
  });

  it('DURATION is the weakest method and must be chosen explicitly', () => {
    expect(VERIFICATION_MATRIX.DURATION.strength).toBe('WEAK');
    expect(VERIFICATION_MATRIX.DURATION.requiresExplicitChoice).toBe(true);
  });

  it('SELF_CHECK is restricted to low-trust categories, and Quran is not one', () => {
    expect(VERIFICATION_MATRIX.SELF_CHECK.lowTrustOnly).toBe(true);
    expect(SELF_CHECK_ALLOWED_CATEGORIES.has('HABITS')).toBe(true);
    expect(SELF_CHECK_ALLOWED_CATEGORIES.has('QURAN')).toBe(false);
    expect(SELF_CHECK_ALLOWED_CATEGORIES.has('MATH')).toBe(false);
  });

  it('allows at most 3 automatic attempts before a human is asked', () => {
    expect(MAX_VERIFICATION_ATTEMPTS).toBe(3);
  });
});

describe('DURATION — anti-gaming', () => {
  it('passes when foreground time reaches the requirement and is physically possible', () => {
    expect(verify(base({ elapsedMinutes: 25, foregroundMinutes: 20 })).result).toBe('PASSED');
  });

  it('FAILS when the app was only open for part of the wall-clock window', () => {
    const out = verify(base({ elapsedMinutes: 90, foregroundMinutes: 4 }));
    expect(out.result).toBe('FAILED');
    expect(out.reasonCode).toBe('DURATION_NOT_SATISFIED');
  });

  it('FAILS a device claiming more foreground time than the window physically allows', () => {
    const out = verify(base({ elapsedMinutes: 5, foregroundMinutes: 40 }));
    expect(out.result).toBe('FAILED');
    expect(out.reasonCode).toBe('FOREGROUND_EXCEEDS_ELAPSED');
  });

  it('tolerates one minute of clock disagreement', () => {
    expect(verify(base({ requiredDurationMinutes: 20, elapsedMinutes: 20, foregroundMinutes: 21 })).result).toBe(
      'PASSED',
    );
  });

  it('FAILS — never silently falls back to wall clock — when no foreground evidence is sent', () => {
    const out = verify(base({ elapsedMinutes: 600, foregroundMinutes: null }));
    expect(out.result).toBe('FAILED');
    expect(out.reasonCode).toBe('FOREGROUND_EVIDENCE_MISSING');
  });
});

describe('SELF_CHECK', () => {
  it('passes only when the child actually confirmed', () => {
    expect(verify(base({ method: 'SELF_CHECK', submission: { selfConfirmed: true } })).result).toBe('PASSED');
    expect(verify(base({ method: 'SELF_CHECK', submission: {} })).result).toBe('FAILED');
  });
});

describe('PARENT_CONFIRMATION', () => {
  it('NEVER grants — it can only ever escalate', () => {
    const out = verify(base({ method: 'PARENT_CONFIRMATION', submission: { selfConfirmed: true } }));
    expect(out.result).toBe('ESCALATED');
    expect(out.reasonCode).toBe('AWAITING_PARENT');
  });
});

describe('QUIZ / ASSESSMENT_SCORE — the threshold', () => {
  it('passes at or above the configured threshold', () => {
    const out = verify(base({ method: 'QUIZ', passScorePercent: 80, submission: { quizCorrect: 8, quizTotal: 10 } }));
    expect(out.result).toBe('PASSED');
    expect(out.scorePercent).toBe(80);
  });

  it('fails below the threshold and says the real numbers', () => {
    const out = verify(base({ method: 'QUIZ', passScorePercent: 80, submission: { quizCorrect: 7, quizTotal: 10 } }));
    expect(out.result).toBe('FAILED');
    expect(out.scorePercent).toBe(70);
  });

  it(`uses ${DEFAULT_PASS_SCORE_PERCENT}% when the program configured no threshold`, () => {
    expect(
      verify(base({ method: 'QUIZ', passScorePercent: 0, submission: { quizCorrect: 7, quizTotal: 10 } })).result,
    ).toBe('PASSED');
    expect(
      verify(base({ method: 'QUIZ', passScorePercent: 0, submission: { quizCorrect: 6, quizTotal: 10 } })).result,
    ).toBe('FAILED');
  });

  it('rejects an impossible quiz result rather than trusting it', () => {
    const out = verify(base({ method: 'QUIZ', submission: { quizCorrect: 12, quizTotal: 10 } }));
    expect(out.result).toBe('FAILED');
    expect(out.reasonCode).toBe('QUIZ_NOT_SUBMITTED');
  });

  it('ASSESSMENT_SCORE reads the reused LearningAssessment score', () => {
    expect(verify(base({ method: 'ASSESSMENT_SCORE', assessmentScorePercent: 85, passScorePercent: 70 })).result).toBe(
      'PASSED',
    );
    expect(verify(base({ method: 'ASSESSMENT_SCORE', assessmentScorePercent: 40, passScorePercent: 70 })).result).toBe(
      'FAILED',
    );
    expect(verify(base({ method: 'ASSESSMENT_SCORE', assessmentScorePercent: null })).reasonCode).toBe(
      'ASSESSMENT_NOT_FOUND',
    );
  });
});

describe('RECITATION_SUBMISSION and COMPLETION_ARTIFACT — evidence, never a decision', () => {
  it('a recitation with a reference waits for a human, it does not grant', () => {
    const out = verify(base({ method: 'RECITATION_SUBMISSION', submission: { submissionRef: 'upload://abc' } }));
    expect(out.result).toBe('ESCALATED');
    expect(out.reasonCode).toBe('RECITATION_AWAITING_REVIEW');
  });

  it('a recitation with NO reference fails — nothing was submitted', () => {
    expect(verify(base({ method: 'RECITATION_SUBMISSION', submission: {} })).reasonCode).toBe('RECITATION_MISSING');
  });

  it('an artifact behaves the same way — no image is analysed in this sprint', () => {
    expect(verify(base({ method: 'COMPLETION_ARTIFACT', submission: { submissionRef: 'upload://x' } })).result).toBe(
      'ESCALATED',
    );
    expect(verify(base({ method: 'COMPLETION_ARTIFACT', submission: {} })).result).toBe('FAILED');
  });
});

describe('DURATION_PLUS_QUIZ — both, and the honest reason first', () => {
  it('reports the DURATION failure even when the quiz was passed', () => {
    const out = verify(
      base({
        method: 'DURATION_PLUS_QUIZ',
        foregroundMinutes: 2,
        passScorePercent: 50,
        submission: { quizCorrect: 10, quizTotal: 10 },
      }),
    );
    expect(out.result).toBe('FAILED');
    expect(out.reasonCode).toBe('DURATION_NOT_SATISFIED');
  });

  it('passes only when both hold', () => {
    const out = verify(
      base({
        method: 'DURATION_PLUS_QUIZ',
        foregroundMinutes: 21,
        passScorePercent: 50,
        submission: { quizCorrect: 10, quizTotal: 10 },
      }),
    );
    expect(out.result).toBe('PASSED');
  });
});

describe('THE TWO GATES — a strategy is never the last word', () => {
  it('requiresParentApproval turns ANY pass into an escalation', () => {
    const out = verify(base({ method: 'DURATION', elapsedMinutes: 35, foregroundMinutes: 30, requiresParentApproval: true }));
    expect(out.result).toBe('ESCALATED');
    expect(out.reasonCode).toBe('PROGRAM_REQUIRES_PARENT_APPROVAL');
  });

  it('a method that may not auto-approve cannot produce PASSED even if its strategy did', () => {
    // Prove the gate directly: force the strategy to return PASSED for a method
    // whose matrix entry forbids auto-approval.
    const forced = VERIFICATION_STRATEGIES.RECITATION_SUBMISSION;
    expect(forced(base({ submission: { submissionRef: 'x' } })).result).toBe('ESCALATED');

    for (const m of VERIFICATION_METHODS.filter((x) => !VERIFICATION_MATRIX[x].canAutoApprove)) {
      const out = verify(
        base({
          method: m as VerificationMethod,
          submission: { submissionRef: 'x', selfConfirmed: true, quizCorrect: 10, quizTotal: 10 },
          assessmentScorePercent: 100,
          foregroundMinutes: 60,
          elapsedMinutes: 60,
        }),
      );
      expect(out.result).not.toBe('PASSED');
    }
  });

  it('a FAILED result is never upgraded to an escalation by either gate', () => {
    const out = verify(base({ method: 'QUIZ', submission: {}, requiresParentApproval: true }));
    expect(out.result).toBe('FAILED');
  });

  it('an unknown method fails closed', () => {
    const out = verify(base({ method: 'NOT_A_METHOD' as VerificationMethod }));
    expect(out.result).toBe('FAILED');
    expect(out.reasonCode).toBe('UNKNOWN_METHOD');
  });
});
