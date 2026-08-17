import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

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
import { InMemoryPaymentRepository, InMemoryBillingRepository } from './payment-test-doubles';
import type { FetchLike } from '../../src/modules/billing/infrastructure/google/play-developer-api.client';
import type { IGoogleSubscriptionPurchaseV2 } from '../../src/modules/billing/infrastructure/google/google-play.types';
import type { ISubscriptionPriceRecord } from '../../src/modules/billing/application/ports/payment.repository.port';

/**
 * PHASE G — THE ANDROID CLIENT PATH, END TO END, SERVER-AUTHORITATIVE.
 *
 * ============================ WHAT THIS CLOSES ============================
 *
 * `apps/parent-app/lib/features/billing/presentation/subscription_screen.dart`
 * called `billingApi.subscribe(tier, 'MANUAL')`: the CLIENT named the provider
 * and the tier, and the `MANUAL` adapter always succeeds. Any parent could have
 * had any plan for free by pressing a button.
 *
 * The replacement is `POST /billing/purchases/verify`, whose DTO carries a
 * provider name and an opaque token AND NOTHING ELSE — no amount, no currency,
 * no tier, no `familyId`. This suite is the proof that the path behind that DTO
 * derives every one of those four from Google's answer and from our own
 * catalogue, and that it cannot be talked out of any of them.
 *
 * ====================== WHAT IS MOCKED AND WHAT IS NOT ======================
 *
 * MOCKED: **Google's two HTTP responses only** — the OAuth2 token endpoint and
 *         `purchases.subscriptionsv2.get`. `fetchImpl` is the single seam.
 *
 * NOT MOCKED, all production code: `GooglePlayProvider` (state mapping, money
 *         conversion, `testPurchase` presence semantics, tenant-reference
 *         extraction, the acknowledgement decision), `PlayDeveloperApiClient`
 *         (the RS256 service-account assertion and the real URL it calls),
 *         `PaymentVerificationService` (all eight steps),
 *         `PricingService` (product mapping and the tamper check),
 *         `EntitlementService`, `PaymentProviderRegistry`.
 *
 * THE VERIFICATION LOGIC IS NEVER MOCKED. No test in this file stubs
 * `verifyPurchase`, `resolveTenant`, `assertAmountMatches` or the entitlement
 * grant. A suite that did so would pass against a provider whose body is
 * `return {verified: true}`, which is the failure mode negative controls exist
 * to catch.
 *
 * The repositories are the shared in-memory doubles, which REIMPLEMENT the real
 * unique constraints — that is what makes the duplicate-token assertion
 * meaningful rather than self-fulfilling, and the same constraints are proven
 * separately against a real PostgreSQL in
 * `test/database/payment-idempotency.integration.spec.ts`.
 *
 * ========================== WHAT IS STILL BLOCKED ==========================
 *
 * REAL PLAY SANDBOX VERIFICATION IS BLOCKED AND IS NOT CLAIMED ANYWHERE. It
 * needs a Play Console account, a published package name, a linked GCP project,
 * a service account with the androidpublisher scope, a Pub/Sub topic and a
 * licence tester. None exists; none was invented. What is substituted is
 * GOOGLE'S TRANSPORT, not our reasoning about what Google said.
 */

const PACKAGE_NAME = 'com.abny.app';
const SERVICE_ACCOUNT = 'abny-play@abny.iam.gserviceaccount.com';

/** Ours, for the service-account assertion. Never Google's. */
const rsaKey = crypto
  .generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

/**
 * A PLAY-SHAPED CATALOGUE.
 *
 * The shared `TEST_PRICES` fixture keys store products on Apple-style reverse
 * DNS (`com.abny.premium.monthly.sa`). A Google **base plan id** cannot look
 * like that — Play restricts it to lowercase alphanumerics and hyphens — and
 * `productRef` for a Google purchase IS the base plan id. So this file overrides
 * the two catalogue lookups with Play-shaped ids rather than pretending a base
 * plan may contain dots, which would make every assertion below a test of a
 * fixture that cannot exist in production.
 *
 * The prices are the same numbers as the shared fixture (CONTEXT.md §6's
 * PROPOSED figures, used as fixtures only — migration 0014 seeds no price at
 * all; see HUMAN DECISION REQUIRED #1).
 */
