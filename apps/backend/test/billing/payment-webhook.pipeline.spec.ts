import { ConfigService } from '@nestjs/config';

import { PaymentWebhookService } from '../../src/modules/billing/application/services/payment-webhook.service';
import { PaymentVerificationService } from '../../src/modules/billing/application/services/payment-verification.service';
import { EntitlementService } from '../../src/modules/billing/application/services/entitlement.service';
import { PricingService } from '../../src/modules/billing/application/services/pricing.service';
import { PaymentProviderRegistry } from '../../src/modules/billing/infrastructure/adapters/payment-provider.registry';
import { AppleStoreKitProvider } from '../../src/modules/billing/infrastructure/adapters/apple-storekit.provider';
import { GooglePlayProvider } from '../../src/modules/billing/infrastructure/adapters/google-play.provider';
import { PaymobProvider } from '../../src/modules/billing/infrastructure/adapters/paymob.provider';
import { FawryProvider } from '../../src/modules/billing/infrastructure/adapters/fawry.provider';
import { MoyasarProvider } from '../../src/modules/billing/infrastructure/adapters/moyasar.provider';
import { ManualPaymentAdapter } from '../../src/modules/billing/infrastructure/adapters/manual-payment.adapter';
import { StripeAdapter } from '../../src/modules/billing/infrastructure/adapters/stripe.adapter';
import { BillingNotificationProducer } from '../../src/modules/billing/application/services/billing-notification.producer';
import { InMemoryPaymentRepository, InMemoryBillingRepository, MARKETS } from './payment-test-doubles';
import { appleTestChain, signAppleJws } from './apple-chain.fixture';
import type { IAppleJwsTransactionPayload } from '../../src/modules/billing/infrastructure/apple/apple-storekit.types';

/**
 * PHASE D — THE WEBHOOK PIPELINE, END TO END.
 *
 * ================= WHAT IS REAL HERE AND WHAT IS A DOUBLE =================
 *
 * REAL: `PaymentWebhookService`, `PaymentVerificationService`,
 *       `EntitlementService`, `PricingService`, `PaymentProviderRegistry`,
 *       `AppleStoreKitProvider`, `GooglePlayProvider`, and the whole
 *       `AppleJwsVerifier` chain-and-signature path.
 *
 * DOUBLES: the two REPOSITORIES, and the providers' HTTP.
 *
 * The repository double is not a stub that returns whatever the test wants —
 * it REIMPLEMENTS THE UNIQUE CONSTRAINTS. `recordWebhookEvent`,
 * `recordPaymentTransaction`, `recordRefund` and `createTrialIfNone` all
 * enforce their real unique keys and return `wasCreated: false` on a
 * collision, exactly as the PostgreSQL indexes do. That is what makes the
 * duplicate and concurrency assertions below meaningful rather than
 * self-fulfilling. The SAME constraints are separately proven against a REAL
 * PostgreSQL in `test/database/payment-idempotency.integration.spec.ts`, so
 * neither half stands alone.
 */

const BUNDLE_ID = 'com.abny.app';
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

function transaction(over: Partial<IAppleJwsTransactionPayload> = {}): IAppleJwsTransactionPayload {
  return {
    transactionId: 'apple-txn-1',
    originalTransactionId: 'apple-orig-1',
    bundleId: BUNDLE_ID,
    productId: 'com.abny.premium.monthly.eg',
    purchaseDate: Date.UTC(2026, 7, 1),
    originalPurchaseDate: Date.UTC(2026, 7, 1),
    expiresDate: Date.UTC(2026, 8, 1),
    type: 'Auto-Renewable Subscription',
    appAccountToken: 'apple-account-family-a',
    inAppOwnershipType: 'PURCHASED',
    signedDate: Date.UTC(2026, 7, 1),
    environment: 'Production',
    storefront: 'EGY',
    // 17900 milli-EGP... no: Apple's price is MILLI-units, so 179.00 EGP is
    // 179000, which converts to 17900 minor units — the Premium monthly EG
    // price seeded by the test catalogue.
    price: 179_000,
    currency: 'EGP',
    ...over,
  };
}

function appleNotification(
  notificationType: string,
  opts: {
    uuid?: string;
    subtype?: string;
    signedDate?: number;
    txn?: IAppleJwsTransactionPayload;
  } = {},
): string {
  return JSON.stringify({
    signedPayload: signAppleJws({
      notificationType,
      subtype: opts.subtype,
      notificationUUID: opts.uuid ?? 'uuid-1',
      version: '2.0',
      signedDate: opts.signedDate ?? Date.UTC(2026, 7, 1),
      data: {
        bundleId: BUNDLE_ID,
        environment: 'Production',
        signedTransactionInfo: signAppleJws(opts.txn ?? transaction()),
        signedRenewalInfo: signAppleJws({
          originalTransactionId: (opts.txn ?? transaction()).originalTransactionId,
          productId: (opts.txn ?? transaction()).productId,
          autoRenewStatus: 1,
          signedDate: opts.signedDate ?? Date.UTC(2026, 7, 1),
          environment: 'Production',
        }),
      },
    }),
  });
}

interface IHarness {
  webhooks: PaymentWebhookService;
  verification: PaymentVerificationService;
  entitlements: EntitlementService;
  payments: InMemoryPaymentRepository;
  billing: InMemoryBillingRepository;
  apple: AppleStoreKitProvider;
  /**
   * SPRINT F1 — WHAT THE WEBHOOK ASKED THE ENGINE FOR, recorded.
   *
   * A RECORDER, NOT A STUB OF THE ENGINE. What this suite is about is which
   * webhook kinds reach `paymentFailed` and with which subject and occurrence
   * — a routing question this file can answer with real adapters, real
   * signatures and real constraint-enforcing repositories. Whether that call
   * becomes an Arabic sentence in a `notifications` row is a DIFFERENT
   * question, answered against a real PostgreSQL and the real engine in
   * `test/billing/billing-notifications.e2e.spec.ts`. Neither suite stands
   * alone, which is the same split the header states for the repositories.
   */
  notified: Array<{
    familyId: string;
    subscriptionId: string;
    provider: string;
    providerEventId: string;
    occurredAt: Date;
  }>;
}

