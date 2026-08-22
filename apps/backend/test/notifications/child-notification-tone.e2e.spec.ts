/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * PHASE F (`F6-005`) — FOUR REAL CHILDREN, FOUR REAL AGES, FOUR DIFFERENT
 * SENTENCES IN `child_messages`.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `notification-tone-and-copy.spec.ts`.
 * That suite proves the CATALOGUE adapts by band — it calls
 * `renderNotificationCopy` directly with a band it chose itself. This one proves
 * the PRODUCT does, which is a different claim and a longer chain: a date of
 * birth in `children`, an age computed on the family's calendar, a tone band
 * derived from it, a copy variant selected, a safety ceiling applied at the
 * CHILD'S OWN `age-band.ts` band, and a row written through the approval gate.
 * Every link in that chain has somewhere it can silently collapse to one band
 * for everybody, and a catalogue test would not notice any of them.
 *
 * IT IS ALSO `PE-N-001`'s REGRESSION GUARD AT FOUR AGES. That defect made the
 * entire child surface produce zero rows while reporting `SUPPRESS` /
 * `DELIVERY_ERROR`. A suite that asserts four DISTINCT bodies in
 * `child_messages` cannot be green if the table is empty.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { ageBandProfile } from '../../src/modules/ai-core/domain/age-band';
import { ChildSafetyFilterService } from '../../src/modules/ai-core/application/services/child-safety-filter.service';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const AFTERNOON = new Date('2026-01-15T15:00:00.000Z'); // 17:00 Cairo

/**
 * Four dates of birth, chosen so that each child lands in a DIFFERENT tone band
 * on 2026-01-15 AND so that two of them sit on the awkward side of the overlap
 * with `age-band.ts` — the 9-year-old is tone `8-10` and safety `9-11`, the
 * 12-year-old is tone `11-13` and safety `12-14`. If the two band systems were
 * being conflated anywhere, these two are where it would show.
 */
const COHORT = [
  { label: 'six', dob: '2019-06-01', age: 6, tone: '5-7', safety: '6-8' },
  { label: 'nine', dob: '2016-06-01', age: 9, tone: '8-10', safety: '9-11' },
  { label: 'twelve', dob: '2013-06-01', age: 12, tone: '11-13', safety: '12-14' },
  { label: 'sixteen', dob: '2009-06-01', age: 16, tone: '14-17', safety: '15-17' },
] as const;

function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const base = new PrismaClient({ adapter: new PrismaPg(pool) });
    const extended = base.$extends(createTenantExtension());
    extended.onModuleInit = async () => undefined;
    extended.onModuleDestroy = async () => {
      await base.$disconnect();
      await pool.end();
    };
    return extended;
  }
  const { PrismaClient } = require('@prisma/client');
  // PRISMA 7 removed `datasources`, so a driver adapter is the only way to
  // open a connection. The pool is NAMED and kept: `$disconnect()` closes what
  // Prisma opened and never a pool the caller supplied, so an anonymous pool
  // here is a Postgres connection this suite leaks for the rest of the run.
  const fallbackPool = new (require('pg').Pool)({ connectionString: url });
  const base = new PrismaClient({
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(fallbackPool),
  });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => {
    await base.$disconnect();
    await fallbackPool.end();
  };
  return extended;
}