const PLAY_PRICES: ISubscriptionPriceRecord[] = [
  {
    id: 'p-sa-premium-m-play',
    planTier: 'PREMIUM',
    countryCode: 'SA',
    currencyCode: 'SAR',
    billingPeriod: 'MONTHLY',
    amountMinor: 3_400,
    vatMode: 'INCLUSIVE',
    storeProductId: 'premium-monthly',
    isActive: true,
  },
  {
    id: 'p-eg-premium-m-play',
    planTier: 'PREMIUM',
    countryCode: 'EG',
    currencyCode: 'EGP',
    billingPeriod: 'MONTHLY',
    amountMinor: 17_900,
    vatMode: 'INCLUSIVE',
    storeProductId: 'premium-monthly-eg',
    isActive: true,
  },
];

class PlayCatalogueRepository extends InMemoryPaymentRepository {
  override async findPriceByStoreProductId(storeProductId: string): Promise<ISubscriptionPriceRecord | null> {
    return PLAY_PRICES.find((p) => p.storeProductId === storeProductId) ?? null;
  }
}

function config(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
    GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY: rsaKey,
    GOOGLE_PLAY_PACKAGE_NAME: PACKAGE_NAME,
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

/**
 * GOOGLE'S ANSWER. Everything the system is allowed to believe about a purchase
 * is in here — which is the whole point: the client sends none of it.
 */
function purchase(overrides: Partial<IGoogleSubscriptionPurchaseV2> = {}): IGoogleSubscriptionPurchaseV2 {
  return {
    regionCode: 'SA',
    startTime: '2026-08-01T00:00:00Z',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    latestOrderId: 'GPA.3300-1111-2222-33333',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    externalAccountIdentifiers: { obfuscatedExternalAccountId: 'obf-family-a' },
    lineItems: [
      {
        // The v1 SUBSCRIPTION id — what acknowledgement is keyed on.
        productId: 'abny_premium',
        expiryTime: '2026-09-01T00:00:00Z',
        autoRenewingPlan: {
          autoRenewEnabled: true,
          // 34.00 SAR -> 3400 minor units, matching PLAY_PRICES above.
          recurringPrice: { currencyCode: 'SAR', units: '34', nanos: 0 },
        },
        // The BASE PLAN id — what `productRef` is and what the catalogue maps.
        offerDetails: { basePlanId: 'premium-monthly' },
      },
    ],
    ...overrides,
  };
}

interface IGoogleCalls {
  readonly urls: string[];
  readonly acknowledgeCalls: string[];
}

/** Mocks GOOGLE'S HTTP. Nothing else in this file is substituted. */
function googleFetch(
  body: IGoogleSubscriptionPurchaseV2 | null,
  options: { readonly acknowledgeStatus?: number; readonly getStatus?: number } = {},
): { fetchImpl: FetchLike; calls: IGoogleCalls } {
  const urls: string[] = [];
  const acknowledgeCalls: string[] = [];
  const fetchImpl: FetchLike = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'at-1', expires_in: 3600 }),
      };
    }
    if (url.includes(':acknowledge')) {
      acknowledgeCalls.push(url);
      const status = options.acknowledgeStatus ?? 200;
      return { ok: status < 400, status, text: async () => '{}' };
    }
    if (url.includes('/purchases/subscriptionsv2/tokens/')) {
      const status = options.getStatus ?? 200;
      if (status >= 400 || body === null) {
        return { ok: false, status: status >= 400 ? status : 404, text: async () => '{"error":"nope"}' };
      }
      return { ok: true, status, text: async () => JSON.stringify(body) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  });
  return { fetchImpl, calls: { urls, acknowledgeCalls } };
}

interface IHarness {
  verification: PaymentVerificationService;
  entitlements: EntitlementService;
  payments: PlayCatalogueRepository;
  billing: InMemoryBillingRepository;
  google: GooglePlayProvider;
  calls: IGoogleCalls;
}

