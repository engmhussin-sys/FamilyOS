import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';
import { ageInYears } from '../../domain/program-rules';
import { FamilyDateService } from '../../../../common/time/family-date.service';

/**
 * B5 (PA-B-017) — THE SERVER OWNS THE QUESTIONS AND THE SERVER OWNS THE SCORE.
 *
 * THE EXPLOIT, restated precisely so the fix can be checked against it. The
 * `QUIZ` strategy read `submission.quizCorrect` and `submission.quizTotal`,
 * both of which arrived in `SubmitAchievementDto` FROM THE CHILD'S DEVICE.
 * `VERIFICATION_MATRIX.QUIZ.canAutoApprove` was `true`. The only server-side
 * checks were `correct <= total` and `total > 0`. So `{"quizCorrect": 10,
 * "quizTotal": 10}` was a valid, well-formed, auto-approved 100% — a child
 * with a proxy, or simply a modified client, granted herself every quiz
 * reward in the product. `grep -rn "correctAnswer\|answerKey\|questionBank"
 * src/` returned NOTHING: there was no bank and no key to grade against, so
 * the strategy's own rationale («يُقارن الحاصل بعتبة النجاح المحدّدة في
 * البرنامج، خادميًا») was true of the COMPARISON and false of the INPUT.
 *
 * THE FIX IS PROVENANCE, NOT MORE VALIDATION. No amount of range-checking a
 * number makes the number trustworthy. Two things had to move to the server:
 *
 *   WHICH QUESTIONS   `serve()` draws them and RECORDS the draw in
 *                     `quiz_assignments`, so grading cannot be tricked into
 *                     scoring a set the child chose. The draw is per ATTEMPT,
 *                     unique at the database level, so a second `GET` inside
 *                     one attempt returns the same questions rather than
 *                     re-rolling until an easy set appears.
 *
 *   THE ANSWER KEY    `correctChoiceIndex` lives in `quiz_questions`, is read
 *                     by exactly one repository method, and is never selected
 *                     into anything that becomes a response body.
 *
 * WHAT THE CLIENT SENDS NOW is `quizAnswers: number[]` — one chosen index per
 * served question, positionally aligned with what `serve()` returned. There is
 * no field on `SubmitAchievementDto` by which a child can state a SCORE any
 * more; `quizCorrect` and `quizTotal` were REMOVED, not merely ignored, so an
 * old client sending them is rejected by `forbidNonWhitelisted` rather than
 * silently getting the old behaviour.
 *
 * WHAT IS DELIBERATELY NOT BUILT. No adaptive difficulty, no item-response
 * theory, no per-question timing, no anti-copy shuffling of choice order. And
 * NO CURRICULUM: migration 0008 seeds twelve explicitly-labelled SAMPLE
 * questions so the mechanism is provable end to end, and authoring a real,
 * reviewed, age-graded bank is a business decision flagged for the client in
 * the B5+B9 report rather than invented here.
 */

/** How many questions one attempt draws. Small on purpose: a child aged 6–13
 * answering on a phone, and a threshold expressed as a percentage needs enough
 * items that one mistake is not automatically a fail at 70%. Five items makes
 * 80% the first passing grade above one error. */
export const QUIZ_QUESTIONS_PER_ATTEMPT = 5;

export interface IServedQuestion {
  readonly id: string;
  readonly promptAr: string;
  readonly choices: readonly string[];
  readonly difficulty: string;
}

export interface IServedQuiz {
  readonly achievementId: string;
  readonly attemptNo: number;
  readonly totalCount: number;
  readonly questions: readonly IServedQuestion[];
}

export interface IQuizGrade {
  readonly correct: number;
  readonly total: number;
}

@Injectable()
export class QuizService {
  constructor(
    private readonly repo: PrismaRewardProgramRepository,
    private readonly familyDate: FamilyDateService,
  ) {}

