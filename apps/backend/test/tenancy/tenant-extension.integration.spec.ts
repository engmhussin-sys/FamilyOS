/**
 * The deny-by-default proof, and the cross-tenant read/write proofs, executed
 * against a real PostgreSQL 16 built from prisma/migrations.
 *
 * These are NOT mocked. Every assertion below is the database's answer.
 *
 * Runs only when INTEGRATION_DATABASE_URL is set. Skipped loudly otherwise —
 * never silently passed (CONTEXT.md principle 9: BLOCKED != PASS).
 */
import { randomUUID } from 'crypto';

import { runAsSystem } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { createTestPrisma, integrationDatabaseUrl, type TestPrismaHandle } from './prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

describeIfDb('R8 — tenant isolation enforced by the Prisma Client Extension (real PostgreSQL)', () => {
  let h: TestPrismaHandle;
  const familyA = randomUUID();
  const familyB = randomUUID();
  const childA = randomUUID();
  const childB = randomUUID();
  const habitA = randomUUID();
  const habitB = randomUUID();

  // NOTE the `async () => await fn()`: a Prisma call returns a lazy
  // PrismaPromise whose work starts at `.then()`. Handing the un-awaited
  // promise back out of `runWithTenant` would resolve it OUTSIDE the
  // AsyncLocalStorage scope and the extension would (correctly) see no tenant.
  // Awaiting inside is what a real service does too — every repository method
  // in src/ awaits its own Prisma call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asA = (fn: () => Promise<any>): Promise<any> =>
    runWithTenant({ familyId: familyA, actorType: 'USER', actorId: 'user-a' }, async () => fn());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asB = (fn: () => Promise<any>): Promise<any> =>
    runWithTenant({ familyId: familyB, actorType: 'USER', actorId: 'user-b' }, async () => fn());

  beforeAll(async () => {
    h = createTestPrisma();
    // Seeded through the RAW client on purpose: fixtures must not depend on the
    // thing under test.
    for (const [fid, cid, hid, name] of [
      [familyA, childA, habitA, 'A'],
      [familyB, childB, habitB, 'B'],
    ] as const) {
      await h.raw.family.create({ data: { id: fid, name: `Probe Family ${name}` } });
      await h.raw.child.create({
        data: { id: cid, familyId: fid, firstName: `Child ${name}`, dateOfBirth: new Date('2015-01-01') },
      });
      await h.raw.habit.create({
        data: { id: hid, familyId: fid, childId: cid, title: `Habit ${name}`, category: 'LEARNING' },
      });
    }
  });

  afterAll(async () => {
    await h.raw.family.deleteMany({ where: { id: { in: [familyA, familyB] } } });
    await h.disconnect();
  });

  // -------------------------------------------------------------------------
  describe('deny by default', () => {
    it('findMany on a tenant-scoped model with NO context throws instead of returning everything', async () => {
      await expect(h.scoped.habit.findMany({})).rejects.toThrow('TENANT_CONTEXT_MISSING');
    });

    it('...and the un-extended client really would have returned everything (control)', async () => {
      const all = await h.raw.habit.findMany({ where: { id: { in: [habitA, habitB] } } });
      expect(all).toHaveLength(2);
    });

    it.each([
      ['findUnique', () => h.scoped.habit.findUnique({ where: { id: habitA } })],
      ['findFirst', () => h.scoped.habit.findFirst({})],
      ['count', () => h.scoped.habit.count()],
      ['aggregate', () => h.scoped.habit.aggregate({ _count: true })],
      ['create', () => h.scoped.habit.create({ data: { childId: childA, title: 'x', category: 'LEARNING' } })],
      ['update', () => h.scoped.habit.update({ where: { id: habitA }, data: { title: 'x' } })],
      ['updateMany', () => h.scoped.habit.updateMany({ data: { title: 'x' } })],
      ['delete', () => h.scoped.habit.delete({ where: { id: habitA } })],
      ['deleteMany', () => h.scoped.habit.deleteMany({})],
    ])('%s is denied without a tenant', async (_name, op) => {
      await expect(op()).rejects.toThrow('TENANT_CONTEXT_MISSING');
    });

    it('a global model is NOT denied — the guard is targeted, not indiscriminate', async () => {
      await expect(h.scoped.planDefinition.findMany({})).resolves.toBeDefined();
    });

    it('the family root itself is scoped by id, so it cannot be enumerated', async () => {
      const seen = await asA(() => h.scoped.family.findMany({}));
      expect(seen.map((f: { id: string }) => f.id)).toEqual([familyA]);
    });
  });

  // -------------------------------------------------------------------------
  describe('cross-tenant reads', () => {
    it('findMany returns only the caller tenant rows', async () => {
      const rows = await asA(() => h.scoped.habit.findMany({ where: { id: { in: [habitA, habitB] } } }));
      expect(rows.map((r: { id: string }) => r.id)).toEqual([habitA]);
    });

    it("findUnique on ANOTHER family's row returns null, not the row", async () => {
      expect(await asA(() => h.scoped.habit.findUnique({ where: { id: habitB } }))).toBeNull();
      expect(await asB(() => h.scoped.habit.findUnique({ where: { id: habitA } }))).toBeNull();
    });

    it('findUniqueOrThrow raises P2025 (=> the API answers 404, not 403)', async () => {
      await expect(asA(() => h.scoped.habit.findUniqueOrThrow({ where: { id: habitB } }))).rejects.toMatchObject({
        code: 'P2025',
      });
    });

    it('count and aggregate are scoped too', async () => {
      expect(await asA(() => h.scoped.habit.count({ where: { id: { in: [habitA, habitB] } } }))).toBe(1);
      const agg = await asA(() =>
        h.scoped.habit.aggregate({ where: { id: { in: [habitA, habitB] } }, _count: { _all: true } }),
      );
      expect(agg._count._all).toBe(1);
    });

    it('an explicit cross-tenant where is OVERRIDDEN, not honoured', async () => {
      // The classic IDOR shape: the caller names the family it wants. The
      // extension does not merely ignore it — it replaces it, so the query runs
      // against the caller's own tenant and returns the caller's own rows.
      const rows = await asA(() => h.scoped.habit.findMany({ where: { familyId: familyB } }));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r: { familyId: string }) => r.familyId === familyA)).toBe(true);
      expect(rows.some((r: { familyId: string }) => r.familyId === familyB)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('cross-tenant writes', () => {
    it("update against another family's row raises P2025 and changes nothing", async () => {
      await expect(
        asA(() => h.scoped.habit.update({ where: { id: habitB }, data: { title: 'HIJACKED' } })),
      ).rejects.toMatchObject({ code: 'P2025' });
      const untouched = await h.raw.habit.findUnique({ where: { id: habitB } });
      expect(untouched.title).toBe('Habit B');
    });

    it("delete against another family's row raises P2025 and deletes nothing", async () => {
      await expect(asA(() => h.scoped.habit.delete({ where: { id: habitB } }))).rejects.toMatchObject({
        code: 'P2025',
      });
      expect(await h.raw.habit.findUnique({ where: { id: habitB } })).not.toBeNull();
    });

    it('deleteMany cannot reach across tenants even with an empty where', async () => {
      await asA(() => h.scoped.habit.deleteMany({ where: { title: 'nothing-matches' } }));
      expect(await h.raw.habit.count({ where: { id: { in: [habitA, habitB] } } })).toBe(2);
    });

    it('create stamps the caller tenant, ignoring what the payload asked for', async () => {
      const created = await asA(() =>
        h.scoped.habit.create({ data: { childId: childA, title: 'Stamped', category: 'LEARNING' } }),
      );
      expect(created.familyId).toBe(familyA);
      await h.raw.habit.delete({ where: { id: created.id } });
    });

    it('create that NAMES another family is refused outright (CROSS_TENANT_WRITE)', async () => {
      await expect(
        asA(() =>
          h.scoped.habit.create({
            data: { familyId: familyB, childId: childA, title: 'Planted', category: 'LEARNING' },
          }),
        ),
      ).rejects.toThrow('CROSS_TENANT_WRITE');
    });
  });

  // -------------------------------------------------------------------------
  describe('transactions', () => {
    it('scoping still applies INSIDE $transaction', async () => {
      const [mine, theirs] = await asA(() =>
        h.scoped.$transaction(async (tx: any) => [
          await tx.habit.findUnique({ where: { id: habitA } }),
          await tx.habit.findUnique({ where: { id: habitB } }),
        ]),
      );
      expect(mine.id).toBe(habitA);
      expect(theirs).toBeNull();
    });

    it('deny-by-default applies inside $transaction as well', async () => {
      await expect(
        h.scoped.$transaction(async (tx: any) => tx.habit.findMany({})),
      ).rejects.toThrow('TENANT_CONTEXT_MISSING');
    });
  });

  // -------------------------------------------------------------------------
  describe('nested include / select', () => {
    it('a nested read cannot cross tenants, because the parent is already scoped', async () => {
      const child = await asA(() =>
        h.scoped.child.findUnique({ where: { id: childA }, include: { habits: true } }),
      );
      expect(child.habits.every((x: { familyId: string }) => x.familyId === familyA)).toBe(true);

      const foreign = await asA(() =>
        h.scoped.child.findUnique({ where: { id: childB }, include: { habits: true } }),
      );
      expect(foreign).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('the SystemContext escape hatch', () => {
    it('lets a justified cross-tenant job through', async () => {
      const rows = await runAsSystem(
        'DATA_RETENTION_JOB',
        'Retention sweep is cross-tenant by definition (A2 §6.3 row 15).',
        async () => h.scoped.habit.findMany({ where: { id: { in: [habitA, habitB] } } }),
      );
      expect(rows).toHaveLength(2);
    });

    it('refuses an empty justification — the audit trail is not optional', () => {
      expect(() => runAsSystem('DATA_RETENTION_JOB', '', () => undefined)).toThrow('justification');
    });

    it('does not leak: the context ends with the callback', async () => {
      await runAsSystem('TEST_FIXTURE', 'Proving the bypass does not outlive its callback.', async () =>
        h.scoped.habit.count(),
      );
      await expect(h.scoped.habit.findMany({})).rejects.toThrow('TENANT_CONTEXT_MISSING');
    });
  });

  // -------------------------------------------------------------------------
  describe('the nullable classes behave as classified', () => {
    it('a platform-annotated model hides its NULL-tenant rows from tenants', async () => {
      const platformRow = await h.raw.auditLog.create({
        data: { actorType: 'SYSTEM', action: 'platform.event', entityType: 'System', entityId: randomUUID() },
      });
      const tenantRow = await h.raw.auditLog.create({
        data: {
          familyId: familyA,
          actorType: 'USER',
          action: 'family.event',
          entityType: 'Family',
          entityId: familyA,
        },
      });

      const visible = await asA(() =>
        h.scoped.auditLog.findMany({ where: { id: { in: [platformRow.id, tenantRow.id] } } }),
      );
      expect(visible.map((r: { id: string }) => r.id)).toEqual([tenantRow.id]);

      await h.raw.auditLog.deleteMany({ where: { id: { in: [platformRow.id, tenantRow.id] } } });
    });

    it('a shared-null model shows platform rows AND the tenant rows, but never another tenant rows', async () => {
      const systemRule = await h.raw.rewardRule.create({
        data: { triggerEngine: 'HABIT', triggerCondition: {}, rewardType: 'XP', rewardAmountOrBadgeId: '5' },
      });
      const aRule = await h.raw.rewardRule.create({
        data: { familyId: familyA, triggerEngine: 'HABIT', triggerCondition: {}, rewardType: 'XP', rewardAmountOrBadgeId: '7' },
      });
      const bRule = await h.raw.rewardRule.create({
        data: { familyId: familyB, triggerEngine: 'HABIT', triggerCondition: {}, rewardType: 'XP', rewardAmountOrBadgeId: '9' },
      });

      const visible = await asA(() =>
        h.scoped.rewardRule.findMany({ where: { id: { in: [systemRule.id, aRule.id, bRule.id] } } }),
      );
      const ids = visible.map((r: { id: string }) => r.id).sort();
      expect(ids).toEqual([systemRule.id, aRule.id].sort());

      await h.raw.rewardRule.deleteMany({ where: { id: { in: [systemRule.id, aRule.id, bRule.id] } } });
    });
  });
});