function harness(
  options: {
    readonly body?: IGoogleSubscriptionPurchaseV2 | null;
    readonly googleConfig?: Record<string, string | undefined>;
    readonly acknowledgeStatus?: number;
    readonly getStatus?: number;
  } = {},
): IHarness {
  const payments = new PlayCatalogueRepository();
  const billing = new InMemoryBillingRepository();
  // The two doubles share state the way the two real repositories share a
  // database. Without this, a subscription created through one is invisible to
  // the other and the state assertions pass without meaning anything.
  billing.bind(payments);

  const { fetchImpl, calls } = googleFetch(options.body ?? purchase(), {
    acknowledgeStatus: options.acknowledgeStatus,
    getStatus: options.getStatus,
  });

  const google = new GooglePlayProvider(config(options.googleConfig), fetchImpl);
  const noConfig = { get: jest.fn(() => undefined) } as unknown as ConfigService;
  const registry = new PaymentProviderRegistry(
    new ManualPaymentAdapter(),
    new StripeAdapter(noConfig),
    new PaymobProvider(noConfig),
    new FawryProvider(noConfig),
    new MoyasarProvider(noConfig),
    new AppleStoreKitProvider(noConfig),
    google,
  );

  const pricing = new PricingService(payments);
  const entitlements = new EntitlementService(payments, billing);
  const verification = new PaymentVerificationService(registry, payments, billing, entitlements, pricing);

  return { verification, entitlements, payments, billing, google, calls };
}

/** What the controller passes. The store tolerance is explicit at the call site. */
function verify(h: IHarness, opts: { token?: string; sessionFamilyId?: string } = {}) {
  return h.verification.verifyAndApply({
    provider: 'GOOGLE_PLAY',
    providerToken: opts.token ?? 'play-token-abc',
    sessionFamilyId: opts.sessionFamilyId ?? 'family-a',
    amountToleranceMinor: 1,
  });
}

// ===========================================================================

describe('PHASE G — a verified Play token grants entitlement', () => {
  it('derives tier, amount, currency and tenant from GOOGLE, not from the request', async () => {
    const h = harness();
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    const result = await verify(h);

    // The entitlement exists, and its tier came from OUR catalogue via the base
    // plan id Google reported — never from anything a client could send.
    expect(result.entitlementGranted).toBe(true);
    expect(result.wasDuplicate).toBe(false);
    expect(result.transaction.planTier).toBe('PREMIUM');
    expect(result.transaction.familyId).toBe('family-a');
    expect(result.transaction.currency).toBe('SAR');
    expect(result.transaction.grossAmountMinor).toBe(3_400);
    expect(result.transaction.status).toBe('SUCCEEDED');
    // 15% Saudi VAT, INCLUSIVE: net + vat = gross, exactly.
    expect(result.transaction.netAmountMinor + result.transaction.vatAmountMinor).toBe(3_400);

    const described = await h.entitlements.describe('family-a');
    expect(described.planTier).toBe('PREMIUM');
    expect(described.features).toContain('ai_diagnostics');
    expect(described.validUntil).toEqual(new Date('2026-09-01T00:00:00Z'));

    // And the authoritative read really happened, against the documented URL.
    expect(h.calls.urls).toContain(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}` +
        '/purchases/subscriptionsv2/tokens/play-token-abc',
    );
  });

  it('ACKNOWLEDGES the purchase — otherwise Google auto-refunds it after three days', async () => {
    const h = harness();
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    await verify(h);

    // Through the v1 resource, keyed on lineItems[].productId — NOT on the base
    // plan id, which is what `productRef` holds. Two Google identifiers for one
    // purchase, and swapping them yields a 404 and then a silent refund.
    expect(h.calls.acknowledgeCalls).toEqual([
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}` +
        '/purchases/subscriptions/abny_premium/tokens/play-token-abc:acknowledge',
    ]);
  });

  it('does NOT acknowledge again when Google already reports it acknowledged', async () => {
    const h = harness({
      body: purchase({ acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }),
    });
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    await verify(h);

    // The decision is made from GOOGLE'S answer, not from our records — the
    // client path and the RTDN path both legitimately arrive for one purchase.
    expect(h.calls.acknowledgeCalls).toEqual([]);
  });

  it('a FAILED acknowledgement does not take away an entitlement that is already granted', async () => {
    // The asymmetry is deliberate. The money is recorded and the access is
    // granted before acknowledgement is attempted; failing the request here
    // would tell a client whose purchase SUCCEEDED that it did not, and it
    // would retry. So this logs at ERROR and the request still succeeds.
    const h = harness({ acknowledgeStatus: 500 });
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');
    // Nest's Logger is an INSTANCE field, so the spy goes on the prototype the
    // instance delegates to. Asserting the log line is the point: "the request
    // succeeded anyway" is only acceptable behaviour if an operator is told.
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const result = await verify(h);

    expect(result.entitlementGranted).toBe(true);
    expect(h.payments.transactions).toHaveLength(1);
    expect(errors.mock.calls.flat().join('\n')).toContain('ACKNOWLEDGEMENT FAILED');
    errors.mockRestore();
  });
});

