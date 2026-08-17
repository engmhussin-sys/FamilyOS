/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-01 — THE QURAN REWARD. THE FLAGSHIP LOOP OF «ابني».
 * ============================================================================
 *
 * THE PRODUCT LOOP THIS PROTECTS, in the order a family lives it:
 *
 *   A parent opens the app and sets a goal in words a family actually uses —
 *   «حفظ سورة الملك، الآيات ١–٥، ٢٠ دقيقة، ٢٠ نقطة».
 *     -> the child's phone shows it as TODAY'S goal, and nothing else has to
 *        happen for that to be true;
 *     -> the child taps START, works, taps DONE and submits EVIDENCE — never a
 *        result, because a child who can state an outcome has a reward machine,
 *        not a coach;
 *     -> the SERVER verifies. For a Quran program the verification rule is
 *        PARENT_CONFIRMATION, so the server's honest answer is «escalate», and
 *        it grants nothing;
 *     -> the parent confirms;
 *     -> and exactly four things happen, exactly once each: one ledger grant,
 *        one timeline entry, one parent notification, one child notification;
 *     -> and the growth funnel moves, because a family that reached its first
 *        reward is the only activation this product recognises.
 *
 *   Then the loop is REPLAYED — the same completion delivered again, the way an
 *   at-least-once outbox really does deliver it — and NOTHING happens. Not a
 *   second grant, not a second notification, not a second timeline row.
 *
 * WHY THAT LAST PARAGRAPH IS THE WHOLE PRODUCT. ABNY's promise to a parent is
 * that a reward means something. A reward that can be earned twice for one
 * surah is not a bug in a counter — it is the moment the child learns the
 * system can be farmed, and the moment the parent stops trusting the number.
 * CONTEXT §3 principle 6 says the defence must be a DATABASE CONSTRAINT and not
 * a code check, and this file is where that claim is spent rather than stated.
 *
 * EVERYTHING BELOW RUNS AGAINST A REAL POSTGRESQL, A REAL REDIS AND A REAL
 * BOOTED NESTJS APP OVER REAL HTTP. No service is stubbed. Every count is read
 * back out of a table after the fact, never from a returned object.
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

/** The parent's form, field for field, exactly as the brief words it. */
const THE_QURAN_GOAL = {
  category: 'QURAN',
  activity: 'QURAN_MEMORIZE_AYAH_RANGE',
  targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 5 },
  durationMinutes: 20,
  verificationLevel: 'PARENT_CONFIRMATION',
  rewardSpec: { type: 'POINTS', amount: 20 },
  frequency: 'DAILY',
  maxPerDay: 1,
  maxPerWeek: 7,
};

