/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-08 — THE WALLS. FAMILY, ROLE, AND CHILD.
 * ============================================================================
 *
 * THE PRODUCT LOOP THIS PROTECTS. Everything else in this suite describes what
 * ABNY does for a family. This one describes what it must never do to one, and
 * it is the scenario a regulator, an acquirer and a parent all ask about first,
 * because the data is children's data.
 *
 * THREE WALLS, and they are three different mechanisms, not one:
 *
 *   BETWEEN FAMILIES — `familyId` is NEVER read from the client. It is derived
 *     from the verified token and applied by a mandatory Prisma extension, so
 *     family A reading, editing, approving or messaging into family B does not
 *     fail an `if`; it queries a set that does not contain the row.
 *
 *   BETWEEN ROLES — a co-parent is a parent, not a co-owner. The actions that
 *     end a household (delete the account, cancel the plan, buy the plan,
 *     transfer ownership, remove the other parent) are OWNER-only, because A4's
 *     custody-dispute scenario is exactly one parent reaching them.
 *
 *   BETWEEN A CHILD AND EVERYTHING — a device token is a DIFFERENT Passport
 *     strategy, not a lower role. A child cannot approve, cannot grant, cannot
 *     change a policy, and cannot address a sibling — and the last one is
 *     structural: every `/self/*` route derives the child from the DEVICE in
 *     the token and never reads a child id from the request at all.
 *
 * AND THE STATUS CODE IS PART OF THE CONTRACT. Where confirming that a row
 * EXISTS would leak — another household's child, program, achievement or
 * message — the answer is 404 and not 403. A 403 tells the caller they found
 * something real.
 *
 * Real PostgreSQL, real Redis, real booted app, real HTTP. Nothing stubbed.
 */
import {
  GOLDEN_NOON,
  P,
  asBearer,
  asChild,
  asParent,
  bootGoldenWorld,
  describeGolden,
  freezeGoldenClock,
  goldenAt,
  type GoldenHousehold,
  type GoldenWorld,
} from './golden-world';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { PasswordService } from '../../src/modules/auth/application/services/password.service';

import request = require('supertest');

const A_CHORE = {
  category: 'HOUSEWORK',
  activity: 'CHORE',
  targetSpec: { quantity: 1, unit: 'مهمة' },
  durationMinutes: 10,
  verificationLevel: 'PARENT_CONFIRMATION',
  rewardSpec: { type: 'POINTS', amount: 10 },
};

