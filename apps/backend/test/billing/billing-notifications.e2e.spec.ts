/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * SPRINT F1 — THE TWO BILLING NOTIFICATIONS, AGAINST A REAL POSTGRESQL.
 * ============================================================================
 *
 * WHAT WAS MISSING, and production said so itself:
 *
 *   `notification-class.ts:263`  «SUBSCRIPTION_EXPIRING … (no producer yet —
 *                                 billing is another work stream.)»
 *   `notification-class.ts:277`  «PAYMENT_FAILED … (no producer yet.) The
 *                                 billing module writes no notification of any
 *                                 kind — payment-webhook.service.ts moves
 *                                 entitlement and stops.»
 *
 * Both keys had copy in Arabic and English across four tone bands, a
 * quiet-hours class, both scoring rows and a deep-link destination. A parent
 * whose card was declined was told NOTHING. A parent three days from a renewal
 * they have to pay MANUALLY — which is Egypt's design, `auto_renewing = false`
 * — was told NOTHING.
 *
 * WHAT THIS SUITE EXECUTES. Real rows, real signed Apple notifications, real
 * repositories, real engine, real delivery pipeline, real deferral table.
 * EVERY COUNT IS READ OUT OF POSTGRESQL WITH SQL, never from a returned
 * object — the discipline `quiet-hours-deferral.e2e.spec.ts` states in its own
 * header and for the same reason: the defect class being closed is one where a
 * returned value said the right thing and no row existed.
 *
 *   1  PAYMENT_FAILED, POSITIVE   a real signed `DID_FAIL_TO_RENEW` through
 *                                 the real `PaymentWebhookService` -> one
 *                                 notification, with the ledger row explaining
 *                                 it. «Where does this run from», executed.
 *   2  PAYMENT_FAILED, NEGATIVE   a cancellation and a healthy household: two
 *                                 silences, each for a named clause.
 *   3  PAYMENT_FAILED, IDEMPOTENT redelivery x2 AND a direct re-invocation of
 *                                 the producer -> one row, refused by NAMED
 *                                 unique indexes rather than by an `if`.
 *   4  PAYMENT_FAILED, QUIET HRS  23:30 on the family's own clock -> DEFERRED
 *                                 and HELD, per `notification-class.ts`'s
 *                                 DEFER classification.
 *   5  SUBSCRIPTION_EXPIRING      positive, negative x4, idempotent across
 *                                 three consecutive daily sweeps, quiet hours.
 *   6  TIMEZONE                   Africa/Cairo AND Asia/Riyadh, at ONE instant,
 *                                 for BOTH keys. In section 6b the two
 *                                 households have the SAME renewal timestamp
 *                                 and only one of them is notified, because on
 *                                 their own calendars it is four days away for
 *                                 one and three for the other.
 *
 * SCOPED TO ITS OWN COHORT. Every assertion is `WHERE family_id = <a family
 * this file created>`. The shared database holds hundreds of families from
 * other suites and a count that could be satisfied by one of them proves
 * nothing.
 *
 * NOTHING ABOUT APPLE IS FAKED. The notifications below are signed by
 * `appleTestChain()` — the same locally-generated x5c chain
 * `payment-webhook.pipeline.spec.ts` uses — and verified by the real
 * `AppleJwsVerifier` against that chain's real root fingerprint. There are no
 * sandbox credentials in this environment and none are invented; what is
 * proven is the pipeline, not Apple's production keys.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { getBusinessDate, getBusinessTimeHHMM } from '../../src/common/time/family-date';
import { BillingNotificationProducer } from '../../src/modules/billing/application/services/billing-notification.producer';
import { EntitlementService } from '../../src/modules/billing/application/services/entitlement.service';
import { PricingService } from '../../src/modules/billing/application/services/pricing.service';
import { PaymentWebhookService } from '../../src/modules/billing/application/services/payment-webhook.service';
import { BILLING_REPOSITORY } from '../../src/modules/billing/application/ports/billing.repository.port';
import { PAYMENT_REPOSITORY } from '../../src/modules/billing/application/ports/payment.repository.port';
import { AppleStoreKitProvider } from '../../src/modules/billing/infrastructure/adapters/apple-storekit.provider';
import { FawryProvider } from '../../src/modules/billing/infrastructure/adapters/fawry.provider';
import { GooglePlayProvider } from '../../src/modules/billing/infrastructure/adapters/google-play.provider';
import { ManualPaymentAdapter } from '../../src/modules/billing/infrastructure/adapters/manual-payment.adapter';
import { MoyasarProvider } from '../../src/modules/billing/infrastructure/adapters/moyasar.provider';
import { PaymentProviderRegistry } from '../../src/modules/billing/infrastructure/adapters/payment-provider.registry';
import { PaymobProvider } from '../../src/modules/billing/infrastructure/adapters/paymob.provider';
import { StripeAdapter } from '../../src/modules/billing/infrastructure/adapters/stripe.adapter';
import { SUBSCRIPTION_EXPIRY_LEAD_DAYS } from '../../src/modules/billing/domain/subscription-expiry';
import { hasEnumOrPlaceholderLeak } from '../../src/modules/notifications/domain/engine/notification-copy';
import { forBillingEvent } from '../../src/shared/notifications/notification-source-key';
import { appleTestChain, signAppleJws } from './apple-chain.fixture';
import type { IAppleJwsTransactionPayload } from '../../src/modules/billing/infrastructure/apple/apple-storekit.types';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

