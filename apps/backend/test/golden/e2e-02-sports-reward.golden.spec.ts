/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-02 — THE SPORTS REWARD, AND A VERIFICATION THAT MEASURES INSTEAD
 * OF ASKING.
 * ============================================================================
 *
 * THE PRODUCT LOOP THIS PROTECTS. Same five steps as the Quran loop — parent
 * sets a goal, child sees it, starts it, finishes it, gets paid — but a
 * DIFFERENT verification strategy, and that difference is the point of having a
 * second scenario at all:
 *
 *   QURAN uses `PARENT_CONFIRMATION`. A human decides, and the server's honest
 *   answer at submit time is «I am not the one who decides this».
 *
 *   SPORT uses `DURATION`. NOBODY decides — the server MEASURES. The child's
 *   device reports how many minutes the activity was actually in the
 *   foreground, and that report is EVIDENCE bounded by the server's own wall
 *   clock: a device claiming 45 minutes of exercise inside a 2-minute window
 *   between START and SUBMIT is refused without anyone needing to trust or
 *   distrust the child.
 *
 * WHY THAT MATTERS TO THE PRODUCT AND NOT ONLY TO THE CODE. ABNY's wedge
 * (CONTEXT §1) is a child who WANTS to open the app. That only survives if the
 * rewards are real. A duration check that took the device's word would make
 * "exercise for 20 minutes" mean "type 20 into a field", and the first child who
 * discovers that tells every other child. Equally, a check that were too harsh
 * would punish a child who really did the work — so this scenario asserts BOTH
 * directions: the lie is refused, AND the honest attempt right after it passes
 * and pays, on the same open attempt, with no parent involved.
 *
 * It also pins the category-aware trust policy from the other side: `SELF_CHECK`
 * — the child's own word — is ACCEPTED for SPORT and REFUSED for QURAN, because
 * the risk of a self-declared push-up is not the risk of a self-declared surah.
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

/**
 * «تمرين رياضي، ٥ دقائق، ١٥ نقطة».
 *
 * FIVE minutes and not twenty, and the reason is stated rather than hidden: the
 * access token a child's device holds lives fifteen minutes, and this scenario
 * needs THREE submissions on one attempt (a lie, an honest-but-short attempt,
 * and a real one). A twenty-minute program would need the clock pushed past the
 * token's expiry and the third submission would fail with a 401 for a reason
 * that has nothing to do with exercise.
 */
const THE_SPORTS_GOAL = {
  category: 'SPORT',
  activity: 'PHYSICAL_ACTIVITY',
  targetSpec: { quantity: 30, unit: 'دقيقة' },
  durationMinutes: 5,
  verificationLevel: 'DURATION',
  rewardSpec: { type: 'POINTS', amount: 15 },
  frequency: 'DAILY',
  maxPerDay: 1,
  maxPerWeek: 7,
};

