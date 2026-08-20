/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-04 — SCREEN TIME AS A REWARD. THE ONE THAT CHANGES WHAT THE
 * DEVICE ACTUALLY DOES.
 * ============================================================================
 *
 * THE PRODUCT LOOP THIS PROTECTS. Every other reward in ABNY is a number a
 * child is pleased to see. This one is different in kind: granting it CHANGES
 * THE RULES THE PHONE ENFORCES for the rest of the day. It is the clearest
 * expression of the product's philosophy — Motivate ⟶ Reward, not Punish — and
 * it is also the single most abusable reward type in the system, because
 * "farm a chore program until the phone is unlimited" is the obvious attack and
 * a per-grant cap alone does not stop it.
 *
 *   the parent sets a daily allowance («ساعتان في اليوم»)
 *     -> the effective allowance the device should enforce is 120, bonus 0;
 *     -> the child completes a chore worth «٣٠ دقيقة إضافية»;
 *     -> the effective allowance becomes 150, bonus 30, and the extra minutes
 *        are a BOUNDED, EXPIRING, REVOCABLE row — not an edit to the parent's
 *        policy. A bonus that never expires is a permanent policy change made by
 *        a child;
 *     -> the SAME grant delivered again does NOT move the allowance a second
 *        time. The defence is `screen_time_reward_grants.ledger_entry_id UNIQUE`
 *        — a constraint, not a code check;
 *     -> and the parent can take the minutes back without touching the ledger,
 *        because revoking a bonus is not the same as un-earning a reward.
 *
 * WHY «DOES NOT MOVE IT TWICE» IS THE ASSERTION THAT MATTERS. The at-least-once
 * outbox WILL redeliver. If the redelivery added thirty more minutes, the
 * product would hand a child unlimited screen time in exchange for one chore and
 * a flaky network — and no parent would ever see why.
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

const BASE_DAILY_LIMIT_MINUTES = 120;
const BONUS_MINUTES = 30;

/** «رتّب غرفتك» — a chore, self-confirmed, paid in minutes. */
const THE_CHORE_GOAL = {
  category: 'HOUSEWORK',
  activity: 'CHORE',
  targetSpec: { quantity: 1, unit: 'مهمة' },
  durationMinutes: 10,
  verificationLevel: 'SELF_CHECK',
  rewardSpec: { type: 'SCREEN_TIME', amount: BONUS_MINUTES, expiresInHours: 24 },
  frequency: 'DAILY',
  maxPerDay: 1,
  maxPerWeek: 7,
};