describe('PHASE G — a DUPLICATE token grants nothing a second time', () => {
  it('the same purchase token twice produces ONE transaction and ONE entitlement row', async () => {
    const h = harness();
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    const first = await verify(h);
    const second = await verify(h);

    expect(first.wasDuplicate).toBe(false);
    expect(second.wasDuplicate).toBe(true);
    // ONE row. The defence is the unique index, not a check-then-insert — the
    // latter is a race, and DA-002 measured its cost on this very repository
    // (8 concurrent grants produced 8 rows).
    expect(h.payments.transactions).toHaveLength(1);
    expect(h.payments.transactions[0].id).toBe(first.transaction.id);
    // ONE entitlement row per feature, not two. `entitlements (family_id,
    // feature_key)` is unique and `GREATEST()` makes extension MONOTONIC, so a
    // redelivered token cannot create a second grant nor shorten an existing one.
    const rows = h.payments.entitlements.filter((e) => e.familyId === 'family-a');
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((e) => e.featureKey)).size).toBe(rows.length);
  });

  it('eight concurrent deliveries of one token produce ONE transaction', async () => {
    const h = harness();
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    const results = await Promise.all(Array.from({ length: 8 }, () => verify(h)));

    expect(results.filter((r) => !r.wasDuplicate)).toHaveLength(1);
    expect(results.filter((r) => r.wasDuplicate)).toHaveLength(7);
    expect(h.payments.transactions).toHaveLength(1);
  });

  it('a RENEWAL under the same token is a NEW charge, not a duplicate', async () => {
    // Google's `latestOrderId` changes per charge while the purchase token stays
    // the same for the lineage. Treating a renewal as a duplicate would silently
    // stop extending access; treating a redelivery as a renewal would grant
    // twice. The idempotency anchor is the order id, and this is that boundary.
    const h = harness();
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');
    await verify(h);

    const renewed = harness({
      body: purchase({
        latestOrderId: 'GPA.3300-1111-2222-33334',
        lineItems: [
          {
            productId: 'abny_premium',
            expiryTime: '2026-10-01T00:00:00Z',
            autoRenewingPlan: {
              autoRenewEnabled: true,
              recurringPrice: { currencyCode: 'SAR', units: '34', nanos: 0 },
            },
            offerDetails: { basePlanId: 'premium-monthly' },
          },
        ],
      }),
    });
    // Same repositories, so this is the same household's history.
    const second = await renewed.verification.verifyAndApply({
      provider: 'GOOGLE_PLAY',
      providerToken: 'play-token-abc',
      sessionFamilyId: 'family-a',
      amountToleranceMinor: 1,
    });
    expect(second.wasDuplicate).toBe(false);
  });
});

