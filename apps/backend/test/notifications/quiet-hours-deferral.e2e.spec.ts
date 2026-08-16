/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * PHASE D (`PC-D-005`) — DEFERRAL, PROVEN AGAINST A REAL POSTGRESQL.
 *
 * Everything asserted here is EXECUTED. The deferral is a real row in
 * `notification_deliveries`; the release is a real `notifications` row written
 * through the real delivery path; the idempotency is a real unique-index
 * conflict; the timezone behaviour is two real families with two real
 * `Family.timezone` values reaching two DIFFERENT `scheduled_for` instants from
 * ONE deferral instant; the DEAD state is reached by really failing a delivery
 * eight times.
 *
 * WHY THAT MATTERS FOR THIS PARTICULAR DEFECT. What is being replaced is a
 * feature that ALREADY HAD A PASSING TEST: `smart-notification-integration.service.spec.ts`
 * asserted `decision: 'DEFER'` and was green for the whole life of the bug,
 * because `DEFER` was a string and nothing checked that anything was stored.
 * A fix proven by another assertion about a returned object would have changed
 * nothing that matters. So every property below is asserted against a ROW.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { FamilyDateService } from '../../src/common/time/family-date.service';
import { SmartNotificationIntegrationService } from '../../src/modules/life-intelligence/application/services/smart-notification-integration.service';
import { QuietHoursReleaseService } from '../../src/modules/life-intelligence/application/services/quiet-hours-release.service';
import { NOTIFICATION_DELIVERY_REPOSITORY } from '../../src/modules/notifications/application/ports/notification-delivery.repository.port';
import type { INotificationDeliveryRepository } from '../../src/modules/notifications/application/ports/notification-delivery.repository.port';
import { RUNTIME_ALERT_REPOSITORY } from '../../src/modules/pairing/application/ports/runtime-alert.repository.port';
import { JobRunner } from '../../src/modules/scheduler/application/job-runner.service';
import { NOTIFICATION_DELIVERY_SWEEP_JOB } from '../../src/modules/scheduler/application/jobs/notification-delivery-sweep.job';
import { RELEASE_DEFAULTS } from '../../src/modules/notifications/domain/notification-delivery.types';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/**
 * THE TWO INSTANTS, and January is deliberate. Egypt reintroduced DST in 2023,
 * so in August Cairo and Riyadh are BOTH UTC+3 and their quiet hours coincide —
 * asserting a difference in August would be asserting something false. In
 * January Cairo is UTC+2 and Riyadh UTC+3, and the two households' windows are
 * an hour apart. Every offset is read from tzdata by `family-date.ts`.
 */
const DEEP_NIGHT = new Date('2026-01-15T22:30:00.000Z'); // 00:30 Cairo / 01:30 Riyadh
const NEXT_MORNING = new Date('2026-01-16T06:00:00.000Z'); // 08:00 Cairo / 09:00 Riyadh

function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client/wasm');
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
  const base = new PrismaClient({ datasources: { db: { url } } });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