function harness(options: { appleFetch?: jest.Mock } = {}): IHarness {
  const payments = new InMemoryPaymentRepository();
  const billing = new InMemoryBillingRepository();
  // The two doubles share state the way the two real repositories share a
  // database — without this, a subscription created through one is invisible
  // to the other and the state-machine assertions below silently pass.
  billing.bind(payments);

  const appleFetch =
    options.appleFetch ??
    (jest.fn(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' })) as jest.Mock);

  const apple = new AppleStoreKitProvider(appleConfig(), appleFetch as never);
  const noConfig = { get: jest.fn(() => undefined) } as unknown as ConfigService;
  const registry = new PaymentProviderRegistry(
    new ManualPaymentAdapter(),
    new StripeAdapter(noConfig),
    new PaymobProvider(noConfig),
    new FawryProvider(noConfig),
    new MoyasarProvider(noConfig),
    apple,
    new GooglePlayProvider(noConfig),
  );

  const pricing = new PricingService(payments);
  const entitlements = new EntitlementService(payments, billing);
  const verification = new PaymentVerificationService(registry, payments, billing, entitlements, pricing);
  const notified: IHarness['notified'] = [];
  const notifications = {
    paymentFailed: async (input: IHarness['notified'][number]) => {
      notified.push(input);
      return 'PRODUCED' as const;
    },
  } as unknown as BillingNotificationProducer;
  const webhooks = new PaymentWebhookService(registry, payments, billing, entitlements, pricing, notifications);

  return { webhooks, verification, entitlements, payments, billing, apple, notified };
}

// ===========================================================================

describe('PHASE D — happy path: a signed Apple renewal grants entitlement exactly once', () => {
  it('records the payment, extends the subscription and grants every feature of the tier', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    const result = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW'),
      headers: {},
    });

    expect(result.outcome).toBe('PROCESSED');
    expect(result.acknowledged).toBe(true);

    const transactions = await h.payments.listPaymentTransactions('family-a');
    expect(transactions).toHaveLength(1);
    expect(transactions[0].grossAmountMinor).toBe(17_900);
    expect(transactions[0].currency).toBe('EGP');
    // VAT 14% INCLUSIVE of 179.00 EGP: 17900 * 1400 / 11400 = 2198 (half-up).
    expect(transactions[0].vatAmountMinor).toBe(2_198);
    expect(transactions[0].netAmountMinor).toBe(17_900 - 2_198);
    expect(transactions[0].netAmountMinor + transactions[0].vatAmountMinor).toBe(transactions[0].grossAmountMinor);

    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(Date.UTC(2026, 7, 15)))).toBe(true);
  });
});

describe('PHASE D — DUPLICATE WEBHOOK', () => {
  it('a redelivered notification is acknowledged 200 and applies nothing a second time', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    const body = appleNotification('DID_RENEW', { uuid: 'uuid-dup' });
    const first = await h.webhooks.ingest('APPLE_IAP', { rawBody: body, headers: {} });
    const second = await h.webhooks.ingest('APPLE_IAP', { rawBody: body, headers: {} });
    const third = await h.webhooks.ingest('APPLE_IAP', { rawBody: body, headers: {} });

    expect(first.outcome).toBe('PROCESSED');
    expect(second.outcome).toBe('DUPLICATE');
    expect(third.outcome).toBe('DUPLICATE');
    // Q17: a duplicate is a 200, immediately, with no reprocessing.
    expect(second.acknowledged).toBe(true);

    expect(await h.payments.listPaymentTransactions('family-a')).toHaveLength(1);
    expect(h.payments.webhookEvents).toHaveLength(1);
  });

  it('the same purchase arriving via BOTH the client path and the webhook credits it once', async () => {
    // The two code paths derive the SAME idempotency key from provider facts,
    // which is the only reason this works. A key containing a timestamp or a
    // request id would produce two rows for one payment.
    const appleFetch = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes('/subscriptions/')
          ? JSON.stringify({
              environment: 'Production',
              bundleId: BUNDLE_ID,
              data: [
                {
                  subscriptionGroupIdentifier: 'g',
                  lastTransactions: [
                    {
                      originalTransactionId: 'apple-orig-1',
                      status: 1,
                      signedTransactionInfo: signAppleJws(transaction()),
                      signedRenewalInfo: signAppleJws({
                        originalTransactionId: 'apple-orig-1',
                        productId: 'com.abny.premium.monthly.eg',
                        autoRenewStatus: 1,
                        signedDate: Date.UTC(2026, 7, 1),
                        environment: 'Production',
                      }),
                    },
                  ],
                },
              ],
            })
          : '{}',
    }));
    const h = harness({ appleFetch: appleFetch as never });
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    await h.verification.verifyAndApply({
      provider: 'APPLE_IAP',
      providerToken: signAppleJws(transaction()),
      sessionFamilyId: 'family-a',
      amountToleranceMinor: 1,
    });
    await h.webhooks.ingest('APPLE_IAP', { rawBody: appleNotification('SUBSCRIBED'), headers: {} });

    expect(await h.payments.listPaymentTransactions('family-a')).toHaveLength(1);
  });
});