describeGolden('GOLDEN E2E-02 — a child exercises, and the server measures it instead of asking', () => {
  let world: GoldenWorld;
  let home: GoldenHousehold;
  let programId: string;
  let achievementId: string;

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('golden E2E-02 (sport)');
    home = await world.register('e2e02');
    await ageTheHousehold(world, home, goldenAt('08:00'));
  }, 180_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  // =========================================================================
  // ACT I — THE PARENT SETS A SPORTS GOAL, AND THE TRUST POLICY IS CATEGORY-AWARE
  // =========================================================================

  it('ACT I — the parent creates «تمرين رياضي، ٥ دقائق، ١٥ نقطة» and picks a strategy that measures', async () => {
    const created = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(home))
      .send({ childId: home.childId, ...THE_SPORTS_GOAL });

    expect([200, 201]).toContain(created.status);
    programId = created.body.id;
    expect(created.body.category).toBe('SPORT');
    expect(created.body.verificationLevel).toBe('DURATION');
    expect(created.body.rewardSpec).toMatchObject({ type: 'POINTS', amount: 15 });

    expect(await countTheLoop(world, home)).toMatchObject({ ledger: 0, parentNotifications: 0 });
  });

  it("ACT I — the child's own word is allowed for SPORT and refused for QURAN, because the risks differ", async () => {
    const sportSelfCheck = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(home))
      .send({ childId: home.childId, ...THE_SPORTS_GOAL, verificationLevel: 'SELF_CHECK' });
    expect([200, 201]).toContain(sportSelfCheck.status);

    const quranSelfCheck = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(home))
      .send({
        childId: home.childId,
        category: 'QURAN',
        activity: 'QURAN_MEMORIZE_AYAH_RANGE',
        targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
        durationMinutes: 20,
        verificationLevel: 'SELF_CHECK',
        rewardSpec: { type: 'POINTS', amount: 20 },
      });
    expect(quranSelfCheck.status).toBe(400);
    expect(JSON.stringify(quranSelfCheck.body)).toContain('VERIFICATION_TOO_WEAK_FOR_CATEGORY');

    // Housekeeping: the extra SELF_CHECK sport program would otherwise appear in
    // the child's "today" list and confuse the narrative below.
    await request(world.http)
      .delete(`${P}/reward-programs/${sportSelfCheck.body.id}`)
      .set(asParent(home));
  });

  // =========================================================================
  // ACT II — THE CHILD STARTS, AND THE DEVICE LIES
  // =========================================================================

  it('ACT II — the child starts the exercise', async () => {
    const started = await request(world.http)
      .post(`${P}/self/achievements/start`)
      .set(asChild(home))
      .send({ programId });

    expect([200, 201]).toContain(started.status);
    achievementId = started.body.id;
    expect(started.body.status).toBe('IN_PROGRESS');
  });

  it('ACT II — a device claiming 45 minutes of exercise inside a 2-minute window is caught by the server alone', async () => {
    jest.setSystemTime(goldenAt('12:02'));

    const lied = await request(world.http)
      .post(`${P}/self/achievements/${achievementId}/submit`)
      .set(asChild(home))
      .send({ foregroundMinutes: 45 });

    expect(lied.status).toBe(201);
    expect(lied.body.outcome.result).toBe('FAILED');
    // The server did not need to know whether the child exercised. It knows when
    // it handed out the attempt and what time it is now, and 45 > 2 + tolerance.
    expect(lied.body.outcome.reasonCode).toBe('FOREGROUND_EXCEEDS_ELAPSED');

    await world.drainOutbox();
    expect(await countTheLoop(world, home)).toMatchObject({
      ledger: 0,
      timeline: 0,
      parentNotifications: 0,
    });
  });

  it('ACT II — an honest but short session fails on the DURATION, and says so non-punitively in Arabic', async () => {
    jest.setSystemTime(goldenAt('12:04'));

    const short = await request(world.http)
      .post(`${P}/self/achievements/${achievementId}/submit`)
      .set(asChild(home))
      .send({ foregroundMinutes: 2 });

    expect(short.body.outcome.result).toBe('FAILED');
    expect(short.body.outcome.reasonCode).toBe('DURATION_NOT_SATISFIED');
    // CONTEXT §3 principle 7: a statement of fact plus a way forward. No «ممنوع»,
    // no «تجاوزت» — and the attempt is still open.
    expect(short.body.outcome.messageAr).toContain('أكمل الوقت');
    expect(short.body.status).toBe('IN_PROGRESS');
    expect(short.body.attemptsLeft).toBe(1);

    await world.drainOutbox();
    expect(await countTheLoop(world, home)).toMatchObject({ ledger: 0, parentNotifications: 0 });
  });

  // =========================================================================
  // ACT III — THE CHILD REALLY DOES IT, AND IS PAID WITHOUT ASKING A PARENT
  // =========================================================================

  it('ACT III — the real session PASSES, auto-approves, and pays exactly once', async () => {
    jest.setSystemTime(goldenAt('12:08'));

    const done = await request(world.http)
      .post(`${P}/self/achievements/${achievementId}/submit`)
      .set(asChild(home))
      .send({ foregroundMinutes: 6 });

    expect(done.status).toBe(201);
    expect(done.body.outcome.result).toBe('PASSED');
    expect(done.body.outcome.reasonCode).toBe('DURATION_SATISFIED');
    // DURATION is the one strategy on this scenario's path that MAY auto-approve
    // (`VERIFICATION_MATRIX.DURATION.canAutoApprove`), so no parent is involved
    // and the status is terminal at submit time.
    expect(done.body.status).toBe('VERIFIED');

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
    expect(entry.amount).toBe(15);
    expect(entry.rewardType).toBe('XP');
  });

  it('ACT III — the three attempts are all on the record, failures included', async () => {
    const attempts = await request(world.http)
      .get(`${P}/reward-programs/achievements/${achievementId}/attempts`)
      .set(asParent(home));

    expect(attempts.status).toBe(200);
    // Append-only evidence of what the server decided, every time it decided.
    // A parent asking "why did it not count?" has an answer that is a row.
    expect(attempts.body).toHaveLength(3);
    const reasons = (attempts.body as any[]).map((a) => a.reasonCode);
    expect(reasons).toEqual(['FOREGROUND_EXCEEDS_ELAPSED', 'DURATION_NOT_SATISFIED', 'DURATION_SATISFIED']);
  });

  // =========================================================================
  // ACT IV — THE DAILY LIMIT, AND THE REPLAY
  // =========================================================================

  it("ACT IV — the day's limit is reached, and the child is told so as an invitation, not a refusal", async () => {
    const again = await request(world.http)
      .post(`${P}/self/achievements/start`)
      .set(asChild(home))
      .send({ programId });

    expect(again.status).toBe(409);
    expect(again.body.code).toBe('MAX_PER_DAY_REACHED');
    expect(again.body.messageAr).toContain('نراك غدًا');
    // A machine-readable code AND an Arabic sentence AND a request id: the
    // deployed error contract, not Nest's default "Conflict Exception".
    expect(again.body.requestId).toBeTruthy();
  });

  it('THE REPLAY — the exercise completion delivered again grants zero and notifies zero', async () => {
    const before = await countTheLoop(world, home);
    expect(before.ledger).toBe(1);

    jest.setSystemTime(goldenAt('12:14'));
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