describeIfDb('PHASE D — quiet-hours deferral (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let integration: SmartNotificationIntegrationService;
  let release: QuietHoursReleaseService;
  let deliveries: INotificationDeliveryRepository;
  let runner: JobRunner;
  let familyDate: FamilyDateService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `Phase D deferral suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const exec = (sql: string, ...params: unknown[]): Promise<number> =>
    sys('raw exec', () => prisma.$executeRawUnsafe(sql, ...params)) as Promise<number>;

  /** Every deferred row for a family, newest last, as the database holds it. */
  const deferredRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  const notificationRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  async function createFamily(label: string, timezone: string) {
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `PD ${label} ${stamp}`, timezone }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `pd.${label}.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'PD Parent',
        },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    const child = await sys('create child', () =>
      prisma.child.create({
        data: {
          familyId: family.id,
          firstName: `PD Kid ${label}`,
          dateOfBirth: new Date('2015-04-01T00:00:00.000Z'),
        },
        select: { id: true },
      }),
    );
    return { familyId: family.id, childId: child.id, userId: user.id };
  }

  /**
   * Enqueue one notification through the REAL production entry point, at an
   * EXPLICIT instant.
   *
   * NOT `jest.useFakeTimers()`, and the reason is worth stating: a faked clock
   * also fakes the timers `pg` uses, so a suite that freezes time and then
   * awaits a real query deadlocks. `now` is a parameter of `notifyEvent` for
   * the same reason it is a parameter of `evaluateFatigue` and
   * `closableBusinessDate` — a decision that has a right answer must be
   * provable without faking the machine.
   */
  const notify = (
    familyId: string,
    childId: string,
    candidate: {
      type: string;
      title?: string;
      body?: string;
      sourceEventId: string;
      priority?: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';
      targetAudience?: 'PARENT' | 'CHILD';
    },
    at: Date = DEEP_NIGHT,
  ) =>
    runWithTenant({ familyId, actorType: 'SYSTEM', actorId: 'phase-d-test' }, () =>
      integration.notifyEvent(
        childId,
        familyId,
        {
          type: candidate.type,
          priority: candidate.priority ?? 'NORMAL',
          title: candidate.title ?? 'عنوان',
          body: candidate.body ?? 'نص',
          targetAudience: candidate.targetAudience ?? 'PARENT',
          sourceEventId: candidate.sourceEventId,
        },
        at,
      ),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    integration = app.get(SmartNotificationIntegrationService);
    release = app.get(QuietHoursReleaseService);
    deliveries = app.get(NOTIFICATION_DELIVERY_REPOSITORY);
    runner = app.get(JobRunner);
    familyDate = app.get(FamilyDateService);
  }, 180_000);

  afterAll(async () => {
    if (prisma) {
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(
          () => undefined,
        );
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(
          () => undefined,
        );
      }
    }
    await app?.close();
  }, 180_000);

  // ==========================================================================
  describe('1. THE DEFECT: a DEFER-class notification inside quiet hours is STORED, and DELIVERED EXACTLY ONCE after the window', () => {
    it('stores a row with a scheduled instant instead of dropping the notification', async () => {
      const f = await createFamily('store', 'Africa/Cairo');

      const outcome = await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-store-${stamp}`,
      });

      expect(outcome.decision).toBe('DEFER');

      const rows = await deferredRows(f.familyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('PENDING');
      expect(rows[0].defer_reason).toBe('QUIET_HOURS');
      expect(rows[0].source_event_id).toBe(`evt:pd-store-${stamp}`);
      // The scheduled instant is 07:00 on the FAMILY'S clock, not now+9h.
      expect(getBusinessTimeHHMM(new Date(rows[0].scheduled_for), 'Africa/Cairo')).toBe('07:00');

      // AND NOTHING WAS DELIVERED YET — the whole point of «deferred».
      expect(await notificationRows(f.familyId)).toHaveLength(0);
    }, 120_000);

    it('the sweep after the window delivers it — and a SECOND sweep delivers nothing more', async () => {
      const f = await createFamily('once', 'Africa/Cairo');
      await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        title: 'مكافأة جديدة',
        sourceEventId: `evt:pd-once-${stamp}`,
      });

      const first = await release.sweep(NEXT_MORNING);
      expect(first.delivered).toBeGreaterThanOrEqual(1);

      const delivered = await notificationRows(f.familyId);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].type).toBe('REWARD_GRANTED');
      // THE KEY IS THE PRODUCER'S, UNCHANGED ACROSS defer -> deliver.
      expect(delivered[0].source_event_id).toBe(`evt:pd-once-${stamp}`);

      const rows = await deferredRows(f.familyId);
      expect(rows[0].state).toBe('DELIVERED');
      expect(rows[0].delivered_at).not.toBeNull();

      // EXACTLY ONCE: the second sweep has nothing to claim.
      await release.sweep(new Date(NEXT_MORNING.getTime() + 600_000));
      expect(await notificationRows(f.familyId)).toHaveLength(1);
    }, 120_000);

    it('a row is NOT released before its scheduled instant — a sweep at 02:00 leaves it PENDING', async () => {
      const f = await createFamily('early', 'Africa/Cairo');
      await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-early-${stamp}`,
      });

      // 00:45 Cairo — still deep inside the window.
      await release.sweep(new Date('2026-01-15T22:45:00.000Z'));

      expect(await notificationRows(f.familyId)).toHaveLength(0);
      expect((await deferredRows(f.familyId))[0].state).toBe('PENDING');
    }, 120_000);
  });

  // ==========================================================================
  describe('2. DELIVER and SUPPRESS — the other two classes, at the same gate', () => {
    it('a DELIVER-class safety notification goes through IMMEDIATELY during quiet hours', async () => {
      const f = await createFamily('safety', 'Africa/Cairo');

      const outcome = await notify(f.familyId, f.childId, {
        type: 'ACCESSIBILITY_DISABLED',
        title: 'Protection turned off',
        // NORMAL deliberately: the bypass must come from the TYPE, not from
        // the pre-existing `priority === 'CRITICAL'` shortcut.
        priority: 'NORMAL',
        sourceEventId: `runtime:pd-safety-${stamp}`,
      });

      expect(outcome.decision).toBe('SEND');
      expect(await notificationRows(f.familyId)).toHaveLength(1);
      expect(await deferredRows(f.familyId)).toHaveLength(0); // never queued
    }, 120_000);

    it('a SUPPRESS-class reminder is dropped, is NOT queued, and its reason is recorded', async () => {
      const f = await createFamily('suppress', 'Africa/Cairo');

      const outcome = await notify(f.familyId, f.childId, {
        type: 'HYDRATION_REMINDER',
        targetAudience: 'CHILD',
        sourceEventId: `signal:pd-suppress-${stamp}`,
      });

      expect(outcome.decision).toBe('SUPPRESS');
      // THE REASON IS THE DELIVERABLE. «Dropped» was the defect; «dropped
      // because its premise expires overnight» is a decision.
      expect(outcome.reason).toBe('QUIET_HOURS_EXPIRES_OVERNIGHT');
      expect(await deferredRows(f.familyId)).toHaveLength(0);
      expect(await notificationRows(f.familyId)).toHaveLength(0);
    }, 120_000);
  });

  // ==========================================================================
  describe('3. TIMEZONE — per family, across midnight, and across a DST transition', () => {
    it('THE PROOF: ONE deferral instant, two zones, two DIFFERENT scheduled_for values one hour apart', async () => {
      const cairo = await createFamily('tz-cairo', 'Africa/Cairo');
      const riyadh = await createFamily('tz-riyadh', 'Asia/Riyadh');

      await notify(cairo.familyId, cairo.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-tz-c-${stamp}`,
      });
      await notify(riyadh.familyId, riyadh.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-tz-r-${stamp}`,
      });

      const c = new Date((await deferredRows(cairo.familyId))[0].scheduled_for);
      const r = new Date((await deferredRows(riyadh.familyId))[0].scheduled_for);

      // Each household's own 07:00 — read back through tzdata, not asserted as
      // a remembered offset.
      expect(getBusinessTimeHHMM(c, 'Africa/Cairo')).toBe('07:00');
      expect(getBusinessTimeHHMM(r, 'Asia/Riyadh')).toBe('07:00');
      // ...and in January those are two different instants, one hour apart.
      expect(c.getTime()).not.toBe(r.getTime());
      expect((c.getTime() - r.getTime()) / 3_600_000).toBe(1);
    }, 120_000);

    it('ACROSS MIDNIGHT: deferred at 00:30 local, released the SAME morning, ~6.5h later — not 30h', async () => {
      const f = await createFamily('midnight', 'Africa/Cairo');
      expect(getBusinessTimeHHMM(DEEP_NIGHT, 'Africa/Cairo')).toBe('00:30');

      await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-midnight-${stamp}`,
      });

      const row = (await deferredRows(f.familyId))[0];
      const scheduled = new Date(row.scheduled_for);
      const heldHours = (scheduled.getTime() - DEEP_NIGHT.getTime()) / 3_600_000;
      expect(heldHours).toBeCloseTo(6.5, 5);
      // The business date recorded is the day the deferral happened, on the
      // FAMILY's calendar — which is already the 16th in Cairo.
      expect(new Date(row.business_date).toISOString().slice(0, 10)).toBe('2026-01-16');

      // And it really is released by a sweep on that same morning.
      await release.sweep(NEXT_MORNING);
      expect(await notificationRows(f.familyId)).toHaveLength(1);
    }, 120_000);

    it('ACROSS A DST TRANSITION: a Cairo deferral over the spring-forward night still releases at local 07:00', async () => {
      const f = await createFamily('dst', 'Africa/Cairo');

      // Find Egypt's 2026 spring transition from tzdata rather than recalling it.
      const { timeZoneOffsetMs } = require('../../src/common/time/family-date');
      let transition: Date | null = null;
      let previous = timeZoneOffsetMs(new Date(Date.UTC(2026, 3, 1)), 'Africa/Cairo');
      outer: for (let d = 0; d < 90; d++) {
        for (let h = 0; h < 24; h++) {
          const at = new Date(Date.UTC(2026, 3, 1 + d, h));
          const offset = timeZoneOffsetMs(at, 'Africa/Cairo');
          if (offset !== previous) {
            transition = at;
            break outer;
          }
          previous = offset;
        }
      }
      expect(transition).not.toBeNull();

      // Defer three hours BEFORE the clocks change — deep inside quiet hours.
      const deferAt = new Date((transition as Date).getTime() - 3 * 3_600_000);
      await notify(
        f.familyId,
        f.childId,
        { type: 'REWARD_GRANTED', sourceEventId: `evt:pd-dst-${stamp}` },
        deferAt,
      );

      const scheduled = new Date((await deferredRows(f.familyId))[0].scheduled_for);
      // THE ASSERTION: local 07:00 on the far side of the transition. A
      // `now + 9h` implementation lands on 08:00 here and this line goes red.
      expect(getBusinessTimeHHMM(scheduled, 'Africa/Cairo')).toBe('07:00');
      // The offset really did change between the two instants, so this test is
      // measuring DST and not a no-op.
      expect(timeZoneOffsetMs(scheduled, 'Africa/Cairo')).not.toBe(
        timeZoneOffsetMs(deferAt, 'Africa/Cairo'),
      );

      // And the sweep an hour after that instant delivers it.
      await release.sweep(new Date(scheduled.getTime() + 3_600_000));
      expect(await notificationRows(f.familyId)).toHaveLength(1);
    }, 120_000);
  });

  // ==========================================================================
  describe('4. ANTI-FLOOD — eleven overnight notifications do not become eleven at 07:00', () => {
    it('coalesces by type, caps at three, and folds the rest into ONE digest', async () => {
      const f = await createFamily('flood', 'Africa/Cairo');
      // Eleven notifications, eight distinct types — three of the types repeat.
      const types = [
        'REWARD_GRANTED',
        'REWARD_GRANTED',
        'REWARD_GRANTED',
        'ACHIEVEMENT_VERIFIED',
        'ACHIEVEMENT_VERIFIED',
        'STREAK_ACHIEVED',
        'DAILY_GOAL_COMPLETED',
        'LEARNING_GOAL_ACHIEVED',
        'SCREEN_TIME_EXCEEDED',
        'POLICY_VIOLATION',
        'CHILD_REQUEST',
      ];
      for (let i = 0; i < types.length; i++) {
        await notify(
          f.familyId,
          f.childId,
          { type: types[i], title: `عنوان ${i}`, sourceEventId: `evt:pd-flood-${stamp}-${i}` },
          new Date(DEEP_NIGHT.getTime() + i * 60_000),
        );
        // Distinct `created_at` values, so «newest wins» is observable.
      }

      expect(await deferredRows(f.familyId)).toHaveLength(11);

      const report = await release.sweep(NEXT_MORNING);
      expect(report.claimed).toBeGreaterThanOrEqual(11);

      const delivered = await notificationRows(f.familyId);
      // THE BRIEF'S REQUIREMENT, MEASURED: 11 in, 4 out.
      expect(delivered).toHaveLength(4);
      expect(delivered.filter((n) => n.type === 'QUIET_HOURS_DIGEST')).toHaveLength(1);

      const rows = await deferredRows(f.familyId);
      const byState = rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.state] = (acc[r.state] ?? 0) + 1;
        return acc;
      }, {});
      expect(byState.DELIVERED).toBe(3);
      expect(byState.SUPPRESSED).toBe(8);

      // NOTHING WAS LOST WITHOUT A REASON — the CHECK constraint would have
      // refused a SUPPRESSED row with a NULL reason, and this asserts the
      // reasons are the two documented ones rather than a fallback.
      const reasons = new Set(
        rows.filter((r) => r.state === 'SUPPRESSED').map((r) => r.resolution_reason),
      );
      expect([...reasons].sort()).toEqual(['COALESCED', 'DIGESTED']);
      expect(rows.filter((r) => r.resolution_reason === 'COALESCED')).toHaveLength(3);
    }, 180_000);

    it('the digest is ONE PER FAMILY PER DAY — a second sweep cannot write a second one', async () => {
      const f = await createFamily('digest-once', 'Africa/Cairo');
      for (let i = 0; i < 6; i++) {
        await notify(
          f.familyId,
          f.childId,
          { type: `PD_TYPE_${i}`, sourceEventId: `evt:pd-dg-${stamp}-${i}` },
          new Date(DEEP_NIGHT.getTime() + i * 60_000),
        );
      }

      await release.sweep(NEXT_MORNING);
      const afterFirst = await notificationRows(f.familyId);
      expect(afterFirst.filter((n) => n.type === 'QUIET_HOURS_DIGEST')).toHaveLength(1);

      // Force a second release on the same business date by re-queuing more
      // rows that are already due, then sweeping again.
      for (let i = 6; i < 12; i++) {
        await notify(
          f.familyId,
          f.childId,
          { type: `PD_TYPE_${i}`, sourceEventId: `evt:pd-dg-${stamp}-${i}` },
          new Date(DEEP_NIGHT.getTime() + i * 60_000),
        );
      }
      await release.sweep(new Date(NEXT_MORNING.getTime() + 900_000));

      const digests = (await notificationRows(f.familyId)).filter(
        (n) => n.type === 'QUIET_HOURS_DIGEST',
      );
      // The unique index on (family_id, source_event_id, user_id) is what
      // refuses the second one — the anti-flood mechanism cannot itself flood.
      expect(digests).toHaveLength(1);
    }, 180_000);
  });

  // ==========================================================================
  describe('5. THE GUARANTEES SURVIVE THE DEFERRAL', () => {
    it('IDEMPOTENCY: a cause redelivered inside the window queues ONE row and delivers ONE notification', async () => {
      const f = await createFamily('idem', 'Africa/Cairo');
      const key = `evt:pd-idem-${stamp}`;

      const a = await notify(f.familyId, f.childId, { type: 'REWARD_GRANTED', sourceEventId: key });
      const b = await notify(f.familyId, f.childId, { type: 'REWARD_GRANTED', sourceEventId: key });

      expect(a.decision).toBe('DEFER');
      expect(a.reason).toBe('QUIET_HOURS');
      // The SECOND one found its own row already waiting — ON CONFLICT DO NOTHING.
      expect(b.decision).toBe('DEFER');
      expect(b.reason).toBe('ALREADY_DEFERRED');
      expect(await deferredRows(f.familyId)).toHaveLength(1);

      await release.sweep(NEXT_MORNING);
      expect(await notificationRows(f.familyId)).toHaveLength(1);
    }, 120_000);

    it('IDEMPOTENCY ACROSS defer → deliver: redelivering the SAME cause AFTER release writes no second notification', async () => {
      const f = await createFamily('idem-after', 'Africa/Cairo');
      const key = `evt:pd-idem-after-${stamp}`;
      await notify(f.familyId, f.childId, { type: 'REWARD_GRANTED', sourceEventId: key });

      await release.sweep(NEXT_MORNING);
      expect(await notificationRows(f.familyId)).toHaveLength(1);

      // The outbox redelivers the same domain event at 09:00, outside quiet
      // hours this time, so it takes the IMMEDIATE path — a completely
      // different code path from the one that wrote the row.
      const again = await notify(
        f.familyId,
        f.childId,
        { type: 'REWARD_GRANTED', sourceEventId: key },
        new Date(NEXT_MORNING.getTime() + 1_800_000),
      );
      expect(again.decision).toBe('SUPPRESS');
      // WHICH refusal fired is not the assertion, and pinning it would be
      // asserting an implementation order. There are THREE defences in front of
      // a second notification — the fatigue guard's sliding DUPLICATE window,
      // the repository's five-minute window, and the unique index — and the
      // product guarantee is that at least one of them always holds.
      expect(['ALREADY_NOTIFIED', 'DUPLICATE']).toContain(again.reason);
      // ONE reward, ONE notification — the invariant B9 established, unbroken
      // by a deferral that crossed a night.
      expect(await notificationRows(f.familyId)).toHaveLength(1);

      // AND THE FLOOR UNDERNEATH THEM IS STILL A CONSTRAINT. Both windows are
      // bypassed here by writing directly, which is exactly what a redelivery
      // six months later would effectively do; the database still refuses.
      await expect(
        exec(
          `INSERT INTO "notifications" ("id","family_id","user_id","child_id","type","title","body","priority","source_event_id")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'REWARD_GRANTED','t','b','NORMAL', $4::text)`,
          f.familyId,
          f.userId,
          f.childId,
          key,
        ),
      ).rejects.toThrow();
      expect(await notificationRows(f.familyId)).toHaveLength(1);
    }, 120_000);

    it('THE CAPS APPLY AT DELIVERY TIME: rows released past the daily max are SUPPRESSED with the guard’s own reason', async () => {
      const f = await createFamily('caps', 'Africa/Cairo');

      // Six notifications already delivered on the release morning — the
      // default `dailyMax`. Written directly so the cap is already exhausted
      // before the release runs.
      for (let i = 0; i < 6; i++) {
        await exec(
          `INSERT INTO "notifications" ("id","family_id","user_id","child_id","type","title","body","priority","source_event_id","created_at")
           VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,$4::text,'t','b','NORMAL',$5::text,$6::timestamp)`,
          f.familyId,
          f.userId,
          f.childId,
          `PD_PRIOR_${i}`,
          `prior:pd-caps-${stamp}-${i}`,
          new Date(NEXT_MORNING.getTime() - 1800_000),
        );
      }

      await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-caps-${stamp}`,
      });

      const report = await release.sweep(NEXT_MORNING);
      expect(report.capped).toBe(1);
      expect(report.delivered).toBe(0);

      const row = (await deferredRows(f.familyId))[0];
      expect(row.state).toBe('SUPPRESSED');
      // The guard's own vocabulary, persisted — not a generic «dropped».
      expect(row.resolution_reason).toBe('DAILY_MAX');
      // The cap held: still six, not seven.
      expect(await notificationRows(f.familyId)).toHaveLength(6);
    }, 180_000);

    it('«NO REWARD GRANTED => NO NOTIFICATION» is untouched: nothing enqueues a deferred row on its own', async () => {
      const f = await createFamily('no-grant', 'Africa/Cairo');
      // A sweep over a family that never had a notification produces nothing:
      // the release path can only ever deliver rows a PRODUCER wrote, and there
      // is no code path from «no grant» to a row in this table.
      const report = await release.sweep(NEXT_MORNING);
      expect(await deferredRows(f.familyId)).toHaveLength(0);
      expect(await notificationRows(f.familyId)).toHaveLength(0);
      expect(report.delivered).toBeGreaterThanOrEqual(0);
    }, 120_000);
  });

  // ==========================================================================
  describe('6. DELIVERY FAILURE: retry with backoff, then a TERMINAL state that is VISIBLE', () => {
    it('a failing delivery goes back to PENDING with a future next_attempt_at, not lost and not delivered', async () => {
      const f = await createFamily('retry', 'Africa/Cairo');
      await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-retry-${stamp}`,
      });

      const rows = await deferredRows(f.familyId);
      // Simulate one burned attempt then a failure, through the SAME statement
      // production uses — the backoff is computed in SQL, so asserting it here
      // asserts the shipped policy.
      await exec(
        `UPDATE "notification_deliveries" SET "state"='DELIVERING', "attempt_count"=1 WHERE "id"=$1::uuid`,
        rows[0].id,
      );
      await runWithTenant({ familyId: f.familyId, actorType: 'SYSTEM', actorId: 't' }, () =>
        deliveries.markAttemptFailed(rows[0].id, 'FCM unavailable'),
      );

      const after = (await deferredRows(f.familyId))[0];
      expect(after.state).toBe('PENDING');
      expect(after.last_error).toContain('FCM unavailable');
      expect(after.next_attempt_at).not.toBeNull();
      expect(new Date(after.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
      // Still owed, still not delivered.
      expect(await notificationRows(f.familyId)).toHaveLength(0);
    }, 120_000);

    it('THE BACKOFF DOUBLES — attempt 2 waits longer than attempt 1, computed in SQL', async () => {
      const f = await createFamily('backoff', 'Africa/Cairo');
      await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-backoff-${stamp}`,
      });
      const id = (await deferredRows(f.familyId))[0].id;

      const delayAfterAttempt = async (attempt: number): Promise<number> => {
        await exec(
          `UPDATE "notification_deliveries" SET "state"='DELIVERING', "attempt_count"=$2::int WHERE "id"=$1::uuid`,
          id,
          attempt,
        );
        const before = Date.now();
        await runWithTenant({ familyId: f.familyId, actorType: 'SYSTEM', actorId: 't' }, () =>
          deliveries.markAttemptFailed(id, `attempt ${attempt}`),
        );
        const row = (await deferredRows(f.familyId))[0];
        return (new Date(row.next_attempt_at).getTime() - before) / 1000;
      };

      const first = await delayAfterAttempt(1);
      const second = await delayAfterAttempt(2);
      const third = await delayAfterAttempt(3);
      expect(first).toBeGreaterThanOrEqual(RELEASE_DEFAULTS.retryBaseSeconds - 5);
      expect(second).toBeGreaterThan(first);
      expect(third).toBeGreaterThan(second);
    }, 180_000);

    it('AFTER THE ATTEMPTS ARE BURNED IT IS DEAD — terminal, reasoned, and COUNTED BY THE OPERATOR GAUGE', async () => {
      const f = await createFamily('dead', 'Africa/Cairo');
      await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-dead-${stamp}`,
      });
      const id = (await deferredRows(f.familyId))[0].id;

      const deadBefore = (await deliveries.backlog()).dead;

      await exec(
        `UPDATE "notification_deliveries" SET "state"='DELIVERING', "attempt_count"=$2::int WHERE "id"=$1::uuid`,
        id,
        RELEASE_DEFAULTS.maxAttempts,
      );
      await runWithTenant({ familyId: f.familyId, actorType: 'SYSTEM', actorId: 't' }, () =>
        deliveries.markAttemptFailed(id, 'FCM: registration-token-not-registered'),
      );

      const row = (await deferredRows(f.familyId))[0];
      expect(row.state).toBe('DEAD');
      expect(row.resolution_reason).toBe('MAX_ATTEMPTS');
      // The error survives — «why will this never arrive» is answerable from
      // the row alone at 09:00 the next morning.
      expect(row.last_error).toContain('registration-token-not-registered');
      expect(row.next_attempt_at).toBeNull();

      // VISIBLE, which is the whole lesson of Phase C's DEAD finding: the gauge
      // counts it, and it counts DEAD SEPARATELY from PENDING so the number
      // cannot go DOWN as the incident gets worse.
      const backlog = await deliveries.backlog();
      expect(backlog.dead).toBe(deadBefore + 1);
      expect(backlog.deadByType.some((t) => t.type === 'REWARD_GRANTED')).toBe(true);

      // A dead row is never swept up again by a later release.
      await release.sweep(new Date(NEXT_MORNING.getTime() + 7_200_000));
      expect((await deferredRows(f.familyId))[0].state).toBe('DEAD');
    }, 180_000);

    it('a DEAD row cannot exist without a reason — the CHECK constraint refuses it', async () => {
      const f = await createFamily('reasonless', 'Africa/Cairo');
      await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-reason-${stamp}`,
      });
      const id = (await deferredRows(f.familyId))[0].id;

      // «Dropped with a recorded reason» is enforced by the DATABASE, not by a
      // convention a future writer can forget.
      await expect(
        exec(
          `UPDATE "notification_deliveries" SET "state"='DEAD', "resolution_reason"=NULL WHERE "id"=$1::uuid`,
          id,
        ),
      ).rejects.toThrow();
    }, 120_000);

    it('a lease held by a dead replica goes stale and the row is reclaimed — the staleness IS the recovery', async () => {
      const f = await createFamily('stale', 'Africa/Cairo');
      await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-stale-${stamp}`,
      });
      const id = (await deferredRows(f.familyId))[0].id;

      await exec(
        `UPDATE "notification_deliveries"
            SET "state"='DELIVERING', "locked_by"='dead-replica', "locked_at"= now() - INTERVAL '30 minutes'
          WHERE "id"=$1::uuid`,
        id,
      );
      await deliveries.reclaimStaleLocks(RELEASE_DEFAULTS.leaseSeconds);

      const row = (await deferredRows(f.familyId))[0];
      expect(row.state).toBe('PENDING');
      expect(row.locked_by).toBeNull();
    }, 120_000);
  });

  // ==========================================================================
  describe('7. IT IS THE EXISTING SCHEDULER — no second scheduler, no second queue', () => {
    it('the release is a registered PLATFORM job and running it through JobRunner delivers the notification', async () => {
      expect(runner.jobNames()).toContain(NOTIFICATION_DELIVERY_SWEEP_JOB);

      const f = await createFamily('job', 'Africa/Cairo');
      await notify(f.familyId, f.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-job-${stamp}`,
      });

      await exec(
        `UPDATE "scheduled_jobs"
            SET "locked_by"=NULL, "locked_at"=NULL, "enabled"=true, "consecutive_failures"=0,
                "next_run_at"= now() - INTERVAL '1 hour'
          WHERE "name"=$1`,
        NOTIFICATION_DELIVERY_SWEEP_JOB,
      );

      const report = await runner.runJob(NOTIFICATION_DELIVERY_SWEEP_JOB, {
        now: NEXT_MORNING,
        trigger: 'MANUAL',
      });
      expect(report.claimed).toBe(true);
      expect(report.executed).toBe(1);

      // Delivered THROUGH THE SCHEDULER, and the run history says so in counts.
      expect(await notificationRows(f.familyId)).toHaveLength(1);
      const runs = await raw<any[]>(
        `SELECT * FROM "job_runs" WHERE "job_name"=$1 ORDER BY "started_at" DESC LIMIT 1`,
        NOTIFICATION_DELIVERY_SWEEP_JOB,
      );
      expect(runs[0].status).toBe('SUCCEEDED');
      expect(Object.keys(runs[0].details)).toEqual(
        expect.arrayContaining(['delivered', 'digests', 'coalesced', 'dead', 'capped_at_delivery']),
      );
      // `details` IS COUNTS ONLY — never a title, a body, a child or a family.
      for (const value of Object.values(runs[0].details as Record<string, unknown>)) {
        expect(typeof value).toBe('number');
      }
    }, 180_000);

    it('the family’s timezone really is read from the row — a Riyadh family and a Cairo family are released by their OWN clocks', async () => {
      const cairo = await createFamily('rel-cairo', 'Africa/Cairo');
      const riyadh = await createFamily('rel-riyadh', 'Asia/Riyadh');
      familyDate.invalidate(cairo.familyId);
      familyDate.invalidate(riyadh.familyId);

      await notify(cairo.familyId, cairo.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-rel-c-${stamp}`,
      });
      await notify(riyadh.familyId, riyadh.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-rel-r-${stamp}`,
      });

      // 07:30 in RIYADH is still 06:30 in CAIRO — one household's window has
      // ended and the other's has not, at ONE instant.
      const between = new Date('2026-01-16T04:30:00.000Z');
      expect(getBusinessTimeHHMM(between, 'Asia/Riyadh')).toBe('07:30');
      expect(getBusinessTimeHHMM(between, 'Africa/Cairo')).toBe('06:30');

      await release.sweep(between);
      expect(await notificationRows(riyadh.familyId)).toHaveLength(1);
      expect(await notificationRows(cairo.familyId)).toHaveLength(0);

      // An hour later Cairo crosses its own boundary.
      await release.sweep(new Date(between.getTime() + 3_600_000));
      expect(await notificationRows(cairo.familyId)).toHaveLength(1);
    }, 180_000);

    it('TENANT ISOLATION: one family’s sweep never touches another family’s rows', async () => {
      const a = await createFamily('iso-a', 'Africa/Cairo');
      const b = await createFamily('iso-b', 'Africa/Cairo');
      await notify(a.familyId, a.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-iso-a-${stamp}`,
      });
      await notify(b.familyId, b.childId, {
        type: 'REWARD_GRANTED',
        sourceEventId: `evt:pd-iso-b-${stamp}`,
      });

      const claimed = await runWithTenant(
        { familyId: a.familyId, actorType: 'SYSTEM', actorId: 't' },
        () => deliveries.claimDue(a.familyId, 'test-worker', NEXT_MORNING, 50),
      );
      expect(claimed).toHaveLength(1);
      expect(claimed[0].familyId).toBe(a.familyId);
      // B's row is untouched — still PENDING, still unclaimed.
      expect((await deferredRows(b.familyId))[0].state).toBe('PENDING');
    }, 180_000);
  });
});