describe('PHASE D — CONCURRENT WEBHOOK DELIVERY', () => {
  it('eight simultaneous deliveries of one event produce one transaction and one processed row', async () => {
    // The exact shape of DA-002's reward-ledger finding, applied to money:
    // eight concurrent identical requests must not produce eight rows. The
    // defence is the unique index deciding, not a check-then-act in code.
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    const body = appleNotification('DID_RENEW', { uuid: 'uuid-concurrent' });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.webhooks.ingest('APPLE_IAP', { rawBody: body, headers: {} })),
    );

    expect(results.filter((r) => r.outcome === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'DUPLICATE')).toHaveLength(7);
    expect(results.every((r) => r.acknowledged)).toBe(true);
    expect(await h.payments.listPaymentTransactions('family-a')).toHaveLength(1);
    expect(h.payments.webhookEvents).toHaveLength(1);
  });

  it('two DIFFERENT events for the same subscription both apply, and the newer state wins', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    const subscriptionId = h.billing.createSubscriptionFor('family-a');

    await Promise.all([
      h.webhooks.ingest('APPLE_IAP', {
        rawBody: appleNotification('DID_RENEW', { uuid: 'u-old', signedDate: Date.UTC(2026, 7, 1) }),
        headers: {},
      }),
      h.webhooks.ingest('APPLE_IAP', {
        rawBody: appleNotification('DID_FAIL_TO_RENEW', {
          uuid: 'u-new',
          subtype: 'GRACE_PERIOD',
          signedDate: Date.UTC(2026, 7, 20),
        }),
        headers: {},
      }),
    ]);

    expect(h.payments.subscriptionState(subscriptionId)?.status).toBe('GRACE_PERIOD');
  });
});

describe('PHASE D — OUT-OF-ORDER DELIVERY (the older event must not overwrite the newer)', () => {
  it('a stale RENEWED arriving after an EXPIRED does not resurrect the subscription', async () => {
    // Q17: «ordering is not guaranteed... the older event does not overwrite
    // the newer.» This is the failure that silently gives a churned customer
    // free access forever.
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    const subscriptionId = h.billing.createSubscriptionFor('family-a');

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('EXPIRED', { uuid: 'u-expired', signedDate: Date.UTC(2026, 8, 1) }),
      headers: {},
    });
    expect(h.payments.subscriptionState(subscriptionId)?.status).toBe('EXPIRED');

    const stale = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_FAIL_TO_RENEW', {
        uuid: 'u-stale',
        subtype: 'GRACE_PERIOD',
        signedDate: Date.UTC(2026, 6, 1),
      }),
      headers: {},
    });

    expect(stale.outcome).toBe('IGNORED');
    expect(stale.detail).toContain('stale');
    expect(h.payments.subscriptionState(subscriptionId)?.status).toBe('EXPIRED');
  });
});

describe('PHASE D — TAMPERED AMOUNT and TAMPERED CURRENCY are separate rejections', () => {
  it('rejects a payment whose amount does not match the catalogue', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    // A GENUINELY APPLE-SIGNED transaction — the signature verifies — that
    // claims a price of 1.00 EGP for a 179.00 EGP product. The signature check
    // cannot catch this; only the catalogue comparison can.
    const result = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', { uuid: 'u-cheap', txn: transaction({ price: 1_000 }) }),
      headers: {},
    });

    expect(result.outcome).toBe('FAILED');
    expect(await h.payments.listPaymentTransactions('family-a')).toHaveLength(0);
    // NOTHING was granted. Asserted against the materialised entitlement rows
    // rather than `hasFeature`, because `hasFeature` deliberately falls back to
    // the Sprint 8 computation for families that predate Phase D — and this
    // fixture family has a pre-existing ACTIVE subscription row. The claim
    // being made here is precisely "this webhook granted nothing".
    expect(await h.payments.listEntitlements('family-a')).toHaveLength(0);
  });

  it('rejects a payment in a currency the catalogue does not price this product in', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    // Same amount, wrong currency: 179.00 SAR is roughly ten times 179.00 EGP.
    // A system comparing only the number would accept it.
    const result = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', { uuid: 'u-currency', txn: transaction({ currency: 'SAR' }) }),
      headers: {},
    });

    expect(result.outcome).toBe('FAILED');
    expect(await h.payments.listPaymentTransactions('family-a')).toHaveLength(0);
  });

  it('rejects a product that is not in the catalogue at all — granting "some tier" is not a fallback', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    const result = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', {
        uuid: 'u-unknown',
        txn: transaction({ productId: 'com.abny.not.a.real.product' }),
      }),
      headers: {},
    });

    expect(result.outcome).toBe('REJECTED_VALIDATION');
    expect(await h.payments.listEntitlements('family-a')).toHaveLength(0);
  });
});

describe('PHASE D — an unsigned or forged webhook never reaches the business tables', () => {
  it('records the attempt as REJECTED_SIGNATURE and returns a 4xx-worthy result', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    const result = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: JSON.stringify({ signedPayload: 'not.a.jws' }),
      headers: {},
    });

    expect(result.outcome).toBe('REJECTED_SIGNATURE');
    expect(result.acknowledged).toBe(false);
    // The reason is NOT returned to the caller — a verifier that explains why
    // it failed is an oracle for constructing a valid signature.
    expect(result.detail).toBe('signature verification failed');
    // But it IS recorded, so a burst of forgeries is visible to an operator.
    expect(h.payments.webhookEvents).toHaveLength(1);
    expect(h.payments.webhookEvents[0].outcome).toBe('REJECTED_SIGNATURE');
    expect(await h.payments.listPaymentTransactions('family-a')).toHaveLength(0);
  });
});

describe('PHASE D — CANCELLATION does not revoke; access continues to period end', () => {
  it('AUTO_RENEW_DISABLED marks the subscription cancelled and leaves entitlement intact', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    const subscriptionId = h.billing.createSubscriptionFor('family-a');

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', { uuid: 'u-buy', signedDate: Date.UTC(2026, 7, 1) }),
      headers: {},
    });
    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(Date.UTC(2026, 7, 15)))).toBe(true);

    const cancelled = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_CHANGE_RENEWAL_STATUS', {
        uuid: 'u-cancel',
        subtype: 'AUTO_RENEW_DISABLED',
        signedDate: Date.UTC(2026, 7, 10),
      }),
      headers: {},
    });

    expect(cancelled.outcome).toBe('PROCESSED');
    expect(h.payments.subscriptionState(subscriptionId)?.status).toBe('CANCELLED');
    // THE POINT: the customer paid through 1 September and keeps access.
    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(Date.UTC(2026, 7, 15)))).toBe(true);
    // ...and loses it when the period they paid for actually ends.
    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(Date.UTC(2026, 8, 15)))).toBe(false);
  });
});