  /**
   * DRAW AND RECORD. Called by the child's `GET /self/achievements/:id/quiz`.
   *
   * The draw is deterministic given the attempt: the assignment row is created
   * once and re-read afterwards. Two concurrent GETs collide on
   * `quiz_assignments (achievement_id, attempt_no)` and the loser re-reads the
   * winner's row — the same "let the database serialise it" pattern
   * `AchievementService.start` already uses for `ATTEMPT_ALREADY_OPEN`, rather
   * than a check-then-act that a race walks straight through.
   */
  async serve(childId: string, achievementId: string, now = new Date()): Promise<IServedQuiz> {
    const achievement = await this.repo.findAchievement(achievementId);
    if (!achievement || achievement.childId !== childId) {
      throw new NotFoundException({ code: 'ACHIEVEMENT_NOT_FOUND', messageAr: 'المحاولة غير موجودة.' });
    }
    const program = await this.repo.findProgram(achievement.programId);
    if (!program) {
      throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', messageAr: 'البرنامج غير موجود.' });
    }
    if (!['QUIZ', 'DURATION_PLUS_QUIZ'].includes(String(program.verificationLevel))) {
      throw new ConflictException({
        code: 'PROGRAM_HAS_NO_QUIZ',
        messageAr: 'هذا البرنامج لا يتضمّن اختبارًا.',
      });
    }

    const attemptNo = (await this.repo.countAttempts(achievementId)) + 1;
    const existing = await this.repo.findAssignment(achievementId, attemptNo);
    if (existing) return this.render(existing);

    const child = await this.repo.findChild(childId);
    const timeZone = await this.familyDate.timeZoneOf(String(program.familyId));
    const ageYears = child ? ageInYears(new Date(child.dateOfBirth), now, timeZone) : null;

    const config = (program.verificationConfig ?? {}) as { subject?: string };
    const pool = await this.repo.listBankQuestions({
      category: String(program.category),
      subject: config.subject ?? null,
      ageYears,
    });

    if (pool.length === 0) {
      // NON-PUNITIVE (CONTEXT §3 principle 7) AND HONEST: an empty bank is an
      // operator gap, not the child's fault, and it must not silently fall
      // back to trusting the device — which is exactly the behaviour being
      // removed. 409 with a real code so the parent app can surface
      // "author some questions" rather than a generic failure.
      throw new ConflictException({
        code: 'QUIZ_BANK_EMPTY',
        messageAr: 'لا توجد أسئلة جاهزة لهذا النشاط بعد. أخبر ولي أمرك ليضيفها.',
      });
    }

    const picked = this.pick(pool, achievementId, attemptNo);
    const created = await this.repo.createAssignment({
      achievementId,
      childId,
      attemptNo,
      questionIds: picked.map((q) => q.id),
      totalCount: picked.length,
      servedAt: now,
    });
    return this.render(created, picked);
  }

  /**
   * GRADE. Called by `AchievementService.submit` BEFORE `verify()` runs, and
   * its return value is what becomes `quizCorrect`/`quizTotal` in the
   * `VerificationInput`. The pure strategy in `verification-strategies.ts` is
   * unchanged — it always compared a count against a threshold correctly; what
   * changed is that the count is now produced here, from the answer key, and
   * cannot be produced anywhere else.
   *
   * Returns `null` when there is no served assignment, which the caller turns
   * into the existing `QUIZ_NOT_SUBMITTED` failure. Answering a quiz that was
   * never served is not a 500 and it is not a zero — it is "you have not taken
   * the quiz yet", and the child is told to open it.
   */
  async grade(
    achievementId: string,
    attemptNo: number,
    answers: readonly number[],
    now = new Date(),
  ): Promise<IQuizGrade | null> {
    const assignment = await this.repo.findAssignment(achievementId, attemptNo);
    if (!assignment) return null;

    const questionIds = this.questionIdsOf(assignment);
    const key = new Map(
      (await this.repo.answerKeyFor(questionIds)).map((q) => [q.id, q.correctChoiceIndex]),
    );

    // POSITIONAL, against the SERVER'S order. `answers[i]` is the choice for
    // `questionIds[i]`. A short array is not an error — the unanswered tail is
    // simply wrong, which is what leaving questions blank means — and a long
    // one is truncated, so a client cannot pad its way to a higher count.
    let correct = 0;
    for (let i = 0; i < questionIds.length; i += 1) {
      const expected = key.get(questionIds[i]);
      if (expected !== undefined && answers[i] === expected) correct += 1;
    }

    await this.repo.markAssignmentGraded(String(assignment.id), correct, now);
    return { correct, total: questionIds.length };
  }

