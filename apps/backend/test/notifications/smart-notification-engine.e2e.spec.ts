/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * PHASE F (`F6-002` / `F6-004` / `F6-005`) — THE DECISION LAYER, PROVEN AGAINST
 * A REAL POSTGRESQL.
 *
 * WHY EVERY ASSERTION HERE IS AGAINST A ROW. Phase D's own report records the
 * lesson: `smart-notification-integration.service.spec.ts` asserted
 * `decision: 'DEFER'` and was green for the entire life of the bug, because
 * `DEFER` was a string and nothing checked that anything was stored. A phase
 * whose subject is «record why» cannot be proven by asserting on a returned
 * object. So: the notification is a row in `notifications`, the child message is
 * a row in `child_messages`, the deferral is a row in `notification_deliveries`,
 * and the explanation is a row in `notification_decisions` — read back with raw
 * SQL, after the fact.
 *
 * WHAT IS PROVEN HERE:
 *
 *   1. ONE EVENT -> ONE LOGICAL NOTIFICATION -> ONE LEDGER ROW.
 *   2. RETRY -> ZERO DUPLICATES, in every table.
 *   3. CONCURRENT DELIVERY -> ONE, under a real race.
 *   4. REDELIVERY (a different call, minutes later) -> ZERO.
 *   5. THE CHILD SURFACE really writes `child_messages` — `PE-N-001`'s
 *      regression guard, re-asserted through the NEW entry point.
 *   6. MULTI-CHANNEL: parent and child from one cause are ONE LOGICAL
 *      notification each, distinguished by an explicit facet, never by accident.
 *   7. AI REWRITE APPLIED when it succeeds.
 *   8. AI FAILURE -> the deterministic text is STILL DELIVERED.
 *   9. SAFETY REJECTION -> the template ships, the model output does not.
 *  10. QUIET HOURS -> a real deferred row at a family-local instant.
 *  11. THE SCORE AND ITS ARITHMETIC ARE PERSISTED AND READABLE.
 *
 * The provider-swap proof lives in `notification-provider-swap.e2e.spec.ts`,
 * because it needs a second Nest module with a different binding and mixing the
 * two would make «unchanged» unprovable.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { AI_PROVIDER, type IAIProvider } from '../../src/modules/ai-core/domain/ai-provider.port';
import { FamilyCommunicationService } from '../../src/modules/life-intelligence/application/services/family-communication.service';
import { resolveNotificationDestination } from '../../src/modules/notifications/domain/engine/notification-destination';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import type { NotificationEventInput } from '../../src/modules/notification-engine/application/services/notification-context.assembler';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/** January, and Cairo, for `quiet-hours-deferral.e2e.spec.ts`'s reason: in
 * August Cairo and Riyadh are both UTC+3 and a timezone assertion in that month
 * asserts something false. */
const AFTERNOON = new Date('2026-01-15T15:00:00.000Z'); // 17:00 Cairo
const DEEP_NIGHT = new Date('2026-01-15T22:30:00.000Z'); // 00:30 Cairo

/** A controllable AI. `mode` is flipped per test; the default is the state a
 * deployment with no credentials is in. */
const aiStub: { mode: 'ok' | 'throw' | 'unsafe'; calls: number; provider: IAIProvider } = {
  mode: 'ok',
  calls: 0,
  provider: {
    async complete() {
      aiStub.calls += 1;
      if (aiStub.mode === 'throw') throw new Error('every AI provider failed');
      if (aiStub.mode === 'unsafe') return 'أنت كسول ولم تنجز شيئًا اليوم';
      return 'صياغة بديلة من النموذج لهذا الإشعار';
    },
  },
};

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
  const base = new PrismaClient({
    // PRISMA 7: `datasources` was removed from the constructor — driver
    // adapters are the only mode, so the adapter IS the connection. This
    // branch used to exist to AVOID the adapter; it now builds the same
    // client the branch above does, which is the honest end state: a test
    // must not reach the database through a different engine than
    // production does.
    adapter: new (require('@prisma/adapter-pg').PrismaPg)(
      new (require('pg').Pool)({ connectionString: url }),
    ),
  });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