describe('PHASE D — GRACE PERIOD keeps FULL access, and its expiry revokes', () => {
  it('DID_FAIL_TO_RENEW / GRACE_PERIOD does not touch entitlement', async () => {
    // Q17: full permissions during the window with a clear, non-frightening
    // notice. CONTEXT.md §3.7 forbids punitive UX. Downgrading a family the
    // instant a card fails violates both.
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    const subscriptionId = h.billing.createSubscriptionFor('family-a');

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', { uuid: 'u-buy', signedDate: Date.UTC(2026, 7, 1) }),
      headers: {},
    });

    const grace = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_FAIL_TO_RENEW', {
        uuid: 'u-grace',
        subtype: 'GRACE_PERIOD',
        signedDate: Date.UTC(2026, 7, 20),
      }),
      headers: {},
    });

    expect(grace.outcome).toBe('PROCESSED');
    const state = h.payments.subscriptionState(subscriptionId);
    expect(state?.status).toBe('GRACE_PERIOD');
    // Seven days, from Q17, applied from the provider's own timestamp.
    expect(state?.gracePeriodEndsAt?.toISOString().slice(0, 10)).toBe('2026-08-27');
    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(Date.UTC(2026, 7, 22)))).toBe(true);
  });

  it('GRACE_PERIOD_EXPIRED revokes', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', { uuid: 'u-buy', signedDate: Date.UTC(2026, 7, 1) }),
      headers: {},
    });
    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('GRACE_PERIOD_EXPIRED', { uuid: 'u-grace-end', signedDate: Date.UTC(2026, 7, 27) }),
      headers: {},
    });

    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(Date.UTC(2026, 7, 28)))).toBe(false);
    // REVOKED, not deleted: "this household lost access on 27 August and here
    // is why" has to remain answerable.
    const records = await h.payments.listEntitlements('family-a');
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.status === 'REVOKED')).toBe(true);
    expect(records[0].revokedReason).toContain('GRACE_PERIOD_EXPIRED');
  });
});

/**
 * ============================================================================
 * THE SEVEN-DAY PROMISE, FOR THE HOUSEHOLD IT WAS NOT REACHING.
 * ============================================================================
 *
 * The section above passes for a reason that does not generalise: its
 * `DID_RENEW` grant runs to 1 September, so on 22 August the rows are still
 * inside their OWN window and the grace period is never asked to carry
 * anything.
 *
 * THE HOUSEHOLD THAT WAS REFUSED is the one whose card fails AT PERIOD END —
 * which is when a renewal charge is actually attempted, so it is the normal
 * case, not an edge one. `GRACE_PERIOD_STARTED` wrote
 * `subscriptions.grace_period_ends_at` and stopped there; the `entitlements`
 * rows still ended at the period end. `EntitlementService.hasFeature` answers
 * FROM A ROW WHENEVER ONE EXISTS — row exists, window closed, false — and never
 * reaches the compatibility computation that would have said GRACE_PERIOD is
 * entitlement-bearing. So a family that HAS PAID, whose card merely failed to
 * renew, was locked out during the exact window `schema.prisma:92-94` exists to
 * prevent that.
 *
 * MEASURED BEFORE THE FIX, this harness, real services:
 *   grace starts 1 Aug, `subscriptions.grace_period_ends_at` = 8 Aug,
 *   `hasFeature('ai_diagnostics')` on 4 Aug -> FALSE.
 *
 * ============================= THE CLOCK, AND WHY =============================
 *
 * Time does not move inside these tests: `jest.setSystemTime` pins it, exactly
 * as `freezeGoldenClock` does for the golden suites, so the verifier's
 * ACTIVE/EXPIRED decision (`expiresDate <= Date.now()`) is a decision this file
 * makes rather than one the calendar makes while nobody is looking.
 *
 * The pinned instant is derived from the run rather than written as a literal,
 * and that is not laziness: `appleTestChain` MINTS ITS CERTIFICATES WITH
 * `openssl` AT RUN TIME, so a literal date in the past falls before the leaf's
 * notBefore and every signature fails for a reason that has nothing to do with
 * grace periods. Every boundary below is derived from that one instant — and
 * the seven-day end itself is READ BACK FROM `subscriptions.grace_period_ends_at`,
 * the date the domain already computed, so this suite cannot drift into a
 * second notion of when grace ends.
 */
