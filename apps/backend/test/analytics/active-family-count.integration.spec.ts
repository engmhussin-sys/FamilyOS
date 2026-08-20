/**
 * F1 — THE PROOF THAT COUNTING IN SQL RETURNS THE SAME NUMBER.
 *
 * `DashboardMetricsService.getMetrics` and `KpiService.retentionCohort` both
 * used to answer «how many families were active» with
 * `device.findMany({ distinct: ['familyId'], select: { familyId: true } })`
 * followed by `.length`. This repo runs Prisma 5.20 with
 * `previewFeatures = ["driverAdapters"]` and WITHOUT `nativeDistinct`, so that
 * `distinct` is applied CLIENT-SIDE — one row per matching DEVICE crosses the
 * wire and JavaScript throws the duplicates away. Both sites now ask
 * PostgreSQL for a `COUNT` over a semi-join instead.
 *
 * A performance change to a number is only acceptable if the number does not
 * move. So this suite seeds a population whose answer is known BY HAND, then
 * runs the OLD construct and the NEW construct against the same real
 * PostgreSQL and asserts all three agree — including on the awkward cases the
 * de-duplication existed for: a family with several devices inside the window
 * (must count ONCE), a family whose only in-window device is soft-deleted
 * (must not count), a family whose devices are all outside the window (must
 * not count), and a family with no devices at all.
 *
 * The old construct is executed here, not described — if the replacement ever
 * drifts from it, this suite goes red rather than a dashboard quietly printing
 * a different truth.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a database built from
 * prisma/migrations. Skipped (not silently passed) otherwise.
 */
import { randomUUID } from 'crypto';

import { createTestPrisma, integrationDatabaseUrl, type TestPrismaHandle } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

