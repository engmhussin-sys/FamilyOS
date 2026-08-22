/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * PHASE F (`F6-002` §1) — THE SWAP PROOF.
 *
 * THE CLAIM UNDER TEST, in the brief's own words: «an
 * `AiNotificationDecisionProvider` can replace it later WITHOUT TOUCHING
 * ANYTHING ELSE — prove that with a test that swaps in a stub provider and shows
 * the rest of the pipeline unchanged.»
 *
 * WHY A SEPARATE FILE. A seam is only proven by a SECOND Nest module in which
 * ONE binding differs and everything else is the real production graph. Mixing
 * that into the main engine suite would mean the two apps share fixtures and
 * «unchanged» becomes unprovable. Here the override is a single
 * `.overrideProvider(NOTIFICATION_DECISION_PROVIDER)` and nothing else is
 * touched — no module edit, no composer change, no repository change, no
 * migration.
 *
 * WHAT «UNCHANGED» MEANS, AND IT IS ASSERTED RATHER THAN ASSUMED. With a
 * deliberately alien provider — one that scores 91, bands HIGH, picks a
 * different copy key and calls itself `stub-ai` — the pipeline STILL:
 *
 *   - renders the copy for the CHOSEN key, from the same catalogue, in Arabic,
 *     at the child's own tone band;
 *   - runs the same safety gate;
 *   - runs the same fatigue policy;
 *   - collapses a retry to one row through the same unique indexes;
 *   - writes the same decision ledger, with the STUB's score and provider id;
 *   - delivers through `SmartNotificationIntegrationService`, not through
 *     anything this test knows about.
 *
 * And the one thing that DOES change is the one thing that should: the verdict,
 * the score and `provider_id`.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { NOTIFICATION_DECISION_PROVIDER } from '../../src/modules/notifications/application/ports/notification-decision.provider';
import type {
  NotificationDecisionOutput,
  NotificationDecisionProvider,
} from '../../src/modules/notifications/application/ports/notification-decision.provider';
import type { NotificationContext } from '../../src/modules/notifications/domain/engine/notification-context';
import type { NotificationPolicy } from '../../src/modules/notifications/domain/engine/notification-policy';
import { SmartNotificationEngineService } from '../../src/modules/notification-engine/application/services/smart-notification-engine.service';
import type { NotificationEventInput } from '../../src/modules/notification-engine/application/services/notification-context.assembler';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const AFTERNOON = new Date('2026-01-15T15:00:00.000Z'); // 17:00 Cairo
const DEEP_NIGHT = new Date('2026-01-15T22:30:00.000Z'); // 00:30 Cairo

/**
 * THE STAND-IN FOR A FUTURE MODEL-BACKED PROVIDER.
 *
 * It is deliberately NOT a variation of the rule-based one: it ignores the
 * score entirely, always bands HIGH, always sends, and chooses a copy key the
 * deterministic provider would never have chosen for this event. If any of the
 * assertions below still pass, they pass because the PIPELINE holds them, not
 * because the two providers happen to agree.
 *
 * It is also ASYNC, which the port permits and the rule-based one is not — the
 * shape a real model call would have.
 */
class StubAiDecisionProvider implements NotificationDecisionProvider {
  readonly id = 'stub-ai';
  seen: NotificationContext[] = [];

  async decide(
    context: NotificationContext,
    policy: NotificationPolicy,
  ): Promise<NotificationDecisionOutput> {
    this.seen.push(context);
    // It reads the policy, proving the policy is handed to whatever provider is
    // bound — an AI provider must still see the household's own caps.
    expect(policy.maxPerDay).toBeGreaterThan(0);
    return {
      decision: {
        trigger: context.event.trigger,
        verdict: 'SEND',
        band: 'HIGH',
        score: 91,
        reason: 'SCORE_ABOVE_SEND_THRESHOLD',
        components: [
          {
            name: 'RELEVANCE',
            raw: 0.91,
            weight: 100,
            contribution: 91,
            note: 'stub provider: a single opaque relevance reading',
          },
        ],
        notificationType: context.event.eventType,
        category: 'ACHIEVEMENT',
        targetAudience: 'CHILD',
        priority: 'HIGH',
        providerId: this.id,
      },
      // A key the rule-based provider would not have picked for BADGE_EARNED.
      copyKey: 'STREAK_ACHIEVED',
      copyVariables: { days: 9 },
    };
  }
}

const stub = new StubAiDecisionProvider();

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