const CAIRO = 'Africa/Cairo';
const RIYADH = 'Asia/Riyadh';
const BUNDLE_ID = 'com.abny.app';

/**
 * JANUARY, DELIBERATELY — the same choice, for the same reason, as
 * `quiet-hours-deferral.e2e.spec.ts` and `stalled-goal-producer.e2e.spec.ts`:
 * Egypt reintroduced DST in 2023, so in August Cairo and Riyadh are BOTH UTC+3
 * and a test asserting a difference would be asserting something false. In
 * January Cairo is UTC+2 and Riyadh UTC+3. Every offset below is READ from
 * tzdata by `family-date.ts` and none of them is written down here.
 */
/** 12:00 Cairo — comfortably outside the 21:00–07:00 quiet window. */
const MIDDAY = new Date('2026-01-16T10:00:00.000Z');
/** 23:30 Cairo — inside quiet hours, which is when cards actually decline. */
const LATE_NIGHT = new Date('2026-01-16T21:30:00.000Z');
/**
 * 20:30 Cairo / 21:30 Riyadh. ONE INSTANT, on opposite sides of the quiet-hours
 * boundary for the two launch markets. Section 6a turns on it.
 */
const EVENING_SPLIT = new Date('2026-01-15T18:30:00.000Z');
/**
 * 23:30 Cairo on the 15th / 00:30 Riyadh on the 16th. ONE INSTANT whose UTC
 * date (the 15th) is one household's date and not the other's. Section 6b
 * turns on it.
 */
const MIDNIGHT_SPLIT = new Date('2026-01-15T21:30:00.000Z');

/** The same offline client every other integration suite here builds. */
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

const chain = appleTestChain();

function appleConfig(): ConfigService {
  const values: Record<string, string | undefined> = {
    APPLE_ISSUER_ID: 'issuer',
    APPLE_KEY_ID: 'key',
    APPLE_PRIVATE_KEY: chain.leafPrivateKeyPem,
    APPLE_BUNDLE_ID: BUNDLE_ID,
    APPLE_ROOT_CA_G3_FINGERPRINT: chain.rootFingerprint,
  };
  return { get: jest.fn((k: string) => values[k]) } as unknown as ConfigService;
}

function transaction(originalTransactionId: string): IAppleJwsTransactionPayload {
  return {
    transactionId: `${originalTransactionId}-txn`,
    originalTransactionId,
    bundleId: BUNDLE_ID,
    productId: 'com.abny.premium.monthly.eg',
    purchaseDate: Date.UTC(2026, 0, 1),
    originalPurchaseDate: Date.UTC(2026, 0, 1),
    expiresDate: Date.UTC(2026, 1, 1),
    type: 'Auto-Renewable Subscription',
    inAppOwnershipType: 'PURCHASED',
    signedDate: Date.UTC(2026, 0, 1),
    environment: 'Production',
    storefront: 'EGY',
    price: 179_000,
    currency: 'EGP',
  };
}

function appleNotification(opts: {
  notificationType: string;
  subtype?: string;
  uuid: string;
  signedAt: Date;
  originalTransactionId: string;
}): string {
  const txn = transaction(opts.originalTransactionId);
  return JSON.stringify({
    signedPayload: signAppleJws({
      notificationType: opts.notificationType,
      subtype: opts.subtype,
      notificationUUID: opts.uuid,
      version: '2.0',
      signedDate: opts.signedAt.getTime(),
      data: {
        bundleId: BUNDLE_ID,
        environment: 'Production',
        signedTransactionInfo: signAppleJws(txn),
        signedRenewalInfo: signAppleJws({
          originalTransactionId: opts.originalTransactionId,
          productId: txn.productId,
          autoRenewStatus: 1,
          signedDate: opts.signedAt.getTime(),
          environment: 'Production',
        }),
      },
    }),
  });
}

interface Household {
  readonly familyId: string;
  readonly userId: string;
  readonly subscriptionId: string;
  readonly lineageKey: string;
  readonly timeZone: string;
}