describeIfDb('PHASE F — child notifications adapt to the child (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let engine: SmartNotificationEngineService;
  const safety = new ChildSafetyFilterService();

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  const cohort: Record<string, { familyId: string; childId: string }> = {};

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `Phase F child tone suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const childMessageRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  const decisionRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(`SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid`, familyId);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    engine = app.get(SmartNotificationEngineService);

    // ONE HOUSEHOLD PER CHILD, deliberately: the fatigue caps are per child and
    // per family, and four children in one household would make the fourth
    // notification a test of the daily cap rather than of the tone.
    for (const member of COHORT) {
      const family = await sys('family', () =>
        prisma.family.create({
          data: { name: `PF-tone ${member.label} ${stamp}`, timezone: 'Africa/Cairo' },
          select: { id: true },
        }),
      );
      createdFamilies.push(family.id);
      const user = await sys('user', () =>
        prisma.user.create({
          data: {
            email: `pf.tone.${member.label}.${stamp}@example.test`,
            passwordHash: 'x',
            fullName: 'PF',
            locale: 'ar',
          },
          select: { id: true },
        }),
      );
      createdUsers.push(user.id);
      await sys('membership', () =>
        prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
      );
      const child = await sys('child', () =>
        prisma.child.create({
          data: {
            familyId: family.id,
            firstName: 'محمد',
            dateOfBirth: new Date(`${member.dob}T00:00:00.000Z`),
          },
          select: { id: true },
        }),
      );
      cohort[member.label] = { familyId: family.id, childId: child.id };
    }
  }, 90_000);

  afterAll(async () => {
    for (const id of createdFamilies) {
      await sys('cleanup family', () => prisma.family.delete({ where: { id } })).catch(() => undefined);
    }
    for (const id of createdUsers) {
      await sys('cleanup user', () => prisma.user.delete({ where: { id } })).catch(() => undefined);
    }
    await app?.close();
  }, 60_000);

  const fireStreak = (label: string, familyId: string, childId: string) =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'phase-f-tone' }, () =>
      engine.handleEvent({
        familyId,
        childId,
        eventType: 'STREAK_ACHIEVED',
        sourceEventId: `evt:${stamp}:tone:${label}`,
        trigger: 'STREAK_WATCH',
        streak: { days: 9, atRisk: false, hoursUntilBreak: null },
        now: AFTERNOON,
      }),
    );

  it('the SAME event produces FOUR different Arabic sentences for four ages', async () => {
    const bodies: Record<string, string> = {};

    for (const member of COHORT) {
      const { familyId, childId } = cohort[member.label];
      const result = await fireStreak(member.label, familyId, childId);

      expect(result.outcome?.decision).toBe('SEND');
      expect(result.decision.targetAudience).toBe('CHILD');

      const messages = await childMessageRows(familyId);
      expect(messages).toHaveLength(1);
      // The approval gate is intact for every age.
      expect(messages[0].approval_status).toBe('PENDING');
      bodies[member.label] = messages[0].body;

      // The band the LEDGER recorded is the band the child's own date of birth
      // implies, computed on the family's calendar — not a default and not the
      // container's clock.
      const [decision] = await decisionRows(familyId);
      expect(decision.age_band).toBe(member.tone);
      expect(decision.locale).toBe('ar');
    }

    // FOUR DISTINCT SENTENCES. This is the assertion the whole file exists for.
    const distinct = new Set(Object.values(bodies));
    expect(distinct.size).toBe(4);

    // And the direction is right: language grows with the child, never shrinks.
    const lengths = COHORT.map((m) => bodies[m.label].split(/\s+/).length);
    expect(lengths[0]).toBeLessThanOrEqual(lengths[3]);

    // The youngest gets the playful register (an emoji); the oldest does not.
    const emoji = /\p{Extended_Pictographic}/u;
    expect(emoji.test(bodies.six)).toBe(true);
    expect(emoji.test(bodies.sixteen)).toBe(false);

    // Every one of them is Arabic with Arabic-Indic digits — never «9 أيام».
    for (const body of Object.values(bodies)) {
      expect(body).toMatch(/[؀-ۿ]/);
      expect(body).not.toMatch(/[0-9]/);
      expect(body).toContain('٩');
    }
  });

  it('every delivered child sentence fits THAT child’s own safety ceiling', async () => {
    // The composition rule stated in `notification-tone.ts`: the tone band
    // chooses the words and the SAFETY band bounds them, and where they
    // disagree — the nine-year-old and the twelve-year-old here — the safety
    // band wins. Re-validated against the row that was actually written, not
    // against the template that was meant to be.
    for (const member of COHORT) {
      const messages = await childMessageRows(cohort[member.label].familyId);
      expect(messages).toHaveLength(1);
      const profile = ageBandProfile(member.safety);
      const verdict = safety.validate(messages[0].body, member.safety);
      expect({ label: member.label, reasons: verdict.reasons }).toEqual({
        label: member.label,
        reasons: [],
      });
      expect(messages[0].body.length).toBeLessThanOrEqual(profile.maxChars);
    }
  });

  it('a child-facing sentence never contains a raw backend enum, at any age', async () => {
    // The `parent-app` risk-enum defect in its child form. `STREAK_ACHIEVED`
    // is a database value; «سلسلتك» is what a child reads.
    for (const member of COHORT) {
      const messages = await childMessageRows(cohort[member.label].familyId);
      expect(messages[0].title).not.toMatch(/[A-Z][A-Z0-9]*_[A-Z0-9_]+/);
      expect(messages[0].body).not.toMatch(/[A-Z][A-Z0-9]*_[A-Z0-9_]+/);
      expect(messages[0].body).not.toContain('STREAK_ACHIEVED');
    }
  });

  it('a redelivery to any of the four children still writes ZERO extra rows', async () => {
    for (const member of COHORT) {
      const { familyId, childId } = cohort[member.label];
      await fireStreak(member.label, familyId, childId);
      expect(await childMessageRows(familyId)).toHaveLength(1);
      expect(await decisionRows(familyId)).toHaveLength(1);
    }
  });
});