  /**
   * THE DRAW, and why it is not `Math.random()`.
   *
   * A random draw is untestable and, worse, unreproducible: the assignment row
   * records which questions were served, so a support question of the form
   * "why did my child get these five?" has to be answerable. This is a
   * deterministic rotation seeded by `(achievementId, attemptNo)` — every
   * attempt gets a different, well-spread slice of the pool, the same attempt
   * always gets the same slice, and a child cannot influence the seed because
   * both halves are server-assigned.
   *
   * It is NOT a security control and is not presented as one: with a small
   * bank, a determined child re-attempting will eventually see repeats. The
   * control that matters is that she never sees the ANSWERS, and that
   * `MAX_VERIFICATION_ATTEMPTS` escalates to a parent after three tries.
   */
  private pick<T extends { id: string }>(pool: readonly T[], achievementId: string, attemptNo: number): T[] {
    const take = Math.min(QUIZ_QUESTIONS_PER_ATTEMPT, pool.length);
    let seed = attemptNo * 2654435761;
    for (const ch of achievementId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const start = seed % pool.length;
    // A co-prime stride so the walk visits distinct indices rather than
    // clustering, without needing to shuffle a copy of the whole pool.
    const stride = 1 + (seed % Math.max(1, pool.length - 1));
    const step = this.coprimeStride(stride, pool.length);

    const out: T[] = [];
    const seen = new Set<number>();
    let idx = start;
    while (out.length < take) {
      if (!seen.has(idx)) {
        seen.add(idx);
        out.push(pool[idx]);
      }
      idx = (idx + step) % pool.length;
      if (seen.size >= pool.length) break;
    }
    return out;
  }

  private coprimeStride(candidate: number, modulus: number): number {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    for (let s = candidate; s < candidate + modulus; s += 1) {
      const v = 1 + (s % Math.max(1, modulus - 1));
      if (gcd(v, modulus) === 1) return v;
    }
    return 1;
  }

  private questionIdsOf(assignment: { questionIds: unknown }): string[] {
    const raw = assignment.questionIds;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  }

  /** Renders WITHOUT the answer key. When `known` is absent (the re-read path)
   * the questions are fetched by id and the key is dropped by the repository's
   * own `select`, so there is no code path here that could include it. */
  private async render(
    assignment: { id: string; achievementId: string; attemptNo: number; questionIds: unknown; totalCount: number },
    known?: Array<{ id: string; promptAr: string; choices: unknown; difficulty: string }>,
  ): Promise<IServedQuiz> {
    const ids = this.questionIdsOf(assignment);
    const source = known ?? (await this.repo.listBankQuestionsByIds(ids));
    const byId = new Map(source.map((q) => [q.id, q]));

    const questions: IServedQuestion[] = ids
      .map((id) => byId.get(id))
      .filter((q): q is { id: string; promptAr: string; choices: unknown; difficulty: string } => q !== undefined)
      .map((q) => ({
        id: q.id,
        promptAr: q.promptAr,
        choices: Array.isArray(q.choices) ? q.choices.map((c) => String(c)) : [],
        difficulty: q.difficulty,
      }));

    return {
      achievementId: String(assignment.achievementId),
      attemptNo: assignment.attemptNo,
      totalCount: assignment.totalCount,
      questions,
    };
  }
}