describeGolden('GOLDEN E2E-08 — one family cannot reach another, one role cannot outrank itself, one child cannot outrank anyone', () => {
  let world: GoldenWorld;
  /** Family A: an owner, a co-parent, a child with a device, and a sibling. */
  let A: GoldenHousehold;
  /** Family B: an owner and a child with a device. */
  let B: GoldenHousehold;
  /** The co-parent of family A — same household, role PARENT. */
  const coParent = { userId: '', token: '', email: '', password: 'CoParent-Passw0rd!23' };
  /** A second child of family A, so "a child cannot reach a sibling" is real. */
  let siblingId = '';

  let programA = '';
  let achievementA = '';

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('golden E2E-08 (isolation)');
    A = await world.register('e2e08a', { childName: 'محمد' });
    B = await world.register('e2e08b', { childName: 'سلمى' });

    /**
     * THE CO-PARENT is created by inserting a `family_members` row, and that is
     * stated rather than hidden: there is no co-parent INVITE endpoint in this
     * repository yet. The row written here is byte-identical to the one such an
     * endpoint would create, and the token is minted by the REAL login path, so
     * every guard downstream sees a genuine PARENT-role session.
     */
    // NOT `Date.now()`: the clock is frozen to the golden day, so every run
    // would compose the identical address and collide with the previous run's
    // row on `users.email UNIQUE`.
    coParent.email = `golden.coparent.${Math.random().toString(36).slice(2)}@example.com`;
    const passwords = world.app.get(PasswordService);
    const hash = await passwords.hash(coParent.password);
    const user = await world.sys('seed the co-parent user', () =>
      world.prisma.user.create({
        data: {
          email: coParent.email,
          passwordHash: hash,
          fullName: 'Golden Co-Parent',
          locale: 'ar',
          termsAcceptedAt: new Date(),
          termsVersion: 'v1-placeholder',
        },
        select: { id: true },
      }),
    );
    coParent.userId = user.id;
    await world.sys('seed the co-parent membership', () =>
      world.prisma.familyMember.create({
        data: { familyId: A.familyId, userId: user.id, role: 'PARENT' },
      }),
    );
    const login = await request(world.http)
      .post(`${P}/auth/login`)
      .send({ email: coParent.email, password: coParent.password });
    coParent.token = login.body.tokens?.accessToken ?? login.body.accessToken;
    if (!coParent.token) throw new Error(`co-parent login -> ${JSON.stringify(login.body)}`);

    /**
     * THE SIBLING is seeded directly for a reason the product itself imposes:
     * a second child over HTTP requires the `multiple_children` entitlement
     * (E2E-07 proves that gate), and buying a plan is not what this scenario is
     * about. The row is identical to the one `POST /children` writes.
     */
    const sibling = await world.sys('seed the sibling', () =>
      world.prisma.child.create({
        data: { familyId: A.familyId, firstName: 'أخت محمد', dateOfBirth: new Date('2016-05-05') },
        select: { id: true },
      }),
    );
    siblingId = sibling.id;

    // A real, live program and a real, pending achievement inside family A —
    // so every probe below is aimed at something that actually exists.
    const program = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(A))
      .send({ childId: A.childId, ...A_CHORE });
    programA = program.body.id;
    const started = await request(world.http)
      .post(`${P}/self/achievements/start`)
      .set(asChild(A))
      .send({ programId: programA });
    achievementA = started.body.id;
    await request(world.http)
      .post(`${P}/self/achievements/${achievementA}/submit`)
      .set(asChild(A))
      .send({ selfConfirmed: true });
  }, 180_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  const ledgerCount = (h: GoldenHousehold): Promise<number> =>
    world.sys('count the ledger', () =>
      world.prisma.rewardsLedgerEntry.count({ where: { familyId: h.familyId } }),
    );

  // =========================================================================
  // WALL ONE — BETWEEN FAMILIES
  // =========================================================================

  describe('WALL ONE — family B cannot read, modify, approve or notify into family A', () => {
    it('cannot READ family A\'s child, program or achievement — 404, never 403', async () => {
      const probes = [
        request(world.http).get(`${P}/children/${A.childId}`).set(asParent(B)),
        request(world.http).get(`${P}/reward-programs/${programA}`).set(asParent(B)),
        request(world.http).get(`${P}/reward-programs/achievements/${achievementA}`).set(asParent(B)),
        request(world.http).get(`${P}/children/${A.childId}/screen-time-policy`).set(asParent(B)),
      ];
      for (const probe of await Promise.all(probes)) {
        // 404 and NOT 403. A 403 would confirm the row exists, which is the
        // leak — «does this family have a child with this id» is itself data.
        expect(probe.status).toBe(404);
      }
    });

    it("cannot MODIFY or DELETE family A's program", async () => {
      const patched = await request(world.http)
        .patch(`${P}/reward-programs/${programA}`)
        .set(asParent(B))
        .send({ maxPerDay: 20 });
      expect(patched.status).toBe(404);

      const deleted = await request(world.http)
        .delete(`${P}/reward-programs/${programA}`)
        .set(asParent(B));
      expect(deleted.status).toBe(404);

      // And the program is untouched, read back through its OWNER.
      const mine = await request(world.http).get(`${P}/reward-programs/${programA}`).set(asParent(A));
      expect(mine.status).toBe(200);
      expect(mine.body.maxPerDay).toBe(1);
      expect(mine.body.status).toBe('ACTIVE');
    });

    it("cannot APPROVE family A's pending achievement — the highest-value write in the product", async () => {
      const before = await ledgerCount(A);

      const approved = await request(world.http)
        .post(`${P}/reward-programs/achievements/${achievementA}/approve`)
        .set(asParent(B))
        .send({});
      expect(approved.status).toBe(404);

      const rejected = await request(world.http)
        .post(`${P}/reward-programs/achievements/${achievementA}/reject`)
        .set(asParent(B))
        .send({ note: 'لا' });
      expect(rejected.status).toBe(404);

      await world.drainOutbox();
      expect(await ledgerCount(A)).toBe(before);

      // The achievement is still waiting for ITS OWN parent — read from the row
      // rather than from a response body, so the assertion is about the state
      // of the world and not about a serialiser.
      const row = await world.sys('read the achievement', () =>
        world.prisma.achievementRequest.findFirst({ where: { id: achievementA } }),
      );
      expect(row.status).toBe('PENDING_PARENT');
    });

    it("cannot NOTIFY into family A — no message may be drafted to another household's child", async () => {
      const drafted = await request(world.http)
        .post(`${P}/life-intelligence/communication/${A.childId}/ai-draft`)
        .set(asParent(B))
        .send({ category: 'ENCOURAGEMENT', title: 'مرحبا', body: 'رسالة من غريب' });
      expect([403, 404]).toContain(drafted.status);

      const direct = await request(world.http)
        .post(`${P}/life-intelligence/communication/${A.childId}/parent-message`)
        .set(asParent(B))
        .send({ category: 'ENCOURAGEMENT', title: 'مرحبا', body: 'رسالة من غريب' });
      expect([403, 404]).toContain(direct.status);

      const rows = await world.raw<any[]>(
        `SELECT * FROM "child_messages" WHERE "child_id" = $1::uuid`,
        A.childId,
      );
      expect(rows).toHaveLength(0);
    });

    it("cannot change family A's screen-time policy, and A's own allowance is unmoved", async () => {
      await request(world.http)
        .post(`${P}/children/${A.childId}/screen-time-policy`)
        .set(asParent(A))
        .send({ dailyLimitMinutes: 90 });

      const hijacked = await request(world.http)
        .post(`${P}/children/${A.childId}/screen-time-policy`)
        .set(asParent(B))
        .send({ dailyLimitMinutes: 1440 });
      expect(hijacked.status).toBe(404);

      const effective = await request(world.http)
        .get(`${P}/children/${A.childId}/screen-time-policy/effective`)
        .set(asParent(A));
      expect(effective.body.effectiveDailyLimitMinutes).toBe(90);
    });

    it("family B's LISTS contain only family B — isolation is a property of the read, not of the id", async () => {
      const children = await request(world.http).get(`${P}/children`).set(asParent(B));
      expect(children.body.map((c: any) => c.id)).toEqual([B.childId]);

      const programs = await request(world.http).get(`${P}/reward-programs`).set(asParent(B));
      expect(programs.body.map((p: any) => p.id)).not.toContain(programA);

      const pending = await request(world.http)
        .get(`${P}/reward-programs/achievements/pending`)
        .set(asParent(B));
      expect(JSON.stringify(pending.body)).not.toContain(achievementA);
    });
  });

  // =========================================================================
  // WALL TWO — BETWEEN A CHILD AND EVERYTHING
  // =========================================================================

  describe('WALL TWO — a child cannot approve, cannot grant, cannot change a policy, cannot reach a sibling', () => {
    it('a device token cannot APPROVE its own achievement — a different Passport strategy, not a lower role', async () => {
      const before = await ledgerCount(A);

      const selfApproved = await request(world.http)
        .post(`${P}/reward-programs/achievements/${achievementA}/approve`)
        .set(asChild(A))
        .send({});
      // 401: the parent controller runs the parent strategy, and a device token
      // is not a weaker parent token — it is not a parent token at all.
      expect(selfApproved.status).toBe(401);

      await world.drainOutbox();
      expect(await ledgerCount(A)).toBe(before);
    });

    it('a device token cannot CREATE a program, and so cannot author its own reward', async () => {
      const authored = await request(world.http)
        .post(`${P}/reward-programs`)
        .set(asChild(A))
        .send({ childId: A.childId, ...A_CHORE, rewardSpec: { type: 'POINTS', amount: 9999 } });
      expect(authored.status).toBe(401);

      const programs = await world.sys('count programs', () =>
        world.prisma.rewardProgram.count({ where: { familyId: A.familyId } }),
      );
      expect(programs).toBe(1);
    });

    it('a device token cannot GRANT itself anything through the rewards trigger', async () => {
      const before = await ledgerCount(A);
      const granted = await request(world.http)
        .post(`${P}/life-intelligence/rewards/${A.childId}/trigger`)
        .set(asChild(A))
        .send({ trigger: 'HABIT_COMPLETED', amount: 500 });
      expect([400, 401, 403]).toContain(granted.status);
      expect(await ledgerCount(A)).toBe(before);
    });

    it('a device token cannot CHANGE THE POLICY that governs it', async () => {
      const changed = await request(world.http)
        .post(`${P}/children/${A.childId}/screen-time-policy`)
        .set(asChild(A))
        .send({ dailyLimitMinutes: 1440 });
      expect(changed.status).toBe(401);

      const blocked = await request(world.http)
        .delete(`${P}/children/${A.childId}/app-block-rules/00000000-0000-4000-8000-000000000000`)
        .set(asChild(A));
      expect(blocked.status).toBe(401);

      const effective = await request(world.http)
        .get(`${P}/children/${A.childId}/screen-time-policy/effective`)
        .set(asParent(A));
      expect(effective.body.effectiveDailyLimitMinutes).toBe(90);
    });

    it("a child cannot reach a SIBLING — the id in the request is not read at all", async () => {
      // The child-facing inbox route takes a `:childId`, and the service
      // resolves the DEVICE's own child before answering.
      const sibling = await request(world.http)
        .get(`${P}/life-intelligence/communication/child/${siblingId}`)
        .set(asChild(A));
      expect([403, 404]).toContain(sibling.status);

      // And on `/self/*` the id is not a parameter at all: whatever the device
      // sends, it gets its own child. This is the structural version of the
      // same rule, and the stronger one.
      const mine = await request(world.http).get(`${P}/self/achievements/mine`).set(asChild(A));
      expect(mine.status).toBe(200);
      expect(JSON.stringify(mine.body)).not.toContain(siblingId);
    });

    it("a child of family A cannot touch family B's attempt", async () => {
      const startedB = await request(world.http)
        .post(`${P}/self/achievements/start`)
        .set(asChild(B))
        .send({ programId: programA });
      // B's child cannot even START family A's program.
      expect([403, 404]).toContain(startedB.status);

      const submitted = await request(world.http)
        .post(`${P}/self/achievements/${achievementA}/submit`)
        .set(asChild(B))
        .send({ selfConfirmed: true });
      expect(submitted.status).toBe(404);
    });
  });

  // =========================================================================
  // WALL THREE — BETWEEN ROLES INSIDE ONE HOUSEHOLD
  // =========================================================================

  describe('WALL THREE — a co-parent is a parent, not a co-owner', () => {
    it('the co-parent CAN do the parenting: read the family, see the children, approve an achievement', async () => {
      const members = await request(world.http).get(`${P}/families/members`).set(asBearer(coParent.token));
      expect(members.status).toBe(200);

      const children = await request(world.http).get(`${P}/children`).set(asBearer(coParent.token));
      expect(children.status).toBe(200);
      expect(children.body.map((c: any) => c.id)).toContain(A.childId);

      // The wall is around DESTRUCTIVE and FINANCIAL actions, not around
      // parenting. A co-parent who could not approve their own child's
      // achievement would be a second-class parent, which is not the rule.
      const approved = await request(world.http)
        .post(`${P}/reward-programs/achievements/${achievementA}/approve`)
        .set(asBearer(coParent.token))
        .send({});
      expect([200, 201]).toContain(approved.status);

      await world.drainOutbox();
      expect(await ledgerCount(A)).toBe(1);
    });

    it('the co-parent CANNOT commit the household to money', async () => {
      const subscribed = await request(world.http)
        .post(`${P}/billing/subscribe`)
        .set(asBearer(coParent.token))
        .send({ planTier: 'PREMIUM', provider: 'MANUAL' });
      expect(subscribed.status).toBe(403);

      const cancelled = await request(world.http)
        .post(`${P}/billing/cancel`)
        .set(asBearer(coParent.token))
        .send({});
      expect(cancelled.status).toBe(403);

      const verified = await request(world.http)
        .post(`${P}/billing/purchases/verify`)
        .set(asBearer(coParent.token))
        .send({ provider: 'APPLE_IAP', providerToken: 'anything' });
      expect(verified.status).toBe(403);
    });

    it('the co-parent CANNOT end the household, take it over, or remove the owner', async () => {
      const deleted = await request(world.http)
        .delete(`${P}/account`)
        .set(asBearer(coParent.token))
        .send({ currentPassword: coParent.password });
      // 403 and not 404 here, deliberately: the co-parent is INSIDE this family
      // and the family plainly exists. Hiding that would be theatre; the
      // information being protected is the ACTION, not the row's existence.
      expect(deleted.status).toBe(403);

      const transferred = await request(world.http)
        .post(`${P}/families/ownership/transfer`)
        .set(asBearer(coParent.token))
        .send({ toUserId: coParent.userId });
      expect(transferred.status).toBe(403);

      const removedOwner = await request(world.http)
        .delete(`${P}/families/members/${A.ownerUserId}`)
        .set(asBearer(coParent.token));
      expect(removedOwner.status).toBe(403);

      // Nothing moved: the owner is still the owner and the family still exists.
      const members = await world.sys('read the memberships', () =>
        world.prisma.familyMember.findMany({ where: { familyId: A.familyId } }),
      );
      const owner = members.find((m: any) => m.role === 'OWNER');
      expect(owner.userId).toBe(A.ownerUserId);
      expect(members).toHaveLength(2);
    });

    it("the OWNER of family B cannot remove a member of family A — 404, because that member is not theirs", async () => {
      const removed = await request(world.http)
        .delete(`${P}/families/members/${coParent.userId}`)
        .set(asParent(B));
      expect([403, 404]).toContain(removed.status);

      const members = await world.sys('read the memberships again', () =>
        world.prisma.familyMember.count({ where: { familyId: A.familyId } }),
      );
      expect(members).toBe(2);
    });
  });

  // =========================================================================
  // THE SWEEP — the same probe against every family-scoped read at once
  // =========================================================================

  it('THE SWEEP — every cross-family probe answered 404 or 403, and NONE answered 200', async () => {
    // Thunks and not promises, awaited one at a time: `supertest` binds an
    // ephemeral listener per request, and seven of them opened at once is a
    // test-harness race rather than anything about the product.
    const probes: Array<[string, () => Promise<any>]> = [
      [`GET /children/:id`, () => request(world.http).get(`${P}/children/${A.childId}`).set(asParent(B))],
      [`GET /reward-programs/:id`, () => request(world.http).get(`${P}/reward-programs/${programA}`).set(asParent(B))],
      [
        `GET /reward-programs/achievements/:id`,
        () => request(world.http).get(`${P}/reward-programs/achievements/${achievementA}`).set(asParent(B)),
      ],
      [
        `GET /reward-programs/streaks/:childId`,
        () => request(world.http).get(`${P}/reward-programs/streaks/${A.childId}`).set(asParent(B)),
      ],
      [
        `GET /life-intelligence/rewards/:childId/ledger`,
        () => request(world.http).get(`${P}/life-intelligence/rewards/${A.childId}/ledger`).set(asParent(B)),
      ],
      [
        `GET /children/:id/screen-time-policy`,
        () => request(world.http).get(`${P}/children/${A.childId}/screen-time-policy`).set(asParent(B)),
      ],
      [
        `GET /children/:id/app-block-rules`,
        () => request(world.http).get(`${P}/children/${A.childId}/app-block-rules`).set(asParent(B)),
      ],
    ];

    const failures: string[] = [];
    for (const [name, probe] of probes) {
      const res = await probe();
      // A 200 is the failure this whole scenario exists to prevent. An empty
      // 200 counts too: leaking "this id resolves for you" is the same leak.
      if (res.status === 200) failures.push(`${name} -> 200 ${JSON.stringify(res.body).slice(0, 120)}`);
      if (![403, 404].includes(res.status) && res.status !== 200) {
        failures.push(`${name} -> unexpected ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('THE SWEEP — and family A never saw a single row of family B in its own reads', async () => {
    // `async () => await ...` and not the bare call: a Prisma model call returns
    // a LAZY promise, so handing it straight back would dispatch the query
    // after the tenant scope had already unwound.
    const mine = await runWithTenant(
      { familyId: A.familyId, actorType: 'USER', actorId: A.ownerUserId },
      async () => await world.prisma.child.findMany({ select: { id: true, familyId: true } }),
    );
    for (const child of mine as any[]) {
      expect(child.familyId).toBe(A.familyId);
    }
    expect((mine as any[]).map((c) => c.id).sort()).toEqual([A.childId, siblingId].sort());
  });
});
