/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-03 — THE LEARNING QUIZ. THE CHILD SENDS ANSWERS, NEVER A SCORE.
 * ============================================================================
 *
 * THE PRODUCT LOOP THIS PROTECTS:
 *
 *   A parent authors a few questions for their child's subject, and attaches a
 *   quiz to a learning goal.
 *     -> the child opens the quiz on their own device and receives QUESTIONS
 *        AND CHOICES — and nothing else. The answer key is not merely omitted
 *        from the JSON; the repository method behind that route selects four
 *        columns and the key is not one of them;
 *     -> the child answers, and what leaves the device is an ANSWER SHEET —
 *        one chosen index per served question. `SubmitAchievementDto` has no
 *        field by which a score can be stated at all;
 *     -> the SERVER grades, against its own key, over the questions IT drew and
 *        recorded for THIS attempt;
 *     -> a passing sheet pays exactly once. A failing sheet pays NOTHING, and
 *        says so in Arabic, without punishing anyone.
 *
 * WHY THIS SCENARIO EXISTS SEPARATELY FROM E2E-01 AND E2E-02. It is the only
 * loop in the product where the child's own input produces the OUTCOME rather
 * than merely evidence for it, which makes it the one loop where "who computes
 * the result" is the entire security model. The historical shape of that
 * question is on the record: `quizCorrect` and `quizTotal` were once fields on
 * the child's request while `QUIZ.canAutoApprove` was `true`, so a well-formed
 * `{"quizCorrect": 10, "quizTotal": 10}` was an auto-approved 100%. Those two
 * fields were DELETED rather than ignored, so an old client sending them is
 * rejected by name. This scenario re-proves the whole chain from the outside,
 * over HTTP, exactly as a modified client would attack it.
 *
 * ON THE QUESTION BANK. The parent authors five questions in `STUDY`, a
 * category migration 0008 seeds nothing into, so the pool for this attempt is
 * exactly the five whose keys this scenario knows. That is a deliberate fixture
 * choice: a scenario that could not predict the correct answers could not tell
 * a grader that works from a grader that returns a constant.
 *
 * Real PostgreSQL, real Redis, real booted app, real HTTP. Nothing stubbed.
 */
import {
  GOLDEN_NOON,
  P,
  ageTheHousehold,
  asChild,
  asParent,
  bootGoldenWorld,
  countTheLoop,
  describeGolden,
  freezeGoldenClock,
  goldenAt,
  type GoldenHousehold,
  type GoldenWorld,
} from './golden-world';

import request = require('supertest');

/** The parent's five questions. The index is the RIGHT answer, and it is
 * deliberately never 0 so that "answer everything with the first choice" — the
 * cheapest possible attack — scores exactly zero. */
const THE_QUESTIONS = [
  { promptAr: 'ما عاصمة مصر؟', choices: ['الإسكندرية', 'القاهرة', 'أسوان'], correctChoiceIndex: 1 },
  { promptAr: 'كم عدد أيام الأسبوع؟', choices: ['خمسة', 'ستة', 'سبعة'], correctChoiceIndex: 2 },
  { promptAr: 'ما أكبر كوكب في المجموعة الشمسية؟', choices: ['الأرض', 'المشتري', 'عطارد'], correctChoiceIndex: 1 },
  { promptAr: 'كم ضلعًا للمربع؟', choices: ['ثلاثة', 'أربعة', 'خمسة'], correctChoiceIndex: 1 },
  { promptAr: 'ما لون السماء في يوم صافٍ؟', choices: ['أخضر', 'أزرق', 'أحمر'], correctChoiceIndex: 1 },
];