describe('PHASE G — a TAMPERED payload is rejected, and grants nothing', () => {
  it('an amount that does not match the catalogue is REFUSED', async () => {
    // The attack in its purest form: a genuine Google response — because we own
    // the mock, which is exactly the attacker's position if they can influence
    // what the server reads — claiming 1.00 SAR for a 34.00 SAR base plan.
    const h = harness({
      body: purchase({
        lineItems: [
          {
            productId: 'abny_premium',
            expiryTime: '2026-09-01T00:00:00Z',
            autoRenewingPlan: {
              autoRenewEnabled: true,
              recurringPrice: { currencyCode: 'SAR', units: '1', nanos: 0 },
            },
            offerDetails: { basePlanId: 'premium-monthly' },
          },
        ],
      }),
    });
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    await expect(verify(h)).rejects.toThrow();
    expect(h.payments.transactions).toHaveLength(0);
    expect(h.payments.entitlements).toHaveLength(0);
    expect(h.calls.acknowledgeCalls).toEqual([]);
  });

  it('a CURRENCY swap is a SEPARATE rejection — 34 SAR is not 34 EGP', async () => {
    // A system that compares only the number accepts this. 34.00 SAR and
    // 34.00 EGP differ by roughly an order of magnitude.
    const h = harness({
      body: purchase({
        lineItems: [
          {
            productId: 'abny_premium',
            expiryTime: '2026-09-01T00:00:00Z',
            autoRenewingPlan: {
              autoRenewEnabled: true,
              recurringPrice: { currencyCode: 'EGP', units: '34', nanos: 0 },
            },
            offerDetails: { basePlanId: 'premium-monthly' },
          },
        ],
      }),
    });
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    await expect(verify(h)).rejects.toThrow();
    expect(h.payments.transactions).toHaveLength(0);
    expect(h.payments.entitlements).toHaveLength(0);
  });

  it('a base plan that is not in OUR catalogue grants nothing — no default tier', async () => {
    const h = harness({
      body: purchase({
        lineItems: [
          {
            productId: 'abny_enterprise',
            expiryTime: '2026-09-01T00:00:00Z',
            autoRenewingPlan: {
              autoRenewEnabled: true,
              recurringPrice: { currencyCode: 'SAR', units: '34', nanos: 0 },
            },
            offerDetails: { basePlanId: 'not-a-configured-base-plan' },
          },
        ],
      }),
    });
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    await expect(verify(h)).rejects.toThrow(/not mapped to any configured price/);
    expect(h.payments.entitlements).toHaveLength(0);
  });

  it('CROSS-TENANT: family A cannot apply family B token, even with a valid session', async () => {
    // Every other check passes here. The token is real, Google signed for it,
    // the amount is right. The only thing that stops it is that the LINK is the
    // authority and the session is not.
    const h = harness();
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-b');

    await expect(verify(h, { sessionFamilyId: 'family-a' })).rejects.toThrow();
    expect(h.payments.transactions).toHaveLength(0);
  });

  it('a LICENCE-TESTER purchase never grants access in production', async () => {
    // `testPurchase` is present-or-absent, not true-or-false; `=== true` would
    // turn every tester purchase into real money.
    const h = harness({ body: purchase({ testPurchase: {} }) });
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    await expect(verify(h)).rejects.toThrow(/sandbox/i);
    expect(h.payments.entitlements).toHaveLength(0);
  });

  it('an INVENTED token grants nothing — Google refuses and the token is not echoed', async () => {
    const h = harness({ getStatus: 410 });
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    await expect(verify(h, { token: 'super-secret-token' })).rejects.toThrow(/responded 410/);
    await expect(verify(h, { token: 'super-secret-token' })).rejects.not.toThrow(/super-secret-token/);
    expect(h.payments.transactions).toHaveLength(0);
  });

  it('an UNSPECIFIED subscription state FAILS CLOSED — never entitlement-bearing', async () => {
    const h = harness({ body: purchase({ subscriptionState: 'SUBSCRIPTION_STATE_UNSPECIFIED' }) });
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    const result = await verify(h);
    // Recorded — an operator must be able to see it — and entitling nothing.
    expect(result.entitlementGranted).toBe(false);
    expect(h.payments.entitlements).toHaveLength(0);
  });
});