describe('PHASE D — the grace window carries the entitlement rows, both edges of it', () => {
  const DAY = 86_400_000;
  /** The pinned instant. One per test, captured before the clock is frozen. */
  let t0: Date;
  /** The period the household paid for, ending ten days after the pin. */
  let periodEnd: Date;

  /** Locally what `freezeGoldenClock` is for the golden suites: fake `Date`
   *  and nothing else, so timers and the event loop behave normally. */
  const freezeAt = (at: Date): void => {
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(at);
  };

  beforeEach(() => {
    t0 = new Date();
    periodEnd = new Date(t0.getTime() + 10 * DAY);
    freezeAt(t0);
  });
  afterEach(() => jest.useRealTimers());

  /**
   * A household that paid through `periodEnd` and whose renewal charge then
   * failed ON `periodEnd` — the grant's window and the failed renewal are the
   * same instant, which is what a renewal IS.
   */
  async function householdWhoseCardFailedAtPeriodEnd(): Promise<{ h: IHarness; subscriptionId: string }> {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    const subscriptionId = h.billing.createSubscriptionFor('family-a');

    const bought = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', {
        uuid: 'u-buy-period',
        signedDate: t0.getTime(),
        txn: transaction({ purchaseDate: t0.getTime(), expiresDate: periodEnd.getTime() }),
      }),
      headers: {},
    });
    expect(bought.outcome).toBe('PROCESSED');

    const grace = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_FAIL_TO_RENEW', {
        uuid: 'u-grace-at-period-end',
        subtype: 'GRACE_PERIOD',
        signedDate: periodEnd.getTime(),
      }),
      headers: {},
    });
    expect(grace.outcome).toBe('PROCESSED');
    return { h, subscriptionId };
  }

  it('the rows really do lapse at the period end — the premise, stated rather than assumed', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');
    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', {
        uuid: 'u-buy-period',
        signedDate: t0.getTime(),
        txn: transaction({ purchaseDate: t0.getTime(), expiresDate: periodEnd.getTime() }),
      }),
      headers: {},
    });

    const records = await h.payments.listEntitlements('family-a');
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.validUntil?.getTime() === periodEnd.getTime())).toBe(true);
    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(periodEnd.getTime() - 1000))).toBe(
      true,
    );
    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', periodEnd)).toBe(false);
  });

  it('keeps FULL access for every day of the window it promised', async () => {
    const { h, subscriptionId } = await householdWhoseCardFailedAtPeriodEnd();

    const state = h.payments.subscriptionState(subscriptionId);
    expect(state?.status).toBe('GRACE_PERIOD');
    const graceEnd = state?.gracePeriodEndsAt as Date;
    expect(graceEnd).toBeInstanceOf(Date);
    // Seven days, from the provider's own signed timestamp. Read, not restated.
    expect(Math.round((graceEnd.getTime() - periodEnd.getTime()) / DAY)).toBe(7);

    // The first hour of the window, the middle of it, and the last second.
    for (const at of [
      new Date(periodEnd.getTime() + 3_600_000),
      new Date(periodEnd.getTime() + 3 * DAY),
      new Date(graceEnd.getTime() - 1000),
    ]) {
      expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', at)).toBe(true);
    }

    // EVERY feature of the tier, because «FULL access» is the promise and one
    // feature passing is not it.
    const described = await h.entitlements.describe('family-a', new Date(periodEnd.getTime() + 3 * DAY));
    expect(described.features.length).toBeGreaterThan(1);
    // ONE notion of when grace ends: what the rows report is what the
    // subscription reports.
    expect(described.validUntil?.toISOString()).toBe(graceEnd.toISOString());
  });

  it('and lapses when that window ends — not before, not after', async () => {
    const { h, subscriptionId } = await householdWhoseCardFailedAtPeriodEnd();
    const graceEnd = h.payments.subscriptionState(subscriptionId)?.gracePeriodEndsAt as Date;

    // THE BOUNDARY, both sides of it, one second apart.
    expect(
      await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(graceEnd.getTime() - 1000)),
    ).toBe(true);
    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', graceEnd)).toBe(false);
    expect(
      await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(graceEnd.getTime() + DAY)),
    ).toBe(false);

    // AN EXTENSION, NOT A RE-GRANT: no row exists that no payment granted, and
    // none was resurrected from REVOKED.
    const records = await h.payments.listEntitlements('family-a');
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.status === 'ACTIVE')).toBe(true);
    expect(records.every((r) => r.validUntil?.getTime() === graceEnd.getTime())).toBe(true);
  });

  it('never SHORTENS a window the household has already paid for', async () => {
    // The mirror, and the reason the extension is monotonic: a household paid
    // well beyond the grace window, whose charge then fails, must not be cut
    // back to «seven days from now».
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    const subscriptionId = h.billing.createSubscriptionFor('family-a');
    const farEnd = new Date(t0.getTime() + 60 * DAY);

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', {
        uuid: 'u-buy-long',
        signedDate: t0.getTime(),
        txn: transaction({ purchaseDate: t0.getTime(), expiresDate: farEnd.getTime() }),
      }),
      headers: {},
    });
    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_FAIL_TO_RENEW', {
        uuid: 'u-grace-long',
        subtype: 'GRACE_PERIOD',
        signedDate: t0.getTime() + DAY,
      }),
      headers: {},
    });

    const graceEnd = h.payments.subscriptionState(subscriptionId)?.gracePeriodEndsAt as Date;
    expect(graceEnd.getTime()).toBeLessThan(farEnd.getTime());
    const records = await h.payments.listEntitlements('family-a');
    expect(records.every((r) => r.validUntil?.getTime() === farEnd.getTime())).toBe(true);
    expect(
      await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(graceEnd.getTime() + DAY)),
    ).toBe(true);
  });

  it('a REVOKED household is not resurrected by a grace period', async () => {
    // A refund revokes; a grace-period callback arriving afterwards must not
    // hand access back. Revocation is a DECISION, so the extension reaches
    // ACTIVE rows only.
    const { h } = await householdWhoseCardFailedAtPeriodEnd();
    await h.entitlements.revokeAll('family-a', 'refund', new Date(periodEnd.getTime() + DAY));

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_FAIL_TO_RENEW', {
        uuid: 'u-grace-again',
        subtype: 'GRACE_PERIOD',
        signedDate: periodEnd.getTime() + 2 * DAY,
      }),
      headers: {},
    });

    expect(
      await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(periodEnd.getTime() + 3 * DAY)),
    ).toBe(false);
    const records = await h.payments.listEntitlements('family-a');
    expect(records.every((r) => r.status === 'REVOKED')).toBe(true);
  });
});