describeIfDb('F1 — active-family counts move from Node to SQL without moving (real PostgreSQL)', () => {
  let h: TestPrismaHandle;

  /** The reporting window every assertion below is taken over. */
  const windowStart = new Date('2026-03-10T00:00:00.000Z');
  const windowEnd = new Date('2026-03-17T00:00:00.000Z');
  /** Inside the window. */
  const seen = new Date('2026-03-12T09:00:00.000Z');
  /** Before it. */
  const stale = new Date('2026-01-05T09:00:00.000Z');
  /** The cohort day the retention numerator is taken over. */
  const cohortStart = new Date('2026-03-01T00:00:00.000Z');
  const cohortEnd = new Date('2026-03-02T00:00:00.000Z');
  const inCohort = new Date('2026-03-01T11:00:00.000Z');
  const outOfCohort = new Date('2026-02-20T11:00:00.000Z');

  const ids = {
    /** 3 devices, ALL inside the window — the de-duplication case. */
    multiDevice: randomUUID(),
    /** 1 device inside the window. */
    single: randomUUID(),
    /** its only in-window device is soft-deleted. */
    deletedDevice: randomUUID(),
    /** devices exist, none inside the window. */
    stale: randomUUID(),
    /** no devices at all. */
    deviceless: randomUUID(),
    /** in-window device, but the FAMILY row is soft-deleted. */
    deletedFamily: randomUUID(),
    /** in-window device, but registered OUTSIDE the retention cohort day. */
    outsideCohort: randomUUID(),
  };
  const familyIds = Object.values(ids);

  /**
   * THE CONSTRUCT BEING REPLACED, executed verbatim. `distinct` here is
   * Prisma's client-side de-duplication — this is the row traffic the change
   * is about.
   */
  async function activeFamiliesTheOldWay(where: Record<string, unknown>): Promise<number> {
    const rows = await h.raw.device.findMany({
      where,
      distinct: ['familyId'],
      select: { familyId: true },
    });
    return rows.length;
  }

  beforeAll(async () => {
    h = createTestPrisma();

    const family = async (id: string, createdAt: Date, deletedAt: Date | null): Promise<void> => {
      await h.raw.family.create({
        data: { id, name: `Probe ${id.slice(0, 8)}`, createdAt, deletedAt },
      });
    };
    const device = async (familyId: string, lastSeenAt: Date, deletedAt: Date | null): Promise<void> => {
      await h.raw.device.create({
        data: {
          id: randomUUID(),
          familyId,
          ownerType: 'CHILD',
          platform: 'ANDROID',
          status: 'ACTIVE',
          lastSeenAt,
          deletedAt,
        },
      });
    };

    await family(ids.multiDevice, inCohort, null);
    await device(ids.multiDevice, seen, null);
    await device(ids.multiDevice, seen, null);
    await device(ids.multiDevice, seen, null);

    await family(ids.single, inCohort, null);
    await device(ids.single, seen, null);

    await family(ids.deletedDevice, inCohort, null);
    await device(ids.deletedDevice, seen, new Date('2026-03-13T00:00:00.000Z'));

    await family(ids.stale, inCohort, null);
    await device(ids.stale, stale, null);
    await device(ids.stale, stale, null);

    await family(ids.deviceless, inCohort, null);

    await family(ids.deletedFamily, inCohort, new Date('2026-03-14T00:00:00.000Z'));
    await device(ids.deletedFamily, seen, null);

    await family(ids.outsideCohort, outOfCohort, null);
    await device(ids.outsideCohort, seen, null);
  });

  afterAll(async () => {
    await h.raw.device.deleteMany({ where: { familyId: { in: familyIds } } });
    await h.raw.family.deleteMany({ where: { id: { in: familyIds } } });
    await h.disconnect();
  });

  /**
   * Every device row this fixture puts inside the window, so the row traffic
   * the old construct generated is a measured fact here and not a claim:
   * 3 (multiDevice) + 1 (single) + 1 (deletedFamily) + 1 (outsideCohort) = 6
   * device rows, for 4 families. The de-duplication threw away 2 of them.
   */
  it('the old construct fetched more device rows than there are families — the cost the change removes', async () => {
    const rows = await h.raw.device.findMany({
      where: { deletedAt: null, lastSeenAt: { gte: windowStart, lt: windowEnd }, familyId: { in: familyIds } },
      select: { familyId: true },
    });
    const distinctFamilies = new Set(rows.map((r: { familyId: string }) => r.familyId));

    expect(rows).toHaveLength(6);
    expect(distinctFamilies.size).toBe(4);
  });

  it('DashboardMetricsService — SQL COUNT over EXISTS equals the client-side distinct, exactly', async () => {
    const scope = { familyId: { in: familyIds } };

    const oldWay = await activeFamiliesTheOldWay({
      deletedAt: null,
      lastSeenAt: { gte: windowStart, lt: windowEnd },
      ...scope,
    });

    const newWay = await h.raw.family.count({
      where: {
        id: { in: familyIds },
        devices: { some: { deletedAt: null, lastSeenAt: { gte: windowStart, lt: windowEnd } } },
      },
    });

    // Hand-counted: multiDevice, single, deletedFamily, outsideCohort.
    // NOT deletedDevice (its only in-window device is soft-deleted), NOT stale,
    // NOT deviceless.
    expect(oldWay).toBe(4);
    expect(newWay).toBe(oldWay);
  });

  /**
   * The soft-deleted FAMILY is counted by both, and that is the point of this
   * case rather than an oversight: the predicate was kept identical, so the
   * replacement inherits whatever the old one did. `KpiService.activeFamilies`
   * separately and deliberately excludes soft-deleted families; aligning the
   * other two sites is a behavioural decision about a published KPI, not part
   * of a performance change, and this test pins today's answer so that
   * decision cannot be made by accident.
   */
  it('a soft-deleted family with a live device is counted by BOTH constructs — the predicate really is identical', async () => {
    const scope = { familyId: { in: [ids.deletedFamily] } };

    const oldWay = await activeFamiliesTheOldWay({
      deletedAt: null,
      lastSeenAt: { gte: windowStart, lt: windowEnd },
      ...scope,
    });
    const newWay = await h.raw.family.count({
      where: {
        id: { in: [ids.deletedFamily] },
        devices: { some: { deletedAt: null, lastSeenAt: { gte: windowStart, lt: windowEnd } } },
      },
    });

    expect(oldWay).toBe(1);
    expect(newWay).toBe(1);
  });

  it('KpiService.retentionCohort — the numerator is unchanged, cohort filter and all', async () => {
    const oldWay = await activeFamiliesTheOldWay({
      deletedAt: null,
      lastSeenAt: { gte: windowStart, lt: windowEnd },
      family: { createdAt: { gte: cohortStart, lt: cohortEnd }, id: { in: familyIds } },
    });

    const newWay = await h.raw.family.count({
      where: {
        createdAt: { gte: cohortStart, lt: cohortEnd },
        id: { in: familyIds },
        devices: { some: { deletedAt: null, lastSeenAt: { gte: windowStart, lt: windowEnd } } },
      },
    });

    // multiDevice, single and deletedFamily registered on the cohort day and
    // were seen in the target window. `outsideCohort` was seen but registered
    // a fortnight earlier, so it belongs to a different cohort.
    expect(oldWay).toBe(3);
    expect(newWay).toBe(oldWay);
  });

  it('an empty answer is 0 from both, not a crash and not a null', async () => {
    const emptyWindowStart = new Date('2030-01-01T00:00:00.000Z');
    const emptyWindowEnd = new Date('2030-01-08T00:00:00.000Z');

    const oldWay = await activeFamiliesTheOldWay({
      deletedAt: null,
      lastSeenAt: { gte: emptyWindowStart, lt: emptyWindowEnd },
      familyId: { in: familyIds },
    });
    const newWay = await h.raw.family.count({
      where: {
        id: { in: familyIds },
        devices: { some: { deletedAt: null, lastSeenAt: { gte: emptyWindowStart, lt: emptyWindowEnd } } },
      },
    });

    expect(oldWay).toBe(0);
    expect(newWay).toBe(0);
  });
});