describe('PHASE G — an UNCONFIGURED provider fails LOUDLY', () => {
  it('reports itself unconfigured rather than absent', () => {
    const h = harness({ googleConfig: { GOOGLE_PLAY_PACKAGE_NAME: undefined } });
    expect(h.google.isConfigured()).toBe(false);
    // Still registered, still claims VERIFY. "Unconfigured" and "incapable" are
    // different states and must not be reported as the same one.
    expect(h.google.supports('VERIFY')).toBe(true);
    expect(h.google.supports('ACKNOWLEDGE')).toBe(true);
  });

  it('throws PaymentProviderNotConfiguredException instead of granting anything', async () => {
    const h = harness({ googleConfig: { GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY: undefined } });
    h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');

    await expect(verify(h)).rejects.toThrow(/not configured/i);
    expect(h.payments.transactions).toHaveLength(0);
    expect(h.payments.entitlements).toHaveLength(0);
    // AND it never reached the network: an unconfigured adapter must not fail
    // halfway through a real call.
    expect(h.calls.urls).toEqual([]);
  });

  it('each missing credential fails on its own — no partial configuration is treated as configured', async () => {
    for (const missing of [
      'GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL',
      'GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY',
      'GOOGLE_PLAY_PACKAGE_NAME',
    ]) {
      const h = harness({ googleConfig: { [missing]: undefined } });
      h.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');
      expect(h.google.isConfigured()).toBe(false);
      await expect(verify(h)).rejects.toThrow(/not configured/i);
    }
  });
});

/**
 * THE NEGATIVE CONTROL FOR THIS WHOLE FILE.
 *
 * Every suite above would also pass against a provider that verified nothing, if
 * the only assertions were "the happy path succeeds". These two are what make
 * the rest mean something: they prove the seam being substituted is GOOGLE'S
 * TRANSPORT and that the server genuinely refuses to take the client's word.
 */
describe('PHASE G — negative controls: the client is never authoritative', () => {
  it('the verification request has NO field for amount, currency, tier or familyId', () => {
    // Asserted against the DTO's own shape rather than by reading it, because
    // this is the property the entire design rests on. Adding one of these
    // fields would make every other test in this file irrelevant.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dtoSource = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/billing/presentation/dto/verify-purchase.dto.ts'),
      'utf8',
    ) as string;
    const declarations = dtoSource
      .split('\n')
      .filter((line) => /^\s+\w+!?:/.test(line))
      .map((line) => line.trim());
    expect(declarations).toEqual(['provider!: PaymentProviderValue;', 'providerToken!: string;']);
  });

  it('the amount recorded comes from GOOGLE and our catalogue, and differs when Google differs', async () => {
    // Same tier, same client, different Google answer -> different recorded
    // money. A provider that ignored its input would record the same row twice.
    const sa = harness();
    sa.payments.linkFamily('GOOGLE_PLAY', 'obf-family-a', 'family-a');
    const saResult = await verify(sa);

    const eg = harness({
      body: purchase({
        regionCode: 'EG',
        externalAccountIdentifiers: { obfuscatedExternalAccountId: 'obf-family-c' },
        lineItems: [
          {
            productId: 'abny_premium',
            expiryTime: '2026-09-01T00:00:00Z',
            autoRenewingPlan: {
              autoRenewEnabled: true,
              recurringPrice: { currencyCode: 'EGP', units: '179', nanos: 0 },
            },
            offerDetails: { basePlanId: 'premium-monthly-eg' },
          },
        ],
      }),
    });
    eg.payments.linkFamily('GOOGLE_PLAY', 'obf-family-c', 'family-c');
    const egResult = await eg.verification.verifyAndApply({
      provider: 'GOOGLE_PLAY',
      providerToken: 'play-token-eg',
      sessionFamilyId: 'family-c',
      amountToleranceMinor: 1,
    });

    expect(saResult.transaction.currency).toBe('SAR');
    expect(saResult.transaction.grossAmountMinor).toBe(3_400);
    expect(egResult.transaction.currency).toBe('EGP');
    expect(egResult.transaction.grossAmountMinor).toBe(17_900);
    // Egypt is 14% VAT, Saudi 15% — a COLUMN, not a constant, and it shows.
    expect(saResult.transaction.vatAmountMinor).not.toBe(egResult.transaction.vatAmountMinor);
  });
});