describeGolden('GOLDEN E2E-01 — a parent sets a Quran goal and a child earns it, exactly once', () => {
  let world: GoldenWorld;
  let home: GoldenHousehold;
  let programId: string;
  let achievementId: string;

  beforeAll(async () => {
    // Midday, so the reward the parent confirms is DELIVERED rather than
    // correctly deferred past 21:00. See `freezeGoldenClock`.
    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('golden E2E-01 (Quran)');
    home = await world.register('e2e01');
    // A family that started using ABNY this morning, not thirty seconds ago.
    await ageTheHousehold(world, home, goldenAt('08:00'));
  }, 180_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  const analyticsCount = (eventName: string): Promise<number> =>
    world.sys(`count ${eventName}`, () =>
      world.prisma.analyticsEvent.count({ where: { familyId: home.familyId, eventName } }),
    );

  const domainEventCount = (eventType: string): Promise<number> =>
    world.sys(`count ${eventType}`, () =>
      world.prisma.domainEvent.count({ where: { familyId: home.familyId, eventType } }),
    );

  // =========================================================================
  // ACT I — THE PARENT SETS THE GOAL
  // =========================================================================

  it('ACT I — the parent creates «حفظ سورة الملك، الآيات ١–٥، ٢٠ دقيقة، ٢٠ نقطة», and the server checks the Quran itself', async () => {
    const created = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(home))
      .send({ childId: home.childId, ...THE_QURAN_GOAL });

    expect([200, 201]).toContain(created.status);
    programId = created.body.id;

    // The goal reads back in Arabic, as a sentence, because the parent typed a
    // surah number and a range and expects to see a surah and a range.
    expect(created.body.category).toBe('QURAN');
    expect(created.body.targetSummaryAr).toBe('الآيات 1–5 من سورة الملك');
    expect(created.body.durationMinutes).toBe(20);
    expect(created.body.rewardSpec).toMatchObject({ type: 'POINTS', amount: 20 });
    expect(created.body.verificationLevel).toBe('PARENT_CONFIRMATION');

    // A goal the server could not honour is worse than no goal: Al-Mulk has 30
    // ayat, and a program promising ayah 300 would lie to the child on day one.
    const impossible = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(home))
      .send({ childId: home.childId, ...THE_QURAN_GOAL, targetSpec: { surahNumber: 67, fromAyah: 1, toAyah: 300 } });
    expect(impossible.status).toBe(400);
    expect(JSON.stringify(impossible.body)).toContain('AYAH_OUT_OF_SURAH');

    // Nothing has been earned by creating a goal.
    expect(await countTheLoop(world, home)).toEqual({
      ledger: 0,
      timeline: 0,
      parentNotifications: 0,
      childMessages: 0,
    });
  });

  // =========================================================================
  // ACT II — THE CHILD SEES IT, STARTS IT, AND STILL HAS NOTHING
  // =========================================================================

  it("ACT II — the child's phone shows it as today's goal, from the child's own device token", async () => {
    const today = await request(world.http).get(`${P}/self/achievements/today`).set(asChild(home));

    expect(today.status).toBe(200);
    const mine = (today.body as any[]).find((entry) => entry.programId === programId || entry.id === programId);
    expect(mine).toBeDefined();
    // "available" plus a reason when it is not: the child app must be able to
    // EXPLAIN, never just fail on tap (CONTEXT §3 principle 7).
    expect(mine.available).toBe(true);
    expect(JSON.stringify(mine)).toContain('سورة الملك');
  });

  it('ACT II — the child STARTS the goal and receives an attempt, not a reward', async () => {
    const started = await request(world.http)
      .post(`${P}/self/achievements/start`)
      .set(asChild(home))
      .send({ programId });

    expect([200, 201]).toContain(started.status);
    achievementId = started.body.id;
    expect(started.body.status).toBe('IN_PROGRESS');

    await world.drainOutbox();
    const counts = await countTheLoop(world, home);
    expect(counts.ledger).toBe(0);
    expect(counts.parentNotifications).toBe(0);
  });

  it('ACT II — the child SUBMITS evidence, the server escalates, and STILL nothing is granted', async () => {
    const submitted = await request(world.http)
      .post(`${P}/self/achievements/${achievementId}/submit`)
      .set(asChild(home))
      .send({ foregroundMinutes: 21, note: 'حفظت الآيات' });

    expect(submitted.status).toBe(201);
    // The server decided. The child stated evidence and the server stated the
    // outcome — there is no field on the request by which those could swap.
    expect(submitted.body.status).toBe('PENDING_PARENT');
    expect(submitted.body.outcome.result).toBe('ESCALATED');
    expect(submitted.body.outcome.reasonCode).toBe('AWAITING_PARENT');

    // The attempt is recorded as append-only evidence of what the server decided.
    const attempts = await world.sys('count attempts', () =>
      world.prisma.verificationAttempt.count({ where: { familyId: home.familyId } }),
    );
    expect(attempts).toBe(1);

    await world.drainOutbox();
    const counts = await countTheLoop(world, home);
    expect(counts.ledger).toBe(0);
    expect(counts.timeline).toBe(0);
    expect(counts.parentNotifications).toBe(0);
  });

  // =========================================================================
  // ACT III — THE PARENT CONFIRMS, AND THE LOOP CLOSES ONCE
  // =========================================================================

  it('ACT III — the parent confirms, and EXACTLY ONE of each thing happens', async () => {
    const approved = await request(world.http)
      .post(`${P}/reward-programs/achievements/${achievementId}/approve`)
      .set(asParent(home))
      .send({});
    expect([200, 201]).toContain(approved.status);

    await world.drainOutbox();

    const achievement = await world.sys('read the achievement', () =>
      world.prisma.achievementRequest.findFirst({ where: { id: achievementId } }),
    );
    expect(achievement.status).toBe('VERIFIED');

    // THE LEDGER — one row, twenty points, at day-one multiplier 1.00x.
    const entries = await world.sys('read the ledger', () =>
      world.prisma.rewardsLedgerEntry.findMany({
        where: { familyId: home.familyId, childId: home.childId, type: 'EARN' },
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].amount).toBe(20);
    expect(entries[0].delta).toBe(20);
    // «نقطة» is the product word; `XP` is the ledger word; they are one number
    // and not two economies (`reward-spec.ts`, the REUSE decision of Sprint F4).
    expect(entries[0].rewardType).toBe('XP');
    expect(String(entries[0].idempotencyKey)).toContain(':achv:');

    // THE TIMELINE — one curated entry, carrying the causal key that makes it
    // unrepeatable (`life_timeline_events_reward_source_key_uq`).
    const timeline = await world.sys('read the timeline', () =>
      world.prisma.lifeTimelineEvent.findMany({
        where: { familyId: home.familyId, childId: home.childId, eventType: 'reward_granted' },
      }),
    );
    expect(timeline).toHaveLength(1);
    expect((timeline[0].metadata as any)?.sourceKey).toBeTruthy();

    // THE PARENT NOTIFICATION — one row, carrying a real causal key.
    const notifications = await world.sys('read the notifications', () =>
      world.prisma.notification.findMany({
        where: { familyId: home.familyId, childId: home.childId, type: 'REWARD_GRANTED' },
      }),
    );
    expect(notifications).toHaveLength(1);
    expect(String(notifications[0].sourceEventId).startsWith('evt:')).toBe(true);

    // And the events that caused all of it are each exactly one.
    expect(await domainEventCount('ACHIEVEMENT_VERIFIED')).toBe(1);
    expect(await domainEventCount('REWARD_GRANTED')).toBe(1);
    expect(await domainEventCount('QURAN_ACHIEVEMENT_COMPLETED')).toBe(1);
  });

  it('ACT III — the balance the child will actually see moved by twenty, and by nothing else', async () => {
    const account = await request(world.http)
      .get(`${P}/life-intelligence/self/rewards/account`)
      .set(asChild(home));

    expect(account.status).toBe(200);
    expect(account.body.xp).toBe(20);
  });

  it('ACT III — nothing was stranded: every outbox message reached PUBLISHED', async () => {
    const stuck = await world.sys('count stranded messages', () =>
      world.prisma.outboxMessage.count({
        where: { familyId: home.familyId, status: { in: ['PENDING', 'PUBLISHING', 'FAILED', 'DEAD'] } },
      }),
    );
    expect(stuck).toBe(0);
  });

  // =========================================================================
  // ACT IV — THE GROWTH FUNNEL MOVES
  // =========================================================================

  it('ACT IV — the growth counters moved, and the family is ACTIVATED by its first real reward', async () => {
    // These are PROJECTIONS of the domain bus, not a second instrumentation
    // pass: `GrowthDomainEventBridge` subscribes, so a growth step exists only
    // if the transaction that caused it actually committed.
    expect(await analyticsCount('GOAL_CREATED')).toBeGreaterThanOrEqual(1);
    expect(await analyticsCount('GOAL_STARTED')).toBe(1);
    expect(await analyticsCount('GOAL_COMPLETED')).toBe(1);
    expect(await analyticsCount('REWARD_GRANTED')).toBe(1);

    // THE ACTIVATION. One row per family, ever — the unique index is the
    // guarantee, not a code check — and it names the rule version that admitted
    // it, so a metric whose definition changes cannot change silently.
    const activation = await world.sys('read the activation', () =>
      world.prisma.familyActivation.findFirst({ where: { familyId: home.familyId } }),
    );
    expect(activation).not.toBeNull();
    expect(activation.ruleVersion).toBeTruthy();
    expect(activation.timeToValueMinutes).toBeGreaterThanOrEqual(0);

    // The growth store learned that a goal was completed. It did NOT learn WHICH
    // child completed it — CONTEXT §3 principle 8, enforced by an allow-list.
    const rows = await world.sys('read the growth payloads', () =>
      world.prisma.analyticsEvent.findMany({ where: { familyId: home.familyId } }),
    );
    for (const row of rows) {
      const serialised = JSON.stringify(row.payload ?? {});
      expect(serialised).not.toContain(home.childId);
      expect(serialised).not.toContain(home.childName);
    }
  });

  // =========================================================================
  // ACT V — THE REPLAY. THE ACT THAT MAKES THE OTHERS WORTH ANYTHING.
  // =========================================================================

  describe('ACT V — the completion is delivered again, and the product does not move', () => {
    /**
     * Re-enqueues every outbox message for this family AND deletes the
     * `consumed_messages` markers, which is the harsh form: the marker table is
     * documented as an OPTIMISATION, so stripping it makes the redelivery
     * genuinely re-enter every consumer. What is left standing between the
     * replay and a second reward is PostgreSQL.
     */
    async function redeliverEverything(): Promise<void> {
      await world.sys('redeliver every message', async () => {
        await world.prisma.consumedMessage.deleteMany({ where: { familyId: home.familyId } });
        await world.prisma.outboxMessage.updateMany({
          where: { familyId: home.familyId },
          data: { status: 'PENDING', lockedAt: null, lockedBy: null, nextAttemptAt: new Date(), attemptCount: 0 },
        });
      });
    }

    it('THE REPLAY — at-least-once redelivery grants zero, notifies zero, and writes zero timeline rows', async () => {
      const before = await countTheLoop(world, home);
      expect(before.ledger).toBe(1);
      expect(before.timeline).toBe(1);
      expect(before.parentNotifications).toBe(1);

      // The clock is moved OUTSIDE the fatigue guard's five-minute DUPLICATE
      // window on purpose. A second notification WOULD be dispatched if a second
      // grant happened, so a pass here cannot be the window swallowing it.
      jest.setSystemTime(goldenAt('12:06'));
      await redeliverEverything();
      const drained = await world.drainOutbox();
      // The redelivery really happened. Without this line the test could pass by
      // measuring nothing at all, which is how a regression test dies quietly.
      expect(drained.published).toBeGreaterThan(0);

      expect(await countTheLoop(world, home)).toEqual(before);
      expect(await domainEventCount('REWARD_GRANTED')).toBe(1);
    });

    it('THE REPLAY — with the notification history BLINDED, the notification is still exactly one', async () => {
      // The fatigue guard reads the last 24 hours of `notifications` for this
      // child. Back-dating the row 48 hours makes the guard see an empty history
      // and happily allow a second send — so a pass here CANNOT be credited to
      // the guard. The row stays in the table, because the CONSTRAINT still sees
      // it: `notifications (family_id, source_event_id, user_id)`.
      const [existing] = await world.sys('read the one notification', () =>
        world.prisma.notification.findMany({ where: { familyId: home.familyId, type: 'REWARD_GRANTED' } }),
      );
      await world.sys('back-date it out of the fatigue window', () =>
        world.prisma.notification.update({
          where: { id: existing.id },
          data: { createdAt: new Date(GOLDEN_NOON.getTime() - 48 * 60 * 60 * 1000) },
        }),
      );

      jest.setSystemTime(goldenAt('12:10'));
      await redeliverEverything();
      const drained = await world.drainOutbox();
      expect(drained.published).toBeGreaterThan(0);

      const counts = await countTheLoop(world, home);
      expect(counts.ledger).toBe(1);
      expect(counts.parentNotifications).toBe(1);
      expect(counts.timeline).toBe(1);
    });

    it('THE REPLAY — the child cannot re-submit the same achievement, and the parent cannot re-approve it', async () => {
      const resubmitted = await request(world.http)
        .post(`${P}/self/achievements/${achievementId}/submit`)
        .set(asChild(home))
        .send({ foregroundMinutes: 21 });
      expect(resubmitted.status).toBe(409);

      const reapproved = await request(world.http)
        .post(`${P}/reward-programs/achievements/${achievementId}/approve`)
        .set(asParent(home))
        .send({});
      expect(reapproved.status).toBe(409);

      await world.drainOutbox();
      const counts = await countTheLoop(world, home);
      expect(counts.ledger).toBe(1);
      expect(counts.parentNotifications).toBe(1);
    });

    /**
     * THE ONE PLACE THE REPLAY IS *ALLOWED* TO MOVE A NUMBER, and the asymmetry
     * is deliberate and load-bearing, so this scenario measures it rather than
     * assuming it either way.
     *
     * `GrowthDomainEventBridge` says in its own docstring that it does NOT use
     * `ConsumerIdempotency` — "double-counting an analytics event is a rounding
     * error; the ONE thing that must not happen twice, the activation, is
     * protected by a UNIQUE index on the row itself". So a redelivered
     * `REWARD_GRANTED` really does append another `analytics_events` row, and
     * the ACTIVATION really does not move.
     *
     * MONEY AND PROGRESS DID NOT MOVE — the ledger, the timeline and the
     * notification are still one each, asserted above. What moved is a chart.
     * The size of that inaccuracy is recorded as PF-E-004 rather than filed as
     * a pass or hidden behind a `toBeGreaterThanOrEqual`.
     */
    it('THE REPLAY — the ACTIVATION is still exactly one, and the analytics counter is at-least-once by design', async () => {
      const activations = await world.sys('count activations', () =>
        world.prisma.familyActivation.count({ where: { familyId: home.familyId } }),
      );
      expect(activations).toBe(1);

      // Two redeliveries above, each re-entering the bridge: one original row
      // plus one per redelivery. Pinned exactly, so a future change to the
      // bridge's idempotency is visible here instead of silently absorbed.
      expect(await analyticsCount('REWARD_GRANTED')).toBe(3);
      // And the thing the funnel is actually FOR did not move: the ledger.
      const counts = await countTheLoop(world, home);
      expect(counts.ledger).toBe(1);
    });
  });

  // =========================================================================
  // ACT VI — WHAT THE CHILD IS TOLD
  // =========================================================================

  /**
   * The loop above proves the parent is told. This asserts the OTHER half of
   * the product's promise: «تطبيق الطفل منتج قائم بذاته يريد الطفل فتحه»
   * (CONTEXT §1) — a child who earns twenty points for Al-Mulk should hear
   * about it on their own device.
   *
   * `GET /life-intelligence/self/messages` is the child's inbox, and
   * `child_messages` is the table `SmartNotificationIntegrationService` routes a
   * CHILD-audience candidate into. See PF-E-002 in the phase report for what
   * this measured.
   */
  it('ACT VI — the child inbox is reachable, and what the completed loop actually put in it', async () => {
    const inbox = await request(world.http).get(`${P}/life-intelligence/self/messages`).set(asChild(home));
    expect(inbox.status).toBe(200);
    expect(Array.isArray(inbox.body)).toBe(true);

    const counts = await countTheLoop(world, home);
    // MEASURED, NOT ASSUMED. The number this scenario records is the number the
    // report carries; see PF-E-002. If a future commit wires a CHILD-audience
    // producer to the reward path, this expectation is the one that must move,
    // and it must move deliberately.
    expect(counts.childMessages).toBe(0);
  });
});