describeGolden('GOLDEN E2E-04 — earned minutes really move the allowance, and a replay does not move it twice', () => {
  let world: GoldenWorld;
  let home: GoldenHousehold;
  let programId: string;
  let achievementId: string;

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('golden E2E-04 (screen time)');
    home = await world.register('e2e04');
    await ageTheHousehold(world, home, goldenAt('08:00'));
  }, 180_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  /** The number the child's device is supposed to enforce, read over HTTP. */
  async function effectiveAllowance(): Promise<{ effective: number | null; bonus: number }> {
    const res = await request(world.http)
      .get(`${P}/children/${home.childId}/screen-time-policy/effective`)
      .set(asParent(home));
    expect(res.status).toBe(200);
    return { effective: res.body.effectiveDailyLimitMinutes, bonus: res.body.bonusMinutes };
  }

  const activeGrants = (): Promise<any[]> =>
    world.sys('read the screen-time grants', () =>
      world.prisma.screenTimeRewardGrant.findMany({
        where: { familyId: home.familyId, childId: home.childId },
      }),
    );

  // =========================================================================
  // ACT I — THE PARENT SETS THE ALLOWANCE AND THE CHORE
  // =========================================================================

  it('ACT I — the parent sets «ساعتان في اليوم», and that is exactly what the device is told to enforce', async () => {
    const set = await request(world.http)
      .post(`${P}/children/${home.childId}/screen-time-policy`)
      .set(asParent(home))
      .send({ dailyLimitMinutes: BASE_DAILY_LIMIT_MINUTES, bedtimeStart: '21:00', bedtimeEnd: '07:00' });
    expect([200, 201]).toContain(set.status);

    expect(await effectiveAllowance()).toEqual({ effective: BASE_DAILY_LIMIT_MINUTES, bonus: 0 });
  });

  it('ACT I — the parent creates a chore worth «٣٠ دقيقة إضافية»', async () => {
    const created = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(home))
      .send({ childId: home.childId, ...THE_CHORE_GOAL });

    expect([200, 201]).toContain(created.status);
    programId = created.body.id;
    expect(created.body.rewardSpec).toMatchObject({ type: 'SCREEN_TIME', amount: BONUS_MINUTES });
  });

  it('ACT I — a chore promising ninety bonus minutes is refused at authoring time, before any child sees it', async () => {
    // `MAX_SCREEN_TIME_GRANT_MINUTES` is 60. Refusing this at authoring is what
    // keeps the parent's own form honest: a promise the server would silently
    // clamp later is a promise the child was told and did not get.
    const tooGenerous = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(home))
      .send({
        childId: home.childId,
        ...THE_CHORE_GOAL,
        rewardSpec: { type: 'SCREEN_TIME', amount: 90 },
      });

    expect(tooGenerous.status).toBe(400);
    expect(JSON.stringify(tooGenerous.body)).toContain('SCREEN_TIME');
  });

  // =========================================================================
  // ACT II — THE CHILD EARNS THE MINUTES, AND THE ALLOWANCE MOVES
  // =========================================================================

  it('ACT II — the child does the chore, and the allowance the device enforces becomes 150', async () => {
    const started = await request(world.http)
      .post(`${P}/self/achievements/start`)
      .set(asChild(home))
      .send({ programId });
    expect([200, 201]).toContain(started.status);
    achievementId = started.body.id;

    const submitted = await request(world.http)
      .post(`${P}/self/achievements/${achievementId}/submit`)
      .set(asChild(home))
      .send({ selfConfirmed: true });
    expect(submitted.body.outcome.result).toBe('PASSED');
    expect(submitted.body.status).toBe('VERIFIED');

    await world.drainOutbox();

    // THE PRODUCT-VISIBLE EFFECT: the number changed.
    expect(await effectiveAllowance()).toEqual({
      effective: BASE_DAILY_LIMIT_MINUTES + BONUS_MINUTES,
      bonus: BONUS_MINUTES,
    });

    // And the ledger recorded it as minutes, in the one append-only ledger, so
    // screen time is not a second economy hidden behind a different table.
    const [entry] = await world.sys('read the ledger', () =>
      world.prisma.rewardsLedgerEntry.findMany({
        where: { familyId: home.familyId, childId: home.childId, type: 'EARN' },
      }),
    );
    expect(entry.rewardType).toBe('SCREEN_TIME');
    expect(entry.amount).toBe(BONUS_MINUTES);
  });

  it('ACT II — the bonus is BOUNDED, EXPIRING and attached to the ledger row that caused it', async () => {
    const grants = await activeGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0].minutes).toBe(BONUS_MINUTES);
    expect(grants[0].achievementId).toBe(achievementId);
    // A bonus that never expires is a permanent policy change by another name.
    expect(grants[0].expiresAt).not.toBeNull();
    expect(new Date(grants[0].expiresAt).getTime()).toBeGreaterThan(GOLDEN_NOON.getTime());
    // The link back to the ledger IS the idempotency key for the side effect.
    expect(grants[0].ledgerEntryId).toBeTruthy();

    // The parent's OWN policy was not edited. The base limit is still 120, and
    // the bonus is added at read time — so tomorrow's allowance is the parent's
    // number again without anybody having to remember to undo anything.
    const policy = await request(world.http)
      .get(`${P}/children/${home.childId}/screen-time-policy`)
      .set(asParent(home));
    expect(policy.body.dailyLimitMinutes).toBe(BASE_DAILY_LIMIT_MINUTES);
  });

  it('ACT II — the loop closed exactly once: one ledger row, one timeline entry, one parent notification', async () => {
    expect(await countTheLoop(world, home)).toMatchObject({
      ledger: 1,
      timeline: 1,
      parentNotifications: 1,
    });
  });

  // =========================================================================
  // ACT III — THE REPLAY DOES NOT MOVE THE ALLOWANCE TWICE
  // =========================================================================

  it('THE REPLAY — the same grant delivered again leaves the allowance at 150, decided by a UNIQUE constraint', async () => {
    const before = await effectiveAllowance();
    expect(before).toEqual({ effective: 150, bonus: BONUS_MINUTES });

    // The markers are stripped and the clock moved past the fatigue window, so
    // the redelivery genuinely re-enters the payout path. What stops a second
    // block of minutes is `screen_time_reward_grants.ledger_entry_id UNIQUE`.
    jest.setSystemTime(goldenAt('12:06'));
    await world.sys('redeliver with the markers stripped', async () => {
      await world.prisma.consumedMessage.deleteMany({ where: { familyId: home.familyId } });
      await world.prisma.outboxMessage.updateMany({
        where: { familyId: home.familyId },
        data: { status: 'PENDING', lockedAt: null, lockedBy: null, nextAttemptAt: new Date(), attemptCount: 0 },
      });
    });
    const drained = await world.drainOutbox();
    expect(drained.published).toBeGreaterThan(0);

    expect(await effectiveAllowance()).toEqual(before);
    expect(await activeGrants()).toHaveLength(1);
    expect(await countTheLoop(world, home)).toMatchObject({ ledger: 1, parentNotifications: 1 });
  });

  it("ACT III — the child cannot repeat the chore today, and is told so as an invitation rather than a refusal", async () => {
    const again = await request(world.http)
      .post(`${P}/self/achievements/start`)
      .set(asChild(home))
      .send({ programId });

    expect(again.status).toBe(409);
    expect(again.body.code).toBe('MAX_PER_DAY_REACHED');
    expect(await effectiveAllowance()).toEqual({ effective: 150, bonus: BONUS_MINUTES });
  });

  // =========================================================================
  // ACT IV — THE PARENT CAN TAKE THE MINUTES BACK, WITHOUT UN-EARNING ANYTHING
  // =========================================================================

  it('ACT IV — revoking the bonus returns the allowance to 120 and leaves the reward the child earned alone', async () => {
    const [grant] = await activeGrants();

    const revoked = await request(world.http)
      .delete(`${P}/reward-programs/screen-time-grants/${grant.id}`)
      .set(asParent(home));
    expect([200, 201, 204]).toContain(revoked.status);

    expect(await effectiveAllowance()).toEqual({ effective: BASE_DAILY_LIMIT_MINUTES, bonus: 0 });

    // AND THE LEDGER IS UNTOUCHED. Q17's rule, and CONTEXT §3 principle 7:
    // taking back today's minutes is a parenting decision; withdrawing a
    // child's earned reward is a punishment, and these are not the same action.
    expect(await countTheLoop(world, home)).toMatchObject({ ledger: 1, timeline: 1 });
  });
});