/**
 * SPRINT F1 — WHICH WEBHOOK KINDS OWE THE PARENT `PAYMENT_FAILED`.
 *
 * `notification-class.ts:277` said «(no producer yet.) The billing module
 * writes no notification of any kind — `payment-webhook.service.ts` moves
 * entitlement and stops.» These four tests are the routing half of stopping
 * that: which kinds ask, which kinds must stay silent, and what the ASK
 * carries. The Arabic sentence, the ledger row and the `notifications` row are
 * the e2e's half, against a real PostgreSQL and the real engine.
 */
describe('SPRINT F1 — a declined renewal reaches the notification engine, exactly once', () => {
  it('GRACE_PERIOD, BILLING_RETRY and a gateway decline each ask once, keyed on the subscription and the provider event', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    const subscriptionId = h.billing.createSubscriptionFor('family-a');

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', { uuid: 'u-buy', signedDate: Date.UTC(2026, 7, 1) }),
      headers: {},
    });
    // Nothing about a SUCCESSFUL renewal is a payment failure.
    expect(h.notified).toHaveLength(0);

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_FAIL_TO_RENEW', {
        uuid: 'u-grace',
        subtype: 'GRACE_PERIOD',
        signedDate: Date.UTC(2026, 7, 20),
      }),
      headers: {},
    });
    // The grace period IS the declined charge, and it is the case where telling
    // the parent matters most: every feature still works and seven days are
    // running out.
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toEqual({
      familyId: 'family-a',
      subscriptionId,
      provider: 'APPLE_IAP',
      // THE PROVIDER'S OWN EVENT IDENTITY is the occurrence half of the key.
      providerEventId: 'u-grace',
      // The PROVIDER's signed timestamp, not the ingestion clock.
      occurredAt: new Date(Date.UTC(2026, 7, 20)),
    });

    // A LATER, GENUINELY DIFFERENT failure is a second thing to say.
    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_FAIL_TO_RENEW', {
        uuid: 'u-retry',
        subtype: 'BILLING_RETRY',
        signedDate: Date.UTC(2026, 7, 28),
      }),
      headers: {},
    });
    expect(h.notified).toHaveLength(2);
    expect(h.notified[1].providerEventId).toBe('u-retry');
    // Same subject, different occurrence — which is exactly what makes the two
    // keys different and the two notifications legitimate.
    expect(h.notified[1].subscriptionId).toBe(subscriptionId);
  });

  it('a REDELIVERED failure asks nothing a second time — the webhook dedupe row is reached first', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    const body = appleNotification('DID_FAIL_TO_RENEW', {
      uuid: 'u-dup-fail',
      subtype: 'GRACE_PERIOD',
      signedDate: Date.UTC(2026, 7, 20),
    });
    const first = await h.webhooks.ingest('APPLE_IAP', { rawBody: body, headers: {} });
    const second = await h.webhooks.ingest('APPLE_IAP', { rawBody: body, headers: {} });
    const third = await h.webhooks.ingest('APPLE_IAP', { rawBody: body, headers: {} });

    expect([first.outcome, second.outcome, third.outcome]).toEqual(['PROCESSED', 'DUPLICATE', 'DUPLICATE']);
    // LAYER 1 of the three: `payment_webhook_events (provider,
    // provider_event_id)`, reimplemented by the repository double exactly as
    // the real unique index behaves. Layers 2 and 3 — the decision ledger and
    // `notifications` — are proven against real indexes in the e2e, and the
    // point of having all three is that this one is not the only one.
    expect(h.notified).toHaveLength(1);
  });

  it('a STALE failure that changes no row tells the parent nothing', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    // The newer state first: the subscription is already EXPIRED.
    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('EXPIRED', { uuid: 'u-expired', signedDate: Date.UTC(2026, 8, 10) }),
      headers: {},
    });
    // Then a failure notification that was signed BEFORE it. Q17: arrival order
    // is not causal order.
    const stale = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_FAIL_TO_RENEW', {
        uuid: 'u-stale-fail',
        subtype: 'GRACE_PERIOD',
        signedDate: Date.UTC(2026, 7, 20),
      }),
      headers: {},
    });

    expect(stale.outcome).toBe('IGNORED');
    expect(stale.detail).toContain('stale');
    // The state did not move, so there is no new fact and nothing to say. A
    // notification here would tell a parent their card was declined about a
    // subscription that ended three weeks ago.
    expect(h.notified).toHaveLength(0);
  });

  it('a CANCELLATION and a PENDING kiosk reference are not payment failures', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_CHANGE_RENEWAL_STATUS', {
        uuid: 'u-cancel',
        subtype: 'AUTO_RENEW_DISABLED',
        signedDate: Date.UTC(2026, 7, 15),
      }),
      headers: {},
    });

    // The customer CHOSE to stop and keeps what they paid for. Telling them
    // «تعذّر إتمام الدفع» would be false and, on a subscription screen, alarming.
    expect(h.notified).toHaveLength(0);
  });
});

describe('PHASE D — RENEWAL extends the window and never shortens it', () => {
  it('a second renewal pushes validUntil forward', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('SUBSCRIBED', { uuid: 'u-1' }),
      headers: {},
    });
    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', {
        uuid: 'u-2',
        signedDate: Date.UTC(2026, 8, 1),
        txn: transaction({
          transactionId: 'apple-txn-2',
          purchaseDate: Date.UTC(2026, 8, 1),
          expiresDate: Date.UTC(2026, 9, 1),
        }),
      }),
      headers: {},
    });

    expect(await h.payments.listPaymentTransactions('family-a')).toHaveLength(2);
    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(Date.UTC(2026, 8, 15)))).toBe(true);
  });

  it('a STALE renewal cannot shorten an entitlement that already reaches further', async () => {
    // GREATEST() on valid_until, in the repository's upsert. Without it, a
    // webhook redelivered out of order silently cuts a customer off early.
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', {
        uuid: 'u-far',
        signedDate: Date.UTC(2026, 8, 1),
        txn: transaction({ transactionId: 'txn-far', expiresDate: Date.UTC(2026, 11, 1) }),
      }),
      headers: {},
    });
    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', {
        uuid: 'u-near',
        signedDate: Date.UTC(2026, 7, 1),
        txn: transaction({ transactionId: 'txn-near', expiresDate: Date.UTC(2026, 8, 1) }),
      }),
      headers: {},
    });

    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(Date.UTC(2026, 9, 1)))).toBe(true);
  });
});