describeIfDb('PHASE F — the decision provider is genuinely swappable', () => {
  let app: INestApplication;
  let prisma: any;
  let engine: SmartNotificationEngineService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `Phase F swap suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const childMessageRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(`SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid`, familyId);
  const decisionRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(`SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid`, familyId);
  const deferredRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(`SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid`, familyId);

  async function createFamily(label: string) {
    const family = await sys('create family', () =>
      prisma.family.create({
        data: { name: `PF-swap ${label} ${stamp}`, timezone: 'Africa/Cairo' },
        select: { id: true },
      }),
    );
    createdFamilies.push(family.id);
    const user = await sys('create user', () =>
      prisma.user.create({
        data: {
          email: `pf.swap.${label}.${stamp}@example.test`,
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
        data: { familyId: family.id, firstName: 'محمد', dateOfBirth: new Date('2018-06-01T00:00:00.000Z') },
        select: { id: true },
      }),
    );
    return { familyId: family.id, childId: child.id };
  }

  const fire = (input: NotificationEventInput) =>
    runWithTenant({ familyId: input.familyId, actorType: 'SYSTEM', actorId: 'phase-f-swap' }, () =>
      engine.handleEvent(input),
    );

  beforeAll(async () => {
    // THE ENTIRE COST OF THE SWAP: one `overrideProvider`. No module edit, no
    // change to the composer, the ledger, the pipeline or the schema.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .overrideProvider(NOTIFICATION_DECISION_PROVIDER)
      .useValue(stub)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    engine = app.get(SmartNotificationEngineService);
  }, 60_000);

  afterAll(async () => {
    for (const id of createdFamilies) {
      await sys('cleanup family', () => prisma.family.delete({ where: { id } })).catch(() => undefined);
    }
    for (const id of createdUsers) {
      await sys('cleanup user', () => prisma.user.delete({ where: { id } })).catch(() => undefined);
    }
    await app?.close();
  }, 60_000);

  it('the swapped provider is the one being consulted, and it receives the SAME assembled context', async () => {
    const f = await createFamily('consulted');
    stub.seen = [];

    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'BADGE_EARNED',
      sourceEventId: `evt:${stamp}:swap-1`,
      trigger: 'DOMAIN_EVENT',
      variables: { badgeTitle: 'القارئ' },
      now: AFTERNOON,
    });

    expect(result.decision.providerId).toBe('stub-ai');
    expect(result.decision.score).toBe(91);
    expect(result.decision.band).toBe('HIGH');

    // The context the stub saw is the REAL assembled one — age, band, timezone,
    // quiet-hours state and locale all resolved by the same assembler. A
    // provider abstraction that handed a different input to a different
    // implementation would not be an abstraction.
    expect(stub.seen).toHaveLength(1);
    const seen = stub.seen[0];
    expect(seen.familyId).toBe(f.familyId);
    expect(seen.childAgeYears).toBe(7);
    expect(seen.toneBand).toBe('5-7');
    expect(seen.safetyBand).toBe('6-8');
    expect(seen.locale).toBe('ar');
    expect(seen.timeZone).toBe('Africa/Cairo');
    expect(seen.quietHours.isActiveNow).toBe(false);
    expect(seen.now.toISOString()).toBe(AFTERNOON.toISOString());
  });

  it('EVERYTHING DOWNSTREAM IS UNCHANGED — copy, tone, safety, delivery and the ledger', async () => {
    const f = await createFamily('downstream');
    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'BADGE_EARNED',
      sourceEventId: `evt:${stamp}:swap-2`,
      trigger: 'DOMAIN_EVENT',
      variables: { badgeTitle: 'القارئ' },
      now: AFTERNOON,
    });

    // The COPY came from the catalogue, for the key the STUB chose, at the
    // child's own tone band, in Arabic, with Arabic-Indic digits.
    expect(result.body).toBe('سلسلتك وصلت ٩ أيام 🎉');

    // DELIVERY went through the real pipeline into the real table, with the
    // approval gate intact.
    const messages = await childMessageRows(f.familyId);
    expect(messages).toHaveLength(1);
    expect(messages[0].approval_status).toBe('PENDING');
    expect(messages[0].source_event_id).toBe(`evt:${stamp}:swap-2:child`);

    // The LEDGER recorded the stub's numbers, in the same columns.
    const [decision] = await decisionRows(f.familyId);
    expect(decision.provider_id).toBe('stub-ai');
    expect(decision.score).toBe(91);
    expect(decision.priority_band).toBe('HIGH');
    expect(decision.copy_key).toBe('STREAK_ACHIEVED');
    expect(decision.outcome).toBe('SEND');
  });

  it('the swapped provider CANNOT bypass idempotency — a retry still writes one row', async () => {
    const f = await createFamily('idempotent');
    const input: NotificationEventInput = {
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'BADGE_EARNED',
      sourceEventId: `evt:${stamp}:swap-3`,
      trigger: 'DOMAIN_EVENT',
      variables: { badgeTitle: 'القارئ' },
      now: AFTERNOON,
    };
    await fire(input);
    await fire(input);
    await fire(input);

    expect(await childMessageRows(f.familyId)).toHaveLength(1);
    expect(await decisionRows(f.familyId)).toHaveLength(1);
  });

  it('the swapped provider CANNOT bypass quiet hours — SEND at 00:30 is still held by the pipeline', async () => {
    const f = await createFamily('quiet');
    // The stub says SEND, HIGH, 91. The matrix and the fatigue guard say
    // otherwise, and they are downstream of the provider by construction.
    const result = await fire({
      familyId: f.familyId,
      childId: f.childId,
      eventType: 'BADGE_EARNED',
      sourceEventId: `evt:${stamp}:swap-4`,
      trigger: 'DOMAIN_EVENT',
      variables: { badgeTitle: 'القارئ' },
      now: DEEP_NIGHT,
    });

    expect(result.decision.verdict).toBe('SEND');
    // THE ENGINE'S OPINION AND THE PIPELINE'S ACTION DISAGREE, and the ledger
    // records both — which is exactly the row a support engineer needs.
    expect(result.outcome?.decision).toBe('DEFER');
    expect(await childMessageRows(f.familyId)).toHaveLength(0);
    const deferred = await deferredRows(f.familyId);
    expect(deferred).toHaveLength(1);
    expect(deferred[0].defer_reason).toBe('QUIET_HOURS');

    const [decision] = await decisionRows(f.familyId);
    expect(decision.decision).toBe('SEND');
    expect(decision.outcome).toBe('DEFER');
  });
});