describeIfDb('SPRINT F1 — PAYMENT_FAILED and SUBSCRIPTION_EXPIRING have producers (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: any;
  let producer: BillingNotificationProducer;
  let webhooks: PaymentWebhookService;

  const stamp = Date.now();
  const createdFamilies: string[] = [];
  const createdUsers: string[] = [];
  let seq = 0;

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 billing-notifications suite: ${what}`, async () => await fn());

  const raw = <T>(sql: string, ...params: unknown[]): Promise<T> =>
    sys('raw sql', () => prisma.$queryRawUnsafe(sql, ...params)) as Promise<T>;

  const decisionRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_decisions" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const notificationRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      familyId,
    );

  const deliveryRows = (familyId: string): Promise<any[]> =>
    raw<any[]>(
      `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid ORDER BY "created_at"`,
      familyId,
    );

  const countOf = async (table: string, familyId: string): Promise<number> =>
    Number(
      (
        await raw<any[]>(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE "family_id" = $1::uuid`, familyId)
      )[0].n,
    );

  /** The four numbers every «it did not spam» claim in this file is made of. */
  const countTheHousehold = async (familyId: string) => ({
    decisions: await countOf('notification_decisions', familyId),
    notifications: await countOf('notifications', familyId),
    childMessages: await countOf('child_messages', familyId),
    deliveries: await countOf('notification_deliveries', familyId),
  });

  // -- fixtures --------------------------------------------------------------

  /**
   * A household with an owner and a real `subscriptions` row.
   *
   * NO CHILD IS CREATED, and that is a property of the fixture rather than an
   * omission: a payment failure and an approaching renewal belong to the
   * HOUSEHOLD. If either notification needed a child to exist, it would be
   * producing a fact it does not have.
   */
  async function createHousehold(
    label: string,
    timeZone: string,
    subscription: Record<string, unknown> = {},
  ): Promise<Household> {
    seq += 1;
    const family = await sys('create family', () =>
      prisma.family.create({ data: { name: `F1B ${label} ${stamp}`, timezone: timeZone }, select: { id: true } }),
    );
    createdFamilies.push(family.id);

    const user = await sys('create user', () =>
      prisma.user.create({
        data: { email: `f1b.${label}.${stamp}@example.test`, passwordHash: 'x', fullName: 'F1 Parent' },
        select: { id: true },
      }),
    );
    createdUsers.push(user.id);
    await sys('create membership', () =>
      prisma.familyMember.create({ data: { familyId: family.id, userId: user.id, role: 'OWNER' } }),
    );

    const lineageKey = `f1b-orig-${stamp}-${seq}`;
    const row = await sys('create subscription', () =>
      prisma.subscription.create({
        data: {
          familyId: family.id,
          planTier: 'PREMIUM',
          status: 'ACTIVE',
          provider: 'APPLE_IAP',
          // THE LINEAGE KEY the webhook resolves the household by. It is how
          // `resolveFamily` attributes a signed Apple notification to a family
          // without ever reading a family id out of the payload.
          providerOriginalTransactionId: lineageKey,
          countryCode: 'EG',
          currencyCode: 'EGP',
          ...subscription,
        },
        select: { id: true },
      }),
    );

    return { familyId: family.id, userId: user.id, subscriptionId: row.id, lineageKey, timeZone };
  }

  /**
   * THE PRODUCER, at an explicit instant, inside the tenant scope the job
   * runner establishes before every family handler. Not `jest.useFakeTimers()`:
   * a faked clock also fakes the timers `pg` uses, so a suite that freezes time
   * and then awaits a real query deadlocks.
   */
  const sweepExpiring = (h: Household, now: Date) =>
    runWithTenant({ familyId: h.familyId, actorType: 'SYSTEM', actorId: 'f1-billing-test' }, () =>
      producer.sweepExpiringSubscription({ familyId: h.familyId, now }),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(offlinePrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    producer = app.get(BillingNotificationProducer);

    /**
     * THE REAL WEBHOOK SERVICE, ON THE REAL REPOSITORIES, WITH THE REAL
     * PRODUCER — assembled here rather than taken from the container for ONE
     * reason: `AppleStoreKitProvider` reads its keys from `ConfigService`, and
     * this environment has no Apple credentials and must not invent any. The
     * adapter below is the real class, verifying real signatures against the
     * locally generated chain in `apple-chain.fixture.ts`. Everything else —
     * `PAYMENT_REPOSITORY`, `BILLING_REPOSITORY`, `EntitlementService`,
     * `PricingService`, `BillingNotificationProducer` — is the SINGLETON the
     * application built, so what runs below is the production path on
     * production wiring.
     */
    const registry = new PaymentProviderRegistry(
      new ManualPaymentAdapter(),
      new StripeAdapter(noConfig()),
      new PaymobProvider(noConfig()),
      new FawryProvider(noConfig()),
      new MoyasarProvider(noConfig()),
      new AppleStoreKitProvider(appleConfig(), (async () => ({
        ok: true,
        status: 200,
        text: async () => '{"data":[]}',
      })) as never),
      new GooglePlayProvider(noConfig()),
    );
    webhooks = new PaymentWebhookService(
      registry,
      app.get(PAYMENT_REPOSITORY),
      app.get(BILLING_REPOSITORY),
      app.get(EntitlementService),
      app.get(PricingService),
      producer,
    );
  }, 180_000);

  function noConfig(): ConfigService {
    return { get: jest.fn(() => undefined) } as unknown as ConfigService;
  }

  afterAll(async () => {
    if (prisma) {
      for (const id of createdFamilies) {
        await sys('cleanup family', () => prisma.family.deleteMany({ where: { id } })).catch(() => undefined);
      }
      for (const id of createdUsers) {
        await sys('cleanup user', () => prisma.user.deleteMany({ where: { id } })).catch(() => undefined);
      }
    }
    await app?.close();
  }, 180_000);

  // ==========================================================================
  describe('1. PAYMENT_FAILED — a real signed provider callback reaches the parent', () => {
    let home: Household;

    it('the premise, as rows: an ACTIVE Apple subscription and a silent household', async () => {
      home = await createHousehold('failed-positive', CAIRO);

      const [row] = await raw<any[]>(
        `SELECT * FROM "subscriptions" WHERE "family_id" = $1::uuid`,
        home.familyId,
      );
      expect(row.status).toBe('ACTIVE');
      expect(row.provider).toBe('APPLE_IAP');
      expect(row.last_provider_event_at).toBeNull();

      expect(await countTheHousehold(home.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);

    it('`DID_FAIL_TO_RENEW` moves the subscription AND produces one decision, explained', async () => {
      const result = await webhooks.ingest('APPLE_IAP', {
        rawBody: appleNotification({
          notificationType: 'DID_FAIL_TO_RENEW',
          subtype: 'GRACE_PERIOD',
          uuid: `f1b-fail-${stamp}`,
          signedAt: MIDDAY,
          originalTransactionId: home.lineageKey,
        }),
        headers: {},
      });
      expect(result.outcome).toBe('PROCESSED');

      // The billing effect, unchanged by this sprint: GRACE_PERIOD keeps access.
      const [sub] = await raw<any[]>(`SELECT * FROM "subscriptions" WHERE "family_id" = $1::uuid`, home.familyId);
      expect(sub.status).toBe('GRACE_PERIOD');

      const decisions = await decisionRows(home.familyId);
      expect(decisions).toHaveLength(1);
      const [row] = decisions;

      // `SUBSCRIPTION_LIFECYCLE` is the member `NOTIFICATION_TRIGGERS` reserves
      // for exactly this and it had never had a producer. Claiming
      // `DOMAIN_EVENT` would make the column a lie: billing emits none.
      expect(row.trigger).toBe('SUBSCRIPTION_LIFECYCLE');
      expect(row.event_type).toBe('PAYMENT_FAILED');
      expect(row.notification_type).toBe('PAYMENT_FAILED');
      expect(row.category).toBe('PAYMENT');
      expect(row.target_audience).toBe('PARENT');
      expect(row.decision).toBe('SEND');
      expect(row.outcome).toBe('SEND');
      // The sentence came from the CATALOGUE. `GENERIC` here would mean the
      // parent read «لديك تحديث جديد» about their money.
      expect(row.copy_key).toBe('PAYMENT_FAILED');
      // NO CHILD. The fact belongs to the household.
      expect(row.child_id).toBeNull();
      // THE KEY THE PRODUCER CHOSE: this subscription, this provider event —
      // composed here by the same shared function the producer calls.
      expect(row.source_event_id).toBe(
        forBillingEvent(home.subscriptionId, `payment_failed:APPLE_IAP:f1b-fail-${stamp}`),
      );
    }, 120_000);

    it('it reached the parent: one row in `notifications`, to the OWNER, with no child attached', async () => {
      const rows = await notificationRows(home.familyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('PAYMENT_FAILED');
      expect(rows[0].user_id).toBe(home.userId);
      expect(rows[0].child_id).toBeNull();
      // STRUCTURALLY not to a child: `COPY_CATALOGUE.PAYMENT_FAILED` declares
      // `audience: 'PARENT'`, so this event cannot reach `child_messages` at
      // all. A child must never be told the family's card was declined.
      expect(await countOf('child_messages', home.familyId)).toBe(0);
    }, 120_000);

    it('the words are the parent’s: Arabic, actionable, and carrying no raw enum', async () => {
      const [row] = await notificationRows(home.familyId);

      expect(row.title).toBe('تعذّر إتمام الدفع');
      expect(row.body).toBe('لم تكتمل عملية الدفع الأخيرة. يمكنك المحاولة مرة أخرى من داخل التطبيق.');
      // WHAT HAPPENED and WHAT THE PARENT MIGHT DO — pinned separately, because
      // losing the second clause is the likeliest regression.
      expect(row.body).toContain('لم تكتمل');
      expect(row.body).toContain('المحاولة مرة أخرى');
      expect(row.body).toMatch(/[؀-ۿ]/);
      // NO `GRACE_PERIOD`, NO `PAST_DUE`, NO `APPLE_IAP`. The subscription is in
      // one of those states right now and the parent must not read the word.
      expect(row.title).not.toMatch(/GRACE_PERIOD|PAST_DUE|APPLE_IAP/);
      expect(row.body).not.toMatch(/GRACE_PERIOD|PAST_DUE|APPLE_IAP/);
      expect(hasEnumOrPlaceholderLeak(row.title)).toBe(false);
      expect(hasEnumOrPlaceholderLeak(row.body)).toBe(false);
      expect(row.body).not.toMatch(/[{}]/);
      // NO MONEY IS RENDERED. `COPY_CATALOGUE.PAYMENT_FAILED` has no amount
      // slot, so the producer supplies none — the honest form of «money is
      // never fabricated». There is no bare figure and no currency in the text.
      expect(row.body).not.toMatch(/EGP|SAR|ج\.م|ر\.س|[0-9٠-٩]/);
    }, 120_000);

    it('the tap lands on the subscription screen, and the payload carries no identifiers', async () => {
      const [row] = await notificationRows(home.familyId);
      const data = row.data as Record<string, unknown>;
      expect(data.deepLink).toBe('abny://subscription');
      // CONTEXT §3 principle 8, the same assertion `e2e-13 STEP 14` makes of
      // every other producer's payload.
      const serialised = JSON.stringify(data);
      expect(serialised).not.toContain(home.familyId);
      expect(serialised).not.toContain(home.subscriptionId);
      expect(serialised).not.toContain(home.userId);
    }, 120_000);
  });

  // ==========================================================================
  describe('2. PAYMENT_FAILED — NEGATIVE: a healthy household hears nothing', () => {
    it('a cancellation is not a payment failure — the customer chose to stop and keeps what they paid for', async () => {
      const home = await createHousehold('failed-negative-cancel', CAIRO);

      const result = await webhooks.ingest('APPLE_IAP', {
        rawBody: appleNotification({
          notificationType: 'DID_CHANGE_RENEWAL_STATUS',
          subtype: 'AUTO_RENEW_DISABLED',
          uuid: `f1b-cancel-${stamp}`,
          signedAt: MIDDAY,
          originalTransactionId: home.lineageKey,
        }),
        headers: {},
      });

      expect(result.outcome).toBe('PROCESSED');
      const [sub] = await raw<any[]>(`SELECT * FROM "subscriptions" WHERE "family_id" = $1::uuid`, home.familyId);
      expect(sub.status).toBe('CANCELED');
      // «تعذّر إتمام الدفع» would be false here, and on a subscription screen
      // it would be alarming. Nothing at all is the correct output.
      expect(await countTheHousehold(home.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);

    it('a household with a live ACTIVE subscription and no callback at all stays silent', async () => {
      const home = await createHousehold('failed-negative-quiet', CAIRO, {
        currentPeriodEnd: new Date('2026-06-01T00:00:00.000Z'),
      });
      // Nothing happened, so nothing is said. Stated as a row count so that a
      // future producer that fires on a read cannot slip in unnoticed.
      expect(await countTheHousehold(home.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });
    }, 120_000);
  });

  // ==========================================================================
  describe('3. PAYMENT_FAILED — IDEMPOTENT, and by named indexes rather than by an `if`', () => {
    let home: Household;
    const uuid = `f1b-idem-${stamp}`;

    const body = (): string =>
      appleNotification({
        notificationType: 'DID_FAIL_TO_RENEW',
        subtype: 'GRACE_PERIOD',
        uuid,
        signedAt: MIDDAY,
        originalTransactionId: home.lineageKey,
      });

    it('the first delivery produces exactly one notification', async () => {
      home = await createHousehold('failed-idempotent', CAIRO);
      const first = await webhooks.ingest('APPLE_IAP', { rawBody: body(), headers: {} });
      expect(first.outcome).toBe('PROCESSED');
      expect(await countTheHousehold(home.familyId)).toMatchObject({ decisions: 1, notifications: 1 });
    }, 120_000);

    it('LAYER 1 — two redeliveries are refused by `payment_webhook_events (provider, provider_event_id)`', async () => {
      const second = await webhooks.ingest('APPLE_IAP', { rawBody: body(), headers: {} });
      const third = await webhooks.ingest('APPLE_IAP', { rawBody: body(), headers: {} });
      expect([second.outcome, third.outcome]).toEqual(['DUPLICATE', 'DUPLICATE']);

      const events = await raw<any[]>(
        `SELECT * FROM "payment_webhook_events" WHERE "provider_event_id" = $1`,
        uuid,
      );
      expect(events).toHaveLength(1);
      expect(await countTheHousehold(home.familyId)).toMatchObject({ decisions: 1, notifications: 1 });
    }, 120_000);

    it('LAYER 2 and 3 — the producer invoked DIRECTLY, past that dedupe row, still writes nothing new', async () => {
      // This is the case layer 1 cannot cover: an operator replaying a
      // callback, a catch-up job, a second replica. The key is recomputed from
      // the same subscription and the same provider event id, so
      // `notification_decisions_cause_uniq` refuses the decision and
      // `notifications (family_id, source_event_id, user_id)` refuses the row.
      const outcome = await runWithTenant(
        { familyId: home.familyId, actorType: 'SYSTEM', actorId: 'f1-billing-test' },
        () =>
          producer.paymentFailed({
            familyId: home.familyId,
            subscriptionId: home.subscriptionId,
            provider: 'APPLE_IAP',
            providerEventId: uuid,
            occurredAt: MIDDAY,
          }),
      );
      expect(outcome).toBe('ALREADY_DECIDED');

      // READ BACK OUT OF POSTGRESQL, not from the return value above — the
      // whole reason this suite exists.
      const decisions = await decisionRows(home.familyId);
      const notifications = await notificationRows(home.familyId);
      expect(decisions).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      expect(notifications[0].source_event_id).toBe(decisions[0].source_event_id);
    }, 120_000);
  });

  // ==========================================================================
  describe('4. PAYMENT_FAILED — QUIET HOURS: deferred and held, never dropped', () => {
    let home: Household;

    it('a card declined at 23:30 on the family’s own clock is HELD, not delivered', async () => {
      home = await createHousehold('failed-quiet', CAIRO);
      // The premise of the whole quiet-hours class row: this instant really is
      // inside the household's window, on ITS clock.
      expect(getBusinessTimeHHMM(LATE_NIGHT, CAIRO)).toBe('23:30');

      const result = await webhooks.ingest('APPLE_IAP', {
        rawBody: appleNotification({
          notificationType: 'DID_FAIL_TO_RENEW',
          subtype: 'BILLING_RETRY',
          uuid: `f1b-quiet-${stamp}`,
          signedAt: LATE_NIGHT,
          originalTransactionId: home.lineageKey,
        }),
        headers: {},
      });
      expect(result.outcome).toBe('PROCESSED');

      // `notification-class.ts:277`, executed: «a card that failed at 23:00
      // cannot be fixed faster by waking its owner … a payment notification at
      // 03:00 is indistinguishable in tone from the phishing message it will be
      // mistaken for.» DEFER, not SUPPRESS: the parent is still owed this.
      const counts = await countTheHousehold(home.familyId);
      expect(counts.notifications).toBe(0);
      expect(counts.deliveries).toBe(1);
      expect(counts.decisions).toBe(1);
    }, 120_000);

    it('it is queued for the family’s own 07:00, carrying the same causal key', async () => {
      const [held] = await deliveryRows(home.familyId);
      expect(held.state).toBe('PENDING');
      expect(held.defer_reason).toBe('QUIET_HOURS');
      expect(held.type).toBe('PAYMENT_FAILED');
      expect(held.target_audience).toBe('PARENT');
      // No child, and the column says so rather than holding an empty string.
      expect(held.child_id).toBeNull();
      // 07:00 CAIRO — read back through tzdata, not asserted as a UTC literal.
      expect(getBusinessTimeHHMM(held.scheduled_for, CAIRO)).toBe('07:00');
      // THE KEY SURVIVES THE DEFERRAL, which is what makes «idempotent» still
      // true for a notification held overnight.
      const [decision] = await decisionRows(home.familyId);
      expect(held.source_event_id).toBe(decision.source_event_id);
      // And the Arabic the parent will read in the morning is already composed.
      expect(held.body).toContain('لم تكتمل');
    }, 120_000);
  });

  // ==========================================================================
  describe('5. SUBSCRIPTION_EXPIRING — the lead-time notice, on the family’s calendar', () => {
    it('POSITIVE — three days before renewal, one notification that states the number', async () => {
      // 19 Jan 12:00 Cairo. Today for this household is the 16th, so the
      // renewal is three of ITS days away.
      const home = await createHousehold('expiring-positive', CAIRO, {
        currentPeriodEnd: new Date('2026-01-19T10:00:00.000Z'),
      });
      expect(await countTheHousehold(home.familyId)).toMatchObject({ decisions: 0, notifications: 0 });

      const report = await sweepExpiring(home, MIDDAY);
      expect(report).toEqual({ notice: true, produced: 1, alreadyDecided: 0, refused: 0 });

      const [decision] = await decisionRows(home.familyId);
      expect(decision.trigger).toBe('SUBSCRIPTION_LIFECYCLE');
      expect(decision.event_type).toBe('SUBSCRIPTION_EXPIRING');
      expect(decision.category).toBe('SUBSCRIPTION');
      expect(decision.copy_key).toBe('SUBSCRIPTION_EXPIRING');
      expect(decision.target_audience).toBe('PARENT');
      // ONE NOTICE PER SUBSCRIPTION PER RENEWAL DAY, and the renewal day is
      // read on the FAMILY's calendar.
      expect(decision.source_event_id).toBe(forBillingEvent(home.subscriptionId, 'expiring:2026-01-19'));
      // The ledger's own business date is the household's today, not UTC's.
      expect(decision.business_date.toISOString().slice(0, 10)).toBe(getBusinessDate(MIDDAY, CAIRO));

      const rows = await notificationRows(home.familyId);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('SUBSCRIPTION_EXPIRING');
      expect(rows[0].user_id).toBe(home.userId);
      expect(rows[0].child_id).toBeNull();
      expect(rows[0].title).toBe('اشتراكك يقترب من التجديد');
      // «٣» — Arabic-Indic, from `formatNumber`, because a product that writes
      // Arabic prose with Latin numerals reads as a translation.
      expect(rows[0].body).toBe('يتبقى ٣ يومًا على تجديد اشتراكك. يمكنك المراجعة داخل التطبيق.');
      expect(rows[0].body).toContain('يمكنك المراجعة');
      expect(hasEnumOrPlaceholderLeak(rows[0].body)).toBe(false);
      // NO MONEY. The catalogue sentence has a `{days}` slot and no amount slot;
      // the amount lives in `payment_transactions` and is not invented for a
      // template that cannot hold it.
      expect(rows[0].body).not.toMatch(/EGP|SAR|١٧٩|179/);
      expect((rows[0].data as Record<string, unknown>).deepLink).toBe('abny://subscription');
      expect(await countOf('child_messages', home.familyId)).toBe(0);
    }, 120_000);

    it('NEGATIVE — a healthy subscription produces nothing, and every clause is named', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        // Outside the window: ten days away is not «يقترب».
        ['far', { status: 'ACTIVE', currentPeriodEnd: new Date('2026-01-26T10:00:00.000Z') }],
        // The renewal day ITSELF. The charge is happening; what the parent needs
        // now is its outcome, not a warning about it. And «يتبقى ٠ يومًا» is not
        // a sentence anyone writes.
        ['today', { status: 'ACTIVE', currentPeriodEnd: new Date('2026-01-16T14:00:00.000Z') }],
        // A trial ENDS, it does not RENEW. Different column, different fact, and
        // the catalogue has no trial sentence to borrow.
        ['trial', { status: 'TRIALING', trialEndsAt: new Date('2026-01-19T10:00:00.000Z'), currentPeriodEnd: null }],
        // Auto-renewal is OFF and access runs to the period end. That end is an
        // EXPIRY, not a renewal; `SUBSCRIPTION_EXPIRED` is a different key.
        ['cancelled', { status: 'CANCELED', currentPeriodEnd: new Date('2026-01-19T10:00:00.000Z') }],
        // The charge has ALREADY failed. This household is owed PAYMENT_FAILED,
        // which it got from the webhook; a second notice the same week is the
        // flood the policy exists to prevent.
        ['past_due', { status: 'PAST_DUE', currentPeriodEnd: new Date('2026-01-19T10:00:00.000Z') }],
        // No renewal date at all. Guessing one from `created_at` plus a billing
        // period would be inventing the one number the sentence states.
        ['no_date', { status: 'ACTIVE', currentPeriodEnd: null }],
      ];

      for (const [label, overrides] of cases) {
        const home = await createHousehold(`expiring-negative-${label}`, CAIRO, overrides);
        const report = await sweepExpiring(home, MIDDAY);
        expect([label, report]).toEqual([
          label,
          { notice: false, produced: 0, alreadyDecided: 0, refused: 0 },
        ]);
        expect([label, await countTheHousehold(home.familyId)]).toEqual([
          label,
          { decisions: 0, notifications: 0, childMessages: 0, deliveries: 0 },
        ]);
      }
    }, 180_000);

    it('IDEMPOTENT — the sweep runs on all three days of the window and notifies once', async () => {
      const home = await createHousehold('expiring-idempotent', CAIRO, {
        currentPeriodEnd: new Date('2026-01-19T10:00:00.000Z'),
      });

      // Three consecutive daily runs, exactly as `JobRunner.executeFamilies`
      // would drive them: 12:00 Cairo on the 16th, the 17th and the 18th, i.e.
      // three, two and one day before the renewal. All three recompute the same
      // renewal-day key, so the ledger refuses the second and the third.
      const days = [
        new Date('2026-01-16T10:00:00.000Z'),
        new Date('2026-01-17T10:00:00.000Z'),
        new Date('2026-01-18T10:00:00.000Z'),
      ];
      const reports = [];
      for (const now of days) reports.push(await sweepExpiring(home, now));

      expect(reports[0]).toEqual({ notice: true, produced: 1, alreadyDecided: 0, refused: 0 });
      expect(reports[1]).toEqual({ notice: true, produced: 0, alreadyDecided: 1, refused: 0 });
      expect(reports[2]).toEqual({ notice: true, produced: 0, alreadyDecided: 1, refused: 0 });

      // READ BACK OUT OF POSTGRESQL. `notice: true` on all three runs is the
      // honest report — the condition really did hold on all three days — and
      // the DATABASE is what makes it one notification.
      const decisions = await decisionRows(home.familyId);
      const notifications = await notificationRows(home.familyId);
      expect(decisions).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      // And it is the FIRST day's sentence, three days out, not the last.
      expect(notifications[0].body).toContain('٣');
      expect(SUBSCRIPTION_EXPIRY_LEAD_DAYS).toBe(3);
    }, 180_000);

    it('QUIET HOURS — a sweep that runs at 02:00 defers rather than waking the household', async () => {
      const home = await createHousehold('expiring-quiet', CAIRO, {
        currentPeriodEnd: new Date('2026-01-19T10:00:00.000Z'),
      });
      // 02:00 Cairo on the 17th — the hour `family-daily-rollover` is really
      // scheduled at (`local_hour = 2`, migration 0011), which is the hour a
      // composed sweep would run at in production.
      const deepNight = new Date('2026-01-17T00:00:00.000Z');
      expect(getBusinessTimeHHMM(deepNight, CAIRO)).toBe('02:00');

      const report = await sweepExpiring(home, deepNight);
      expect(report.notice).toBe(true);

      const counts = await countTheHousehold(home.familyId);
      expect(counts.notifications).toBe(0);
      expect(counts.deliveries).toBe(1);

      const [held] = await deliveryRows(home.familyId);
      expect(held.state).toBe('PENDING');
      expect(held.type).toBe('SUBSCRIPTION_EXPIRING');
      expect(held.child_id).toBeNull();
      expect(getBusinessTimeHHMM(held.scheduled_for, CAIRO)).toBe('07:00');
      // «A renewal date is days away by construction; there is no version of
      // this that justifies 02:00» — `notification-class.ts:263`, executed. The
      // sentence still says two days, because on the 17th it is two.
      expect(held.body).toContain('٢');
    }, 120_000);
  });

  // ==========================================================================
  describe('6. TIMEZONE — one instant, two households, two different answers', () => {
    it('6a. PAYMENT_FAILED — Cairo is delivered and Riyadh is held, from the SAME callback instant', async () => {
      const cairo = await createHousehold('tz-fail-cairo', CAIRO);
      const riyadh = await createHousehold('tz-fail-riyadh', RIYADH);

      // The premise, measured from tzdata rather than remembered: one instant,
      // 20:30 in Cairo and 21:30 in Riyadh, i.e. opposite sides of the 21:00
      // quiet-hours boundary. Egypt observes DST and Saudi Arabia does not, so
      // in January the two markets are an hour apart.
      expect(getBusinessTimeHHMM(EVENING_SPLIT, CAIRO)).toBe('20:30');
      expect(getBusinessTimeHHMM(EVENING_SPLIT, RIYADH)).toBe('21:30');

      for (const [label, home] of [
        ['cairo', cairo],
        ['riyadh', riyadh],
      ] as const) {
        const result = await webhooks.ingest('APPLE_IAP', {
          rawBody: appleNotification({
            notificationType: 'DID_FAIL_TO_RENEW',
            subtype: 'GRACE_PERIOD',
            uuid: `f1b-tz-${label}-${stamp}`,
            signedAt: EVENING_SPLIT,
            originalTransactionId: home.lineageKey,
          }),
          headers: {},
        });
        expect([label, result.outcome]).toEqual([label, 'PROCESSED']);
      }

      // A server-local or UTC quiet-hours check would have given these two
      // households the SAME answer. They must not get the same answer.
      expect(await countTheHousehold(cairo.familyId)).toMatchObject({ notifications: 1, deliveries: 0 });
      expect(await countTheHousehold(riyadh.familyId)).toMatchObject({ notifications: 0, deliveries: 1 });

      const [held] = await deliveryRows(riyadh.familyId);
      expect(getBusinessTimeHHMM(held.scheduled_for, RIYADH)).toBe('07:00');
    }, 180_000);

    it('6b. SUBSCRIPTION_EXPIRING — the SAME renewal timestamp is four days away in Cairo and three in Riyadh', async () => {
      // THE SHARPEST FORM OF «the family's own calendar». One instant, one
      // renewal timestamp, two households — and only one of them is inside the
      // three-day window, because on 15 January at 21:30Z it is still the 15th
      // in Cairo and already the 16th in Riyadh.
      expect(getBusinessDate(MIDNIGHT_SPLIT, CAIRO)).toBe('2026-01-15');
      expect(getBusinessDate(MIDNIGHT_SPLIT, RIYADH)).toBe('2026-01-16');
      // And the UTC date is the Cairo one, so a producer that used
      // `toISOString().slice(0, 10)` would silence the Riyadh household.
      expect(MIDNIGHT_SPLIT.toISOString().slice(0, 10)).toBe('2026-01-15');

      const renewal = new Date('2026-01-19T10:00:00.000Z');
      const cairo = await createHousehold('tz-exp-cairo', CAIRO, { currentPeriodEnd: renewal });
      const riyadh = await createHousehold('tz-exp-riyadh', RIYADH, { currentPeriodEnd: renewal });

      const cairoReport = await sweepExpiring(cairo, MIDNIGHT_SPLIT);
      const riyadhReport = await sweepExpiring(riyadh, MIDNIGHT_SPLIT);

      // FOUR days away on the Cairo calendar: outside the window, and silence
      // is the correct output rather than a rounded-down «three».
      expect(cairoReport).toEqual({ notice: false, produced: 0, alreadyDecided: 0, refused: 0 });
      expect(await countTheHousehold(cairo.familyId)).toEqual({
        decisions: 0,
        notifications: 0,
        childMessages: 0,
        deliveries: 0,
      });

      // THREE days away on the Riyadh calendar: inside it.
      expect(riyadhReport.notice).toBe(true);
      const [decision] = await decisionRows(riyadh.familyId);
      expect(decision.event_type).toBe('SUBSCRIPTION_EXPIRING');
      expect(decision.business_date.toISOString().slice(0, 10)).toBe('2026-01-16');
      // 00:30 Riyadh is inside quiet hours, so it is HELD — which is what the
      // DEFER class says must happen and is why the assertion is on the queued
      // row rather than on `notifications`.
      const [held] = await deliveryRows(riyadh.familyId);
      expect(held.type).toBe('SUBSCRIPTION_EXPIRING');
      expect(held.body).toContain('٣');
      expect(getBusinessTimeHHMM(held.scheduled_for, RIYADH)).toBe('07:00');
    }, 180_000);
  });
});