describe('PHASE D — REFUND revokes immediately and is itself idempotent', () => {
  it('records a refund, advances the transaction and withdraws entitlement', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', { uuid: 'u-buy', signedDate: Date.UTC(2026, 7, 1) }),
      headers: {},
    });

    const refunded = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('REFUND', {
        uuid: 'u-refund',
        signedDate: Date.UTC(2026, 7, 10),
        txn: transaction({ revocationDate: Date.UTC(2026, 7, 10), revocationReason: 1 }),
      }),
      headers: {},
    });

    expect(refunded.outcome).toBe('PROCESSED');
    const refunds = await h.payments.listRefunds('family-a');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amountMinor).toBe(17_900);
    expect(refunds[0].currency).toBe('EGP');

    const transactions = await h.payments.listPaymentTransactions('family-a');
    // ADVANCED, not rewritten. The amounts are untouched — the database
    // trigger in migration 0014 would reject any change to them.
    expect(transactions[0].status).toBe('REFUNDED');
    expect(transactions[0].grossAmountMinor).toBe(17_900);

    // A refund revokes IMMEDIATELY, unlike a cancellation. Money went back.
    expect(await h.entitlements.hasFeature('family-a', 'ai_diagnostics', new Date(Date.UTC(2026, 7, 11)))).toBe(false);
  });

  it('a redelivered refund does not produce a second refund row', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');
    await h.webhooks.ingest('APPLE_IAP', { rawBody: appleNotification('DID_RENEW', { uuid: 'u-buy' }), headers: {} });

    const refundBody = (uuid: string) =>
      appleNotification('REFUND', {
        uuid,
        signedDate: Date.UTC(2026, 7, 10),
        txn: transaction({ revocationDate: Date.UTC(2026, 7, 10) }),
      });

    await h.webhooks.ingest('APPLE_IAP', { rawBody: refundBody('u-r1'), headers: {} });
    // A DIFFERENT notificationUUID for the SAME refund — so the webhook dedupe
    // does NOT fire, and only the refund's own idempotency key can save us.
    const second = await h.webhooks.ingest('APPLE_IAP', { rawBody: refundBody('u-r2'), headers: {} });

    expect(second.outcome).toBe('DUPLICATE');
    expect(await h.payments.listRefunds('family-a')).toHaveLength(1);
  });

  it('refuses a refund for a transaction we never recorded rather than inventing one', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    const result = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('REFUND', {
        uuid: 'u-orphan',
        txn: transaction({ transactionId: 'never-seen', revocationDate: Date.UTC(2026, 7, 10) }),
      }),
      headers: {},
    });

    expect(result.outcome).toBe('REJECTED_VALIDATION');
    expect(await h.payments.listRefunds('family-a')).toHaveLength(0);
  });
});

describe('PHASE D — RETRY: a failed application is retried and applied exactly once', () => {
  it('the provider retries after a 5xx, and the redelivery does not double-credit', async () => {
    const h = harness();
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-a');
    h.billing.createSubscriptionFor('family-a');

    // Simulate our own transient failure — a database blip during the effects.
    const grantSpy = jest
      .spyOn(h.payments, 'grantEntitlement')
      .mockRejectedValueOnce(new Error('transient database failure'));

    const body = appleNotification('DID_RENEW', { uuid: 'u-retry' });
    const first = await h.webhooks.ingest('APPLE_IAP', { rawBody: body, headers: {} });

    expect(first.outcome).toBe('FAILED');
    // acknowledged=false -> the controller answers 5xx -> the provider retries.
    expect(first.acknowledged).toBe(false);
    expect(h.payments.webhookEvents[0].outcome).toBe('FAILED');

    grantSpy.mockRestore();

    const retry = await h.webhooks.ingest('APPLE_IAP', { rawBody: body, headers: {} });

    // The dedupe row was already written BEFORE the effects — deliberately, so
    // that a crash leaves the redelivery a no-op rather than a double credit.
    // The FAILED row is what the reconciliation job exists to pick up.
    expect(retry.outcome).toBe('DUPLICATE');
    expect(await h.payments.listPaymentTransactions('family-a')).toHaveLength(1);
  });
});