describeIfDb('PHASE F — the smart notification decision layer (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let engine: SmartNotificationEngineService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `Phase F engine suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const notificationRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  const childMessageRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  const decisionRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  const deferredRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  async function createFamily(label: string, timezone = 'Africa/Cairo', dob = '2013-04-01') {
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `PF ${label} ${stamp}`, timezone }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `pf.${label}.${stamp}@example.test`,
          passwordHash: 'x',
          fullName: 'PF Parent',
          locale: 'ar',
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
          firstName: 'محمد',
          dateOfBirth: new Date(`${dob}T00:00:00.000Z`),
        },
        select: { id: true },
      }),
    );
    return { familyId: family.id, childId: child.id, userId: user.id };
  }

  /** The REAL production entry point, at an EXPLICIT instant, inside the tenant
   * context every producer already runs in. Not a fake clock — `pg`'s own timers
   * would be faked with it. */
  const fire = (input: NotificationEventInput) =>
    runWithTenant({ familyId: input.familyId, actorType: 'SYSTEM', actorId: 'phase-f-test' }, () =>
      engine.handleEvent(input),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .overrideProvider(AI_PROVIDER)
      .useValue(aiStub.provider)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    engine = app.get(SmartNotificationEngineService);
  }, 60_000);

  afterAll(async () => {
    delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
    for (const id of createdFamilies) {
      await sys('cleanup family', () => prisma.family.delete({ where: { id } })).catch(() => undefined);
    }
    for (const id of createdUsers) {
      await sys('cleanup user', () => prisma.user.delete({ where: { id } })).catch(() => undefined);
    }
    await app?.close();
  }, 60_000);

  beforeEach(() => {
    aiStub.mode = 'ok';
    aiStub.calls = 0;
    delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
  });

  // ==========================================================================
  // 1. ONE EVENT -> ONE LOGICAL NOTIFICATION -> ONE LEDGER ROW
  // ==========================================================================
  it('one event writes exactly ONE notification row and exactly ONE decision row', async () => {
    const f = await createFamily('one-event');
    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:one-event`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 25, isMilestone: false },
      now: AFTERNOON,
    });

    expect(result.decision.verdict).toBe('SEND');
    expect(result.outcome?.decision).toBe('SEND');

    const notifications = await notificationRows(f.familyId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('REWARD_GRANTED');
    // The copy is the catalogue's, in Arabic, naming the child — never an enum.
    expect(notifications[0].body).toContain('محمد');
    expect(notifications[0].body).not.toContain('REWARD_GRANTED');

    const decisions = await decisionRows(f.familyId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('SEND');
    expect(decisions[0].outcome).toBe('SEND');
    expect(decisions[0].provider_id).toBe('rule-based');
    expect(decisions[0].trigger).toBe('DOMAIN_EVENT');
    expect(decisions[0].target_audience).toBe('PARENT');
    expect(decisions[0].country_code).toBeNull(); // no subscription — an honest absence
  });

  // ==========================================================================
  // 2 + 4 + 9. RETRY, REDELIVERY, DUPLICATE EVENT -> ZERO NEW ROWS
  // ==========================================================================
  it('a retry, a redelivery and a duplicate event all produce ZERO additional rows', async () => {
    const f = await createFamily('retry');
    const cause = `evt:${stamp}:retry`;
    const input: NotificationEventInput = {
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: cause,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 10, isMilestone: false },
      now: AFTERNOON,
    };

    await fire(input);
    // A RETRY: the identical call, immediately.
    const retry = await fire(input);
    // A REDELIVERY: the same cause, twenty minutes later — past the fatigue
    // guard's five-minute duplicate window and past its thirty-minute cooldown
    // would not be, which is exactly why the DATABASE has to be the answer.
    const redelivery = await fire({ ...input, now: new Date(AFTERNOON.getTime() + 20 * 60_000) });

    expect(await notificationRows(f.familyId)).toHaveLength(1);
    expect(await decisionRows(f.familyId)).toHaveLength(1);
    // The ledger refuses the repeat and says so by returning no id — which is
    // how a retry cannot inflate a suppression rate on the dashboard.
    expect(retry.decisionId).toBeNull();
    expect(redelivery.decisionId).toBeNull();
  });

  // ==========================================================================
  // 3. CONCURRENT DELIVERY -> ONE
  // ==========================================================================
  it('eight concurrent deliveries of the same cause write ONE notification and ONE decision', async () => {
    const f = await createFamily('concurrent');
    const cause = `evt:${stamp}:concurrent`;
    const input: NotificationEventInput = {
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: cause,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 10, isMilestone: false },
      now: AFTERNOON,
    };

    // A REAL race. A five-minute window cannot see a concurrent writer; a unique
    // index can, and this is the assertion that says which one is load-bearing.
    await Promise.all(Array.from({ length: 8 }, () => fire(input)));

    expect(await notificationRows(f.familyId)).toHaveLength(1);
    expect(await decisionRows(f.familyId)).toHaveLength(1);
  });

  // ==========================================================================
  // 5. THE CHILD SURFACE — `PE-N-001`'s guard, through the new entry point
  // ==========================================================================
  it('a CHILD-audience event writes a real child_messages row, PENDING, with age-banded Arabic copy', async () => {
    const f = await createFamily('child', 'Africa/Cairo', '2019-01-01'); // 7 years old at AFTERNOON
    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'BADGE_EARNED',
      sourceEventId: `evt:${stamp}:badge`,
      trigger: 'DOMAIN_EVENT',
      variables: { badgeTitle: 'القارئ' },
      now: AFTERNOON,
    });

    expect(result.decision.targetAudience).toBe('CHILD');
    expect(result.outcome?.decision).toBe('SEND');

    const messages = await childMessageRows(f.familyId);
    expect(messages).toHaveLength(1);
    // The approval gate is INTACT. B9 added a constraint, not an exemption.
    expect(messages[0].approval_status).toBe('PENDING');
    expect(messages[0].delivered_at).toBeNull();
    expect(messages[0].source_event_id).toBe(`evt:${stamp}:badge:child`);
    // Nothing landed on `notifications` — the two halves of the surface are
    // genuinely separate, which is the fact `PE-N-001` was hiding behind.
    expect(await notificationRows(f.familyId)).toHaveLength(0);

    const decisions = await decisionRows(f.familyId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].target_audience).toBe('CHILD');
    // A seven-year-old gets the youngest band and its emoji register.
    expect(decisions[0].age_band).toBe('5-7');
    expect(result.body).toContain('القارئ');
  });

  // ==========================================================================
  // 5b. PHASE F1 — THE CHILD'S DESTINATION IS PERSISTED, AND IT CARRIES NO
  //     IDENTIFIER
  //
  // THE GAP THIS CLOSES, MEASURED RATHER THAN INFERRED. `notification-destination.ts`
  // resolves a link for EVERY copy key, child-audience ones included, and
  // `SmartNotificationEngineService` puts it on `data`. The PARENT branch wrote
  // it to `notifications.data`; the CHILD branch — `child_messages`, through
  // the approval gate — had nowhere to put it, so the child's destination was
  // computed and then discarded, and the child app's router, complete and
  // tested, was never fed anything.
  //
  // ASSERTED AGAINST THE ROW, READ BACK OUT OF POSTGRESQL. This file's own
  // header states why: «a phase whose subject is `record why` cannot be proven
  // by asserting on a returned object».
  // ==========================================================================
  it('a CHILD-audience event PERSISTS its destination on child_messages.data — one key, the server\'s own answer, and nobody\'s identifier', async () => {
    const f = await createFamily('child-link', 'Africa/Cairo', '2019-01-01');

    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'BADGE_EARNED',
      sourceEventId: `evt:${stamp}:badge-link`,
      trigger: 'DOMAIN_EVENT',
      variables: { badgeTitle: 'القارئ' },
      /**
       * A DELIBERATELY HOSTILE PRODUCER PAYLOAD, and every field of it is a
       * real shape: `DigitalWellbeingEngineService` spreads a DEVICE-SUPPLIED
       * `metadata` object into `data`, and a producer adding an id to its own
       * payload is one line away on any of these paths. If the child branch
       * copied `data` across, THIS is what a child's device would be handed.
       */
      data: {
        // A DEVICE-CHOSEN SCREEN — and `subscription` is parent-only billing.
        deepLink: 'abny://subscription',
        familyId: f.familyId,
        childId: f.childId,
        userId: f.userId,
        deviceId: 'device-abc123',
        token: 'a-secret-token',
        metadata: { packageName: 'com.example.game', deviceId: 'device-abc123' },
      },
      now: AFTERNOON,
    });

    expect(result.decision.targetAudience).toBe('CHILD');
    expect(result.outcome?.decision).toBe('SEND');

    const messages = await childMessageRows(f.familyId);
    expect(messages).toHaveLength(1);
    const row = messages[0];
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;

    // ===== THE COLUMN IS NO LONGER EMPTY, AND THE TAP LANDS. =====
    expect(data).not.toBeNull();
    // A BADGE IS READ ON THE PROGRESS SURFACE — the badge shelf and the streak
    // counter live there. Pinned to the byte so the next change to this map is
    // deliberate.
    expect(data.deepLink).toBe('abny://progress');

    // ===== AND IT IS THE SAME ANSWER THE RESOLVER GIVES FOR THE COPY KEY THE
    // ===== DECISION ROW NAMES — so the sentence and the destination can never
    // ===== describe different things.
    const decisions = await decisionRows(f.familyId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].target_audience).toBe('CHILD');
    expect(data.deepLink).toBe(
      resolveNotificationDestination({ copyKey: decisions[0].copy_key, audience: 'CHILD' }),
    );

    // ===== ONE KEY. NOT «no identifiers today» — no ROOM for one. =====
    expect(Object.keys(data)).toEqual(['deepLink']);
    const serialised = JSON.stringify(data);
    for (const identifier of [
      f.familyId,
      f.childId,
      f.userId,
      'device-abc123',
      'a-secret-token',
      'com.example.game',
    ]) {
      expect(serialised).not.toContain(identifier);
    }
    // A deep link is a destination, not a capability — so it is also not a
    // place to hide a token.
    expect(serialised).not.toMatch(/token|secret|Bearer|eyJ/i);

    // ===== THE SERVER IS AUTHORITATIVE. The device asked for the parent's
    // ===== billing screen and did not get it — rule 3 refuses a parent-only
    // ===== surface to a child, and the engine's own spread order means the
    // ===== producer never had a vote in the first place.
    expect(serialised).not.toContain('subscription');

    // ===== AND THE APPROVAL GATE IS EXACTLY WHERE IT WAS. A payload must not
    // ===== change delivery semantics: this row still waits for a parent.
    expect(row.approval_status).toBe('PENDING');
    expect(row.delivered_at).toBeNull();
    expect(row.source_event_id).toBe(`evt:${stamp}:badge-link:child`);
  });

  /**
   * THE OTHER HALF, AND IT IS THE HALF A «DOES THE COLUMN FILL?» TEST WOULD
   * MISS: a message that HAS no destination must not acquire one.
   *
   * A parent typing «أحسنت» to their own child names no screen, and neither
   * does any of the thousands of rows written before this column existed.
   * `data` stays SQL NULL for them, which is what keeps that card non-tappable
   * in the child app — and it is why nothing backfills. A link that opens the
   * wrong screen is worse than a card that is not tappable.
   */
  it('a message with no destination stores SQL NULL, and nothing invents one for it', async () => {
    const f = await createFamily('parent-authored');

    await runWithTenant(
      { familyId: f.familyId, actorType: 'USER', actorId: f.userId },
      () =>
        app
          .get(FamilyCommunicationService)
          .sendParentMessage(f.childId, f.familyId, f.userId, 'encouragement', 'رسالة', 'أحسنت يا محمد'),
    );

    const [row] = await raw<any[]>(
      `SELECT "data", "data" IS NULL AS "is_sql_null" FROM "child_messages" WHERE "family_id" = $1::uuid`,
      f.familyId,
    );
    // NOT a stored JSON `null`, which a client would then have to special-case:
    // the absence of a destination is the absence of a value.
    expect(row.is_sql_null).toBe(true);
    expect(row.data).toBeNull();
  });

  // ==========================================================================
  // 6. MULTI-CHANNEL: ONE CAUSE, TWO AUDIENCES, ONE LOGICAL NOTIFICATION EACH
  // ==========================================================================
  it('one cause reaching BOTH audiences writes one row per audience and one decision per audience', async () => {
    const f = await createFamily('multichannel');
    const cause = `evt:${stamp}:both`;

    // The parent facet and the child facet are SEPARATE, EXPLICIT source keys —
    // `notification-source-key.ts` requires «this event notifies twice» to be a
    // sentence someone wrote, not a consequence of `type` being in an index.
    await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `${cause}:parent`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 30, isMilestone: false },
      now: AFTERNOON,
    });
    await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'BADGE_EARNED',
      sourceEventId: `${cause}:badge`,
      trigger: 'DOMAIN_EVENT',
      variables: { badgeTitle: 'المثابر' },
      now: AFTERNOON,
    });

    // Repeating BOTH — the multi-channel retry — still yields one of each.
    await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `${cause}:parent`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 30, isMilestone: false },
      now: AFTERNOON,
    });

    expect(await notificationRows(f.familyId)).toHaveLength(1);
    expect(await childMessageRows(f.familyId)).toHaveLength(1);
    const decisions = await decisionRows(f.familyId);
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.target_audience).sort()).toEqual(['CHILD', 'PARENT']);
  });

  // ==========================================================================
  // 7. AI REWRITE APPLIED
  // ==========================================================================
  it('when AI rephrasing is enabled and succeeds, the model text is delivered and RECORDED as a rewrite', async () => {
    process.env.NOTIFICATION_AI_REPHRASE_ENABLED = 'true';
    aiStub.mode = 'ok';
    const f = await createFamily('ai-ok');

    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:ai-ok`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 15, isMilestone: false },
      now: AFTERNOON,
    });

    expect(aiStub.calls).toBeGreaterThan(0);
    expect(result.aiRewritten).toBe(true);
    expect(result.body).toBe('صياغة بديلة من النموذج لهذا الإشعار');

    const rows = await notificationRows(f.familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('صياغة بديلة من النموذج لهذا الإشعار');
    const decisions = await decisionRows(f.familyId);
    expect(decisions[0].ai_rewritten).toBe(true);
    expect(decisions[0].ai_failed).toBe(false);
  });

  // ==========================================================================
  // 8. AI FAILURE -> THE DETERMINISTIC TEXT IS STILL DELIVERED
  // ==========================================================================
  it('when the AI provider THROWS, the notification is STILL delivered with its deterministic text', async () => {
    process.env.NOTIFICATION_AI_REPHRASE_ENABLED = 'true';
    aiStub.mode = 'throw';
    const f = await createFamily('ai-throw');

    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:ai-throw`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 15, isMilestone: false },
      now: AFTERNOON,
    });

    // §7 OF THE BRIEF, AS A ROW: the AI failed and the notification exists.
    expect(aiStub.calls).toBeGreaterThan(0);
    expect(result.aiRewritten).toBe(false);
    expect(result.aiFailed).toBe(true);
    expect(result.outcome?.decision).toBe('SEND');

    const rows = await notificationRows(f.familyId);
    expect(rows).toHaveLength(1);
    // The deterministic catalogue sentence, complete, in Arabic, with the child
    // named — not a stub, not an empty body, not an error.
    expect(rows[0].body).toContain('محمد');
    expect(rows[0].body).toContain('مكافأة');

    const decisions = await decisionRows(f.familyId);
    expect(decisions[0].ai_failed).toBe(true);
    expect(decisions[0].ai_rewritten).toBe(false);
    expect(decisions[0].outcome).toBe('SEND');
  });

  // ==========================================================================
  // 9. SAFETY REJECTION -> THE TEMPLATE SHIPS
  // ==========================================================================
  it('when the AI returns SHAMING text for a child, safety rejects it and the template is delivered instead', async () => {
    process.env.NOTIFICATION_AI_REPHRASE_ENABLED = 'true';
    aiStub.mode = 'unsafe';
    const f = await createFamily('ai-unsafe', 'Africa/Cairo', '2015-01-01');

    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'BADGE_EARNED',
      sourceEventId: `evt:${stamp}:ai-unsafe`,
      trigger: 'DOMAIN_EVENT',
      variables: { badgeTitle: 'القارئ' },
      now: AFTERNOON,
    });

    expect(aiStub.calls).toBeGreaterThan(0);
    expect(result.aiRewritten).toBe(false);
    // FAIL-CLOSED: the shaming sentence reached nobody.
    expect(result.body).not.toContain('كسول');
    expect(result.body).toContain('القارئ');

    const messages = await childMessageRows(f.familyId);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).not.toContain('كسول');
  });

  // ==========================================================================
  // 10. QUIET HOURS -> A REAL DEFERRED ROW
  // ==========================================================================
  it('inside quiet hours the engine says DEFER and the PIPELINE writes a real deferred row', async () => {
    const f = await createFamily('quiet');
    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:quiet`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 40, isMilestone: true },
      now: DEEP_NIGHT, // 00:30 Cairo
    });

    expect(result.decision.verdict).toBe('DEFER');
    expect(result.decision.reason).toBe('QUIET_HOURS_ACTIVE');
    expect(result.outcome?.decision).toBe('DEFER');

    // The engine did NOT perform the deferral. The pipeline did, into the table
    // Phase D built, at an instant computed on THIS family's calendar.
    const deferred = await deferredRows(f.familyId);
    expect(deferred).toHaveLength(1);
    expect(deferred[0].state).toBe('PENDING');
    expect(deferred[0].defer_reason).toBe('QUIET_HOURS');
    // 07:00 Cairo on the 16th = 05:00 UTC in January (UTC+2).
    expect(new Date(deferred[0].scheduled_for).toISOString()).toBe('2026-01-16T05:00:00.000Z');
    // And nothing was delivered yet.
    expect(await notificationRows(f.familyId)).toHaveLength(0);

    const decisions = await decisionRows(f.familyId);
    expect(decisions[0].decision).toBe('DEFER');
    expect(decisions[0].outcome).toBe('DEFER');
  });

  it('a SUPPRESS-class reminder inside quiet hours is dropped WITH ITS REASON, and never queued', async () => {
    const f = await createFamily('quiet-suppress');
    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'HYDRATION_REMINDER',
      sourceEventId: `signal:${stamp}:hydration`,
      trigger: 'PERIODIC_SIGNAL',
      now: DEEP_NIGHT,
    });

    expect(result.decision.verdict).toBe('SUPPRESS');
    expect(result.decision.reason).toBe('QUIET_HOURS_CLASS_SUPPRESS');
    // The engine terminated it, so the pipeline was never called.
    expect(result.outcome).toBeNull();
    expect(await deferredRows(f.familyId)).toHaveLength(0);
    expect(await childMessageRows(f.familyId)).toHaveLength(0);

    // But the DECISION exists, with its reason. Dropped-and-logged is a
    // decision; dropped-and-silent is the defect Phase D closed.
    const decisions = await decisionRows(f.familyId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('SUPPRESS');
    expect(decisions[0].reason).toBe('QUIET_HOURS_CLASS_SUPPRESS');
    expect(decisions[0].outcome).toBeNull();
  });

  it('a DELIVER-class safety alert goes out at 00:30 and is recorded as an override', async () => {
    const f = await createFamily('safety-night');
    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'ACCESSIBILITY_DISABLED',
      sourceEventId: `wellbeing:${stamp}:accessibility`,
      trigger: 'SAFETY_SIGNAL',
      now: DEEP_NIGHT,
    });

    expect(result.decision.verdict).toBe('SEND');
    expect(result.decision.reason).toBe('SAFETY_CRITICAL_OVERRIDE');
    expect(result.decision.band).toBe('HIGH');
    expect(await notificationRows(f.familyId)).toHaveLength(1);
    expect(await deferredRows(f.familyId)).toHaveLength(0);
  });

  // ==========================================================================
  // 11. THE EXPLANATION IS PERSISTED AND READABLE
  // ==========================================================================
  it('the score, the band, the trigger, the reason AND the component arithmetic are stored and reconcile', async () => {
    const f = await createFamily('explain');
    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'LEARNING_GOAL_ACHIEVED',
      sourceEventId: `evt:${stamp}:explain`,
      trigger: 'DEADLINE_WATCH',
      goal: { title: 'سورة الملك', completedUnits: 4, totalUnits: 5, minutesRemaining: 5 },
      activity: { completionsToday: 2, minutesSinceLastActivity: 3, isEngagedNow: true },
      variables: { unitNoun: 'آيات' },
      now: AFTERNOON,
    });

    const [row] = await decisionRows(f.familyId);
    expect(row.score).toBe(result.decision.score);
    expect(row.priority_band).toBe(result.decision.band);
    expect(row.trigger).toBe('DEADLINE_WATCH');
    expect(row.reason).toBe(result.decision.reason);
    expect(row.notification_type).toBe('LEARNING_GOAL_ACHIEVED');
    expect(row.category).toBe('GOAL');
    expect(row.locale).toBe('ar');
    expect(row.age_band).toBe('11-13'); // born 2013-04-01 -> 12 at 2026-01-15

    // THE ARITHMETIC, READ BACK OUT OF THE DATABASE, AND IT ADDS UP.
    const components = typeof row.explanation === 'string' ? JSON.parse(row.explanation) : row.explanation;
    expect(Array.isArray(components)).toBe(true);
    expect(components).toHaveLength(8);
    const sum = components.reduce((acc: number, c: any) => acc + Number(c.contribution), 0);
    expect(Math.max(0, Math.min(100, Math.round(sum)))).toBe(Number(row.score));
    // And each line names the FACT that produced it, not just a number.
    const deadline = components.find((c: any) => c.name === 'DEADLINE_PROXIMITY');
    expect(deadline.note).toBe('5 minutes remaining');
    // The contextual copy rules are ORDERED, and the deadline sentence wins
    // over the progress sentence when both apply: «باقي لك ٥ دقائق» is the more
    // actionable of the two, and offering both would be two notifications.
    expect(row.copy_key).toBe('GOAL_DEADLINE_NEAR');
    expect(result.body).toBe('باقي لك ٥ دقائق فقط لإكمال هدفك في سورة الملك');
  });

  it('the decision ledger stores NO title and NO body — the decision, never the message', async () => {
    const f = await createFamily('privacy');
    await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:privacy`,
      trigger: 'DOMAIN_EVENT',
      reward: { kind: 'COINS', amount: 5, isMilestone: false },
      now: AFTERNOON,
    });

    const columns = await raw<any[]>(
      `SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name = 'notification_decisions'`,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('title');
    expect(names).not.toContain('body');
    // And no stored value contains the child's name, which is the property the
    // absent columns are there to guarantee.
    const [row] = await decisionRows(f.familyId);
    expect(JSON.stringify(row)).not.toContain('محمد');
  });

  // ==========================================================================
  // 12. THE TAP LANDS SOMEWHERE — PHASE F (`F6-007`)
  // ==========================================================================
  /**
   * WHY THIS IS ASSERTED AGAINST THE ROW AND NOT AGAINST THE RESULT OBJECT.
   * Same reason as every other assertion in this file, and this feature is the
   * clearest case of it: the deep link exists to be READ BY A CLIENT, and the
   * client reads `notifications.data`. A test that asserted the resolver's
   * return value would stay green for a link that never reached the column —
   * which is precisely the state the product was in before this phase, where
   * `NotificationDecision`'s contract listed a destination that nothing wrote.
   */
  it('the persisted notification carries a routable deep link on `data`, beside the producer payload', async () => {
    const f = await createFamily('deep-link');
    await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:deep-link`,
      trigger: 'DOMAIN_EVENT',
      variables: { goalTitle: 'الآيات 1–5 من سورة الملك', points: 20 },
      data: { completionKind: 'GOAL', goalTitle: 'الآيات 1–5 من سورة الملك', points: 20 },
      now: AFTERNOON,
    });

    const [row] = await notificationRows(f.familyId);
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;

    // THE LINK IS THERE, and it is the parent's destination for a reward that
    // named a goal — the goal they set, not the reward catalogue.
    expect(data.deepLink).toBe('abny://goals');
    // THE PRODUCER'S OWN PAYLOAD IS UNTOUCHED. The link is added to `data`,
    // never instead of it (`PD-N-004`).
    expect(data.points).toBe(20);
    expect(data.completionKind).toBe('GOAL');

    // NO TENANT ID, NO PERSON, NO SECRET IN THE LINK. `e2e-13 STEP 14` pins the
    // whole payload; this pins the field this phase added to it.
    for (const id of [f.familyId, f.childId, f.userId]) {
      expect(data.deepLink).not.toContain(id);
    }
    expect(data.deepLink).not.toContain('محمد');
    expect(data.deepLink.startsWith('abny://')).toBe(true);
    expect(data.deepLink).not.toContain('?');
  });

  it('the SERVER decides the destination — a producer payload cannot choose the screen', async () => {
    // `DigitalWellbeingEngineService` spreads a DEVICE-SUPPLIED `metadata`
    // object into `data`. A device that supplied its own `deepLink` would
    // otherwise be choosing which screen a parent's tap opens, which is the one
    // thing this feature exists to keep on the server.
    const f = await createFamily('deep-link-authority');
    await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'REWARD_GRANTED',
      sourceEventId: `evt:${stamp}:deep-link-authority`,
      trigger: 'DOMAIN_EVENT',
      data: { deepLink: 'https://evil.example/steal', alertType: 'SPOOF' },
      now: AFTERNOON,
    });

    const [row] = await notificationRows(f.familyId);
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    // A reward with no goal named: the parent lands on the child's progress.
    expect(data.deepLink).toBe('abny://progress');
    expect(JSON.stringify(data)).not.toContain('evil.example');
  });
});