describeGolden('GOLDEN E2E-03 — the child answers, the server grades, and a wrong run pays nothing', () => {
  let world: GoldenWorld;
  let home: GoldenHousehold;
  let programId: string;
  /** promptAr -> the index the parent declared correct. The scenario's own key. */
  const answerKey = new Map<string, number>();
  let subject: string;

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('golden E2E-03 (quiz)');
    home = await world.register('e2e03');
    await ageTheHousehold(world, home, goldenAt('08:00'));
    subject = `golden-${Date.now()}`;
  }, 180_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  /**
   * ONE ATTEMPT, THREE TRIES — which is what the product actually allows.
   *
   * `MAX_OPEN_ATTEMPTS_PER_DAY` is 1, so a child cannot hold two open attempts
   * at once, and `MAX_VERIFICATION_ATTEMPTS` is 3, so one attempt may be
   * submitted three times before it escalates to a parent. This scenario
   * therefore tells one continuous story on one attempt — blind, then guessing,
   * then knowing — rather than manufacturing three attempts the product would
   * refuse to give a real child.
   */
  let achievementId: string;

  /** The answer sheet a child who knows the material would send. */
  const rightAnswers = (questions: any[]): number[] =>
    questions.map((q) => answerKey.get(q.promptAr) as number);

  const openTheQuiz = async (): Promise<any> => {
    const quiz = await request(world.http)
      .get(`${P}/self/achievements/${achievementId}/quiz`)
      .set(asChild(home));
    expect(quiz.status).toBe(200);
    return quiz;
  };

  // =========================================================================
  // ACT I — THE PARENT AUTHORS THE QUESTIONS, AND THE KEY NEVER COMES BACK OUT
  // =========================================================================

  it('ACT I — the parent authors five questions, and the answer key is accepted on write and never returned on read', async () => {
    for (const question of THE_QUESTIONS) {
      const created = await request(world.http)
        .post(`${P}/reward-programs/quiz-bank`)
        .set(asParent(home))
        .send({ category: 'STUDY', subject, difficulty: 'EASY', ...question });
      expect([200, 201]).toContain(created.status);
      // Written, and unreadable: the response carries the prompt and the
      // choices, and no property that reveals which choice is right.
      expect(JSON.stringify(created.body)).not.toContain('correctChoiceIndex');
      answerKey.set(question.promptAr, question.correctChoiceIndex);
    }

    const bank = await request(world.http)
      .get(`${P}/reward-programs/quiz-bank`)
      .query({ category: 'STUDY', subject })
      .set(asParent(home));
    expect(bank.status).toBe(200);
    expect(JSON.stringify(bank.body)).not.toContain('correctChoiceIndex');
  });

  it('ACT I — a question whose right answer is not one of its choices is refused before it can exist', async () => {
    const unanswerable = await request(world.http)
      .post(`${P}/reward-programs/quiz-bank`)
      .set(asParent(home))
      .send({ category: 'STUDY', subject, promptAr: 'سؤال بلا إجابة', choices: ['أ', 'ب'], correctChoiceIndex: 4 });

    expect(unanswerable.status).toBe(400);
    expect(unanswerable.body.code).toBe('QUIZ_ANSWER_OUT_OF_RANGE');
  });

  it('ACT I — the parent attaches the quiz to a learning goal worth 25 points', async () => {
    const created = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(home))
      .send({
        childId: home.childId,
        category: 'STUDY',
        activity: 'SOLVE_PROBLEMS',
        targetSpec: { quantity: 5, unit: 'سؤال' },
        durationMinutes: 10,
        verificationLevel: 'QUIZ',
        verificationConfig: { subject },
        rewardSpec: { type: 'POINTS', amount: 25 },
        frequency: 'DAILY',
        maxPerDay: 3,
        maxPerWeek: 14,
      });

    expect([200, 201]).toContain(created.status);
    programId = created.body.id;
    expect(created.body.verificationLevel).toBe('QUIZ');
  });

  // =========================================================================
  // ACT II — THE CHILD OPENS THE QUIZ
  // =========================================================================

  it('ACT II — the child starts, and answering BLIND is «not taken yet» rather than a silent zero-of-zero pass', async () => {
    const started = await request(world.http)
      .post(`${P}/self/achievements/start`)
      .set(asChild(home))
      .send({ programId });
    expect([200, 201]).toContain(started.status);
    achievementId = started.body.id;

    // TRY 1: a sheet with no quiz behind it. A grader that answered this with
    // 0-of-0 would be answering «100%» to a child who never opened the quiz.
    const blind = await request(world.http)
      .post(`${P}/self/achievements/${achievementId}/submit`)
      .set(asChild(home))
      .send({ quizAnswers: [1, 2, 1, 1, 1] });

    expect(blind.body.outcome.result).toBe('FAILED');
    expect(blind.body.outcome.reasonCode).toBe('QUIZ_NOT_SUBMITTED');

    await world.drainOutbox();
    expect(await countTheLoop(world, home)).toMatchObject({ ledger: 0, parentNotifications: 0 });
  });

  it('ACT II — the served quiz carries questions and choices, and NEVER the answer key', async () => {
    const quiz = await openTheQuiz();

    expect(quiz.body.questions).toHaveLength(5);
    for (const question of quiz.body.questions) {
      expect(question.promptAr).toBeTruthy();
      expect(Array.isArray(question.choices)).toBe(true);
      expect(Object.keys(question)).not.toContain('correctChoiceIndex');
    }
    expect(JSON.stringify(quiz.body)).not.toContain('correctChoiceIndex');

    // A SECOND GET inside the same attempt returns the SAME five questions.
    // Without this a child could re-open until an easy draw appeared, and the
    // defence is `quiz_assignments (achievement_id, attempt_no)`, not a check.
    const again = await openTheQuiz();
    expect(again.body.questions.map((q: any) => q.id)).toEqual(
      quiz.body.questions.map((q: any) => q.id),
    );
  });

  // =========================================================================
  // ACT III — A WRONG RUN PAYS NOTHING
  // =========================================================================

  it('ACT III — a wrong answer sheet FAILS, and grants nothing at all', async () => {
    const quiz = await openTheQuiz();

    // TRY 2: every answer is choice 0, and no question's right answer is 0 —
    // so the cheapest possible attack scores exactly zero.
    const submitted = await request(world.http)
      .post(`${P}/self/achievements/${achievementId}/submit`)
      .set(asChild(home))
      .send({ quizAnswers: quiz.body.questions.map(() => 0) });

    expect(submitted.status).toBe(201);
    expect(submitted.body.outcome.result).toBe('FAILED');
    expect(submitted.body.outcome.reasonCode).toBe('QUIZ_BELOW_THRESHOLD');
    expect(submitted.body.outcome.scorePercent).toBe(0);
    // Non-punitive: a score, a threshold and an invitation to try again.
    expect(submitted.body.outcome.messageAr).toContain('جرّب مرة أخرى');

    await world.drainOutbox();
    expect(await countTheLoop(world, home)).toMatchObject({
      ledger: 0,
      timeline: 0,
      parentNotifications: 0,
    });
  });

  it('ACT III — a client that tries to send a SCORE instead of answers is rejected BY NAME', async () => {
    const cheated = await request(world.http)
      .post(`${P}/self/achievements/${achievementId}/submit`)
      .set(asChild(home))
      .send({ quizCorrect: 5, quizTotal: 5 });

    // 400 and the offending property NAMED — not a silent strip that would let
    // an old client believe it still worked while quietly scoring zero. And it
    // is refused at the edge, so it does not even consume one of the three
    // attempts the child is entitled to.
    expect(cheated.status).toBe(400);
    expect(cheated.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(cheated.body)).toContain('quizCorrect');

    await world.drainOutbox();
    expect(await countTheLoop(world, home)).toMatchObject({ ledger: 0 });
  });

  // =========================================================================
  // ACT IV — A RIGHT RUN PAYS, ONCE
  // =========================================================================

  it('ACT IV — the child answers correctly, the server grades it 100%, and pays exactly once', async () => {
    const quiz = await openTheQuiz();

    // TRY 3, the last one before this attempt would escalate to a parent.
    const submitted = await request(world.http)
      .post(`${P}/self/achievements/${achievementId}/submit`)
      .set(asChild(home))
      .send({ quizAnswers: rightAnswers(quiz.body.questions) });

    expect(submitted.status).toBe(201);
    expect(submitted.body.outcome.result).toBe('PASSED');
    expect(submitted.body.outcome.scorePercent).toBe(100);
    expect(submitted.body.status).toBe('VERIFIED');

    await world.drainOutbox();
    const counts = await countTheLoop(world, home);
    expect(counts.ledger).toBe(1);
    expect(counts.timeline).toBe(1);
    expect(counts.parentNotifications).toBe(1);

    const [entry] = await world.sys('read the ledger', () =>
      world.prisma.rewardsLedgerEntry.findMany({
        where: { familyId: home.familyId, childId: home.childId, type: 'EARN' },
      }),
    );
    expect(entry.amount).toBe(25);

    // The GRADE is a STORED FACT and not a number that lived only in a
    // response: the assignment row records what the server drew for this try
    // and what it scored, so «why did my child get 60%?» is answerable later.
    const assignments = await world.sys('read the assignments', () =>
      world.prisma.quizAssignment.findMany({
        where: { familyId: home.familyId, achievementId },
        orderBy: { attemptNo: 'asc' },
      }),
    );
    expect(assignments).toHaveLength(2);
    expect(assignments[0].correctCount).toBe(0);
    expect(assignments[1].correctCount).toBe(5);
    expect(assignments[1].totalCount).toBe(5);
    expect(assignments[1].gradedAt).not.toBeNull();
  });

  it('THE REPLAY — regrading the same passing attempt grants nothing further', async () => {
    const before = await countTheLoop(world, home);
    expect(before.ledger).toBe(1);

    jest.setSystemTime(goldenAt('12:07'));
    await world.sys('redeliver with the markers stripped', async () => {
      await world.prisma.consumedMessage.deleteMany({ where: { familyId: home.familyId } });
      await world.prisma.outboxMessage.updateMany({
        where: { familyId: home.familyId },
        data: { status: 'PENDING', lockedAt: null, lockedBy: null, nextAttemptAt: new Date(), attemptCount: 0 },
      });
    });
    const drained = await world.drainOutbox();
    expect(drained.published).toBeGreaterThan(0);

    expect(await countTheLoop(world, home)).toEqual(before);
  });
});