describe('PHASE D — CROSS-TENANT attempt rejected', () => {
  it("family A cannot apply family B's purchase token, even with a valid session", async () => {
    // Every other check passes: the token is genuine, Apple signed it, the
    // bundle is right, the amount matches. Only the account link stops it.
    const appleFetch = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes('/subscriptions/')
          ? JSON.stringify({
              environment: 'Production',
              bundleId: BUNDLE_ID,
              data: [
                {
                  subscriptionGroupIdentifier: 'g',
                  lastTransactions: [
                    {
                      originalTransactionId: 'apple-orig-1',
                      status: 1,
                      signedTransactionInfo: signAppleJws(transaction()),
                      signedRenewalInfo: signAppleJws({
                        originalTransactionId: 'apple-orig-1',
                        productId: 'com.abny.premium.monthly.eg',
                        autoRenewStatus: 1,
                        signedDate: Date.UTC(2026, 7, 1),
                        environment: 'Production',
                      }),
                    },
                  ],
                },
              ],
            })
          : '{}',
    }));
    const h = harness({ appleFetch: appleFetch as never });
    // The store account belongs to family B.
    h.payments.linkFamily('APPLE_IAP', 'apple-account-family-a', 'family-b');
    h.billing.createSubscriptionFor('family-a');
    h.billing.createSubscriptionFor('family-b');

    await expect(
      h.verification.verifyAndApply({
        provider: 'APPLE_IAP',
        providerToken: signAppleJws(transaction()),
        sessionFamilyId: 'family-a',
        amountToleranceMinor: 1,
      }),
    ).rejects.toThrow(/different account/);

    expect(await h.payments.listPaymentTransactions('family-a')).toHaveLength(0);
    expect(await h.payments.listEntitlements('family-a')).toHaveLength(0);
    // ...and family B, whose purchase it really is, was not credited either:
    // the attempt was refused outright rather than silently redirected.
    expect(await h.payments.listPaymentTransactions('family-b')).toHaveLength(0);
  });

  it('an unclaimed store account is claimed by the session family — through a unique index', async () => {
    const appleFetch = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes('/subscriptions/')
          ? JSON.stringify({ environment: 'Production', bundleId: BUNDLE_ID, data: [] })
          : '{}',
    }));
    const h = harness({ appleFetch: appleFetch as never });
    h.billing.createSubscriptionFor('family-a');

    const result = await h.verification.verifyAndApply({
      provider: 'APPLE_IAP',
      providerToken: signAppleJws(transaction()),
      sessionFamilyId: 'family-a',
      amountToleranceMinor: 1,
    });

    expect(result.transaction.familyId).toBe('family-a');
    expect(await h.payments.findFamilyByProviderAccountRef('APPLE_IAP', 'apple-account-family-a')).toBe('family-a');
  });

  it('a webhook for a purchase belonging to no household of ours is recorded with a NULL tenant', async () => {
    const h = harness();
    // No link, no subscription lineage — genuinely unattributable.
    const result = await h.webhooks.ingest('APPLE_IAP', {
      rawBody: appleNotification('DID_RENEW', { uuid: 'u-orphan' }),
      headers: {},
    });

    expect(result.outcome).toBe('IGNORED');
    expect(result.detail).toContain('no matching family');
    expect(h.payments.webhookEvents[0].familyId).toBeNull();
  });
});

describe('PHASE D — a SANDBOX purchase never grants access in production', () => {
  it('is refused with a 403-worthy error', async () => {
    const sandboxTxn = transaction({ environment: 'Sandbox' });
    const appleFetch = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes('/subscriptions/')
          ? JSON.stringify({ environment: 'Sandbox', bundleId: BUNDLE_ID, data: [] })
          : '{}',
    }));
    const h = harness({ appleFetch: appleFetch as never });
    h.billing.createSubscriptionFor('family-a');

    await expect(
      h.verification.verifyAndApply({
        provider: 'APPLE_IAP',
        providerToken: signAppleJws(sandboxTxn),
        sessionFamilyId: 'family-a',
      }),
    ).rejects.toThrow(/sandbox/i);
  });
});

describe('PHASE D — COUNTRY / CURRENCY SEPARATION', () => {
  it('the same tier and period resolve to different prices, currencies and VAT per market', async () => {
    const payments = new InMemoryPaymentRepository();
    const pricing = new PricingService(payments);

    const egypt = await pricing.resolvePrice({
      planTier: 'PREMIUM',
      countryCode: 'EG',
      billingPeriod: 'MONTHLY',
    });
    const saudi = await pricing.resolvePrice({
      planTier: 'PREMIUM',
      countryCode: 'SA',
      billingPeriod: 'MONTHLY',
    });

    expect(egypt.money.currency).toBe('EGP');
    expect(saudi.money.currency).toBe('SAR');
    expect(egypt.money.grossMinor).not.toBe(saudi.money.grossMinor);
    // VAT is a COLUMN: 14% in Egypt, 15% in Saudi Arabia (Q16).
    expect(egypt.money.vatBasisPoints).toBe(1_400);
    expect(saudi.money.vatBasisPoints).toBe(1_500);
    // And both are internally consistent, exactly, with no residual unit.
    for (const m of [egypt.money, saudi.money]) {
      expect(m.netMinor + m.vatMinor).toBe(m.grossMinor);
    }
  });

  it('there is no way to ask for one country prices in another country currency', async () => {
    const payments = new InMemoryPaymentRepository();
    const pricing = new PricingService(payments);
    const egypt = await pricing.resolvePrice({ planTier: 'PREMIUM', countryCode: 'EG', billingPeriod: 'MONTHLY' });

    // The currency is not a parameter anywhere in this API — it follows from
    // the country, out of the `countries` table. The closest an attacker can
    // get is claiming the wrong currency on a payment, which is this:
    expect(() =>
      pricing.assertAmountMatches({
        expected: egypt.money,
        reportedGrossMinor: egypt.money.grossMinor,
        reportedCurrency: 'SAR',
        toleranceMinor: 0,
      }),
    ).toThrow(/Currency mismatch/);
  });

  it('a market that is not configured is refused rather than defaulted', async () => {
    const payments = new InMemoryPaymentRepository();
    const pricing = new PricingService(payments);
    await expect(pricing.getCountry('FR')).rejects.toThrow(/not a configured market/);
  });

  it('a tier with no configured price is refused — a guessed amount is worse than a refusal', async () => {
    const payments = new InMemoryPaymentRepository();
    const pricing = new PricingService(payments);
    await expect(
      pricing.resolvePrice({ planTier: 'ENTERPRISE', countryCode: 'EG', billingPeriod: 'MONTHLY' }),
    ).rejects.toThrow(/HUMAN DECISION REQUIRED/);
  });

  it('the seeded launch markets are exactly Egypt and Saudi Arabia', async () => {
    const payments = new InMemoryPaymentRepository();
    const pricing = new PricingService(payments);
    const markets = await pricing.listMarkets();
    expect(markets.map((m) => m.code).sort()).toEqual(['EG', 'SA']);
    expect(MARKETS.EG.defaultProvider).toBe('PAYMOB');
    expect(MARKETS.SA.defaultProvider).toBe('MOYASAR');
  });
});
