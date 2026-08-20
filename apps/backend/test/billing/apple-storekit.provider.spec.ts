import { ConfigService } from '@nestjs/config';

import {
  AppleStoreKitProvider,
  AppleVerificationError,
  mapAppleStatus,
  mapNotificationKind,
} from '../../src/modules/billing/infrastructure/adapters/apple-storekit.provider';
import { AppStoreServerApiClient } from '../../src/modules/billing/infrastructure/apple/app-store-server-api.client';
import type { FetchLike } from '../../src/modules/billing/infrastructure/apple/app-store-server-api.client';
import type {
  IAppleJwsRenewalInfoPayload,
  IAppleJwsTransactionPayload,
} from '../../src/modules/billing/infrastructure/apple/apple-storekit.types';
import { appleTestChain, buildForeignChainJws, signAppleJws, tamperPayload } from './apple-chain.fixture';

/**
 * PHASE D — APPLE STOREKIT 2, SERVER-SIDE.
 *
 * WHAT IS MOCKED AND WHAT IS NOT, stated plainly because it is the difference
 * between a test and a decoration:
 *
 *   MOCKED: Apple's HTTP responses (`fetchImpl`) and Apple's signing key (a
 *           locally generated chain, pinned as the test root).
 *   NOT MOCKED: `AppleJwsVerifier`, the certificate-chain walk, the ES256
 *           signature check, the bundle-id comparison, the status mapping,
 *           the price conversion, the notification-type table. All production
 *           code, all executed.
 *
 * SANDBOX VERIFICATION AGAINST REAL APPLE SERVERS IS BLOCKED — there is no App
 * Store Connect account, no Issuer ID, no Key ID, no `.p8`, no bundle id, and
 * none of those may be invented. These tests prove the ALGORITHM. They do not
 * prove interoperability, and the report says so in those words.
 */

const BUNDLE_ID = 'com.abny.app';
const chain = appleTestChain();

/** A private key for the App Store Server API JWT — ours, not Apple's. */
const apiPrivateKey = chain.leafPrivateKeyPem;

function config(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    APPLE_ISSUER_ID: '57246542-96fe-1a63-e053-0824d011072a',
    APPLE_KEY_ID: '2X9R4HXF34',
    APPLE_PRIVATE_KEY: apiPrivateKey,
    APPLE_BUNDLE_ID: BUNDLE_ID,
    APPLE_ROOT_CA_G3_FINGERPRINT: chain.rootFingerprint,
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function transaction(overrides: Partial<IAppleJwsTransactionPayload> = {}): IAppleJwsTransactionPayload {
  return {
    transactionId: '2000000123456789',
    originalTransactionId: '2000000000000001',
    bundleId: BUNDLE_ID,
    productId: 'com.abny.premium.monthly',
    purchaseDate: Date.UTC(2026, 7, 1),
    originalPurchaseDate: Date.UTC(2026, 7, 1),
    expiresDate: Date.UTC(2026, 8, 1),
    type: 'Auto-Renewable Subscription',
    appAccountToken: 'account-token-family-a',
    inAppOwnershipType: 'PURCHASED',
    signedDate: Date.UTC(2026, 7, 1),
    environment: 'Production',
    storefront: 'EGY',
    // Apple reports price in MILLI-units: 99000 milli-EGP = 99.00 EGP = 9900
    // minor units. Getting this scale wrong makes every transaction look 10x
    // too large, and round numbers hide it.
    price: 99_000,
    currency: 'EGP',
    ...overrides,
  };
}

function renewalInfo(overrides: Partial<IAppleJwsRenewalInfoPayload> = {}): IAppleJwsRenewalInfoPayload {
  return {
    originalTransactionId: '2000000000000001',
    productId: 'com.abny.premium.monthly',
    autoRenewStatus: 1,
    signedDate: Date.UTC(2026, 7, 1),
    environment: 'Production',
    ...overrides,
  };
}

/** Mocks APPLE'S HTTP RESPONSES. Nothing else. */
function fetchReturning(bodies: Record<string, unknown>): FetchLike {
  return jest.fn(async (url: string) => {
    const match = Object.keys(bodies).find((fragment) => url.includes(fragment));
    if (!match) {
      return { ok: false, status: 404, text: async () => '{}' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(bodies[match]) };
  });
}

function statusResponse(appleStatus: 1 | 2 | 3 | 4 | 5, renewal = renewalInfo(), txn = transaction()) {
  return {
    environment: 'Production',
    bundleId: BUNDLE_ID,
    data: [
      {
        subscriptionGroupIdentifier: 'group-1',
        lastTransactions: [
          {
            originalTransactionId: txn.originalTransactionId,
            status: appleStatus,
            signedTransactionInfo: signAppleJws(txn),
            signedRenewalInfo: signAppleJws(renewal),
          },
        ],
      },
    ],
  };
}

describe('AppleStoreKitProvider — verifyPurchase (HAPPY PATH)', () => {
  it('verifies a client-supplied JWSTransaction and reports Apple-derived facts only', async () => {
    const txn = transaction();
    const provider = new AppleStoreKitProvider(
      config(),
      fetchReturning({ '/inApps/v1/subscriptions/': statusResponse(1) }),
    );

    const verified = await provider.verifyPurchase({
      providerToken: signAppleJws(txn),
      familyId: 'family-a',
    });

    expect(verified.provider).toBe('APPLE_IAP');
    expect(verified.providerTransactionId).toBe('2000000123456789');
    expect(verified.providerOriginalTransactionId).toBe('2000000000000001');
    expect(verified.productRef).toBe('com.abny.premium.monthly');
    // THE MILLI-UNIT CONVERSION. 99000 milli-EGP -> 9900 minor units.
    expect(verified.grossAmountMinor).toBe(9_900);
    expect(verified.currency).toBe('EGP');
    // Apple storefronts are ISO alpha-3; our `countries` table is alpha-2.
    expect(verified.countryCode).toBe('EG');
    expect(verified.billingPeriod).toBe('MONTHLY');
    expect(verified.status).toBe('ACTIVE');
    expect(verified.autoRenewing).toBe(true);
    expect(verified.isSandbox).toBe(false);
    expect(verified.providerAccountRef).toBe('account-token-family-a');
    expect(verified.verifiedPayloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a bare transactionId by fetching the signed transaction FROM Apple', async () => {
    const txn = transaction();
    const fetchImpl = fetchReturning({
      '/inApps/v1/transactions/': { signedTransactionInfo: signAppleJws(txn) },
      '/inApps/v1/subscriptions/': statusResponse(1),
    });
    const provider = new AppleStoreKitProvider(config(), fetchImpl);

    const verified = await provider.verifyPurchase({ providerToken: '2000000123456789', familyId: 'family-a' });
    expect(verified.providerTransactionId).toBe('2000000123456789');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/inApps/v1/transactions/2000000123456789'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }) }),
    );
  });

  it('re-reads CURRENT status from Apple: a genuinely signed receipt for a revoked subscription is not ACTIVE', async () => {
    // The receipt itself is real and signed. Only Apple can say it is dead.
    // A verifier that stopped at the JWS would grant access here.
    const provider = new AppleStoreKitProvider(
      config(),
      fetchReturning({ '/inApps/v1/subscriptions/': statusResponse(5) }),
    );
    const verified = await provider.verifyPurchase({
      providerToken: signAppleJws(transaction()),
      familyId: 'family-a',
    });
    expect(verified.status).toBe('REFUNDED');
  });
});

describe('AppleStoreKitProvider — verifyPurchase (REJECTIONS)', () => {
  it('rejects a JWS signed by a chain that is not the pinned Apple root', async () => {
    const provider = new AppleStoreKitProvider(config(), fetchReturning({}));
    await expect(
      provider.verifyPurchase({ providerToken: buildForeignChainJws(transaction()), familyId: 'family-a' }),
    ).rejects.toBeInstanceOf(AppleVerificationError);
  });

  it('rejects a receipt whose amount was tampered with after Apple signed it', async () => {
    const provider = new AppleStoreKitProvider(config(), fetchReturning({}));
    const tampered = tamperPayload(signAppleJws(transaction()), (p) => {
      p.price = 1;
    });
    await expect(provider.verifyPurchase({ providerToken: tampered, familyId: 'family-a' })).rejects.toThrow(
      /did not verify/,
    );
  });

  it('REJECTS A GENUINELY APPLE-SIGNED RECEIPT FOR ANOTHER DEVELOPER APP', async () => {
    // This is a real and easy attack: buy a $0.99 subscription in someone
    // else's app, present the receipt here. Everything verifies — Apple really
    // did sign it. Only the bundle-id comparison distinguishes it.
    const provider = new AppleStoreKitProvider(
      config(),
      fetchReturning({ '/inApps/v1/subscriptions/': statusResponse(1) }),
    );
    const foreignApp = signAppleJws(transaction({ bundleId: 'com.someone.else' }));
    await expect(provider.verifyPurchase({ providerToken: foreignApp, familyId: 'family-a' })).rejects.toThrow(
      /not this application/,
    );
  });

  it('flags a sandbox purchase rather than treating it as real', async () => {
    const sandbox = transaction({ environment: 'Sandbox' });
    const provider = new AppleStoreKitProvider(
      config(),
      fetchReturning({ '/inApps/v1/subscriptions/': statusResponse(1, renewalInfo(), sandbox) }),
    );
    const verified = await provider.verifyPurchase({ providerToken: signAppleJws(sandbox), familyId: 'family-a' });
    expect(verified.isSandbox).toBe(true);
  });

  it('is not configured — and refuses — without the root fingerprint', async () => {
    const provider = new AppleStoreKitProvider(
      config({ APPLE_ROOT_CA_G3_FINGERPRINT: undefined }),
      fetchReturning({}),
    );
    expect(provider.isConfigured()).toBe(false);
    await expect(
      provider.verifyPurchase({ providerToken: signAppleJws(transaction()), familyId: 'family-a' }),
    ).rejects.toThrow(/not configured/);
  });
});

describe('AppleStoreKitProvider — App Store Server Notifications V2', () => {
  const notification = (over: Record<string, unknown> = {}, txn = transaction(), renewal = renewalInfo()) =>
    JSON.stringify({
      signedPayload: signAppleJws({
        notificationType: 'DID_RENEW',
        notificationUUID: '00000000-0000-0000-0000-0000000000aa',
        version: '2.0',
        signedDate: Date.UTC(2026, 7, 1),
        data: {
          bundleId: BUNDLE_ID,
          environment: 'Production',
          signedTransactionInfo: signAppleJws(txn),
          signedRenewalInfo: signAppleJws(renewal),
        },
        ...over,
      }),
    });

  it('verifies the notification — the BODY is the signature; Apple sends no header', async () => {
    const provider = new AppleStoreKitProvider(config(), fetchReturning({}));
    const result = await provider.verifyWebhookSignature({ rawBody: notification(), headers: {} });
    expect(result.verified).toBe(true);
  });

  it('rejects a notification signed by a foreign chain', async () => {
    const provider = new AppleStoreKitProvider(config(), fetchReturning({}));
    const forged = JSON.stringify({
      signedPayload: buildForeignChainJws({
        notificationType: 'DID_RENEW',
        notificationUUID: 'forged',
        version: '2.0',
        signedDate: Date.now(),
        data: { bundleId: BUNDLE_ID, environment: 'Production' },
      }),
    });
    const result = await provider.verifyWebhookSignature({ rawBody: forged, headers: {} });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('pinned Apple root');
  });

  it('rejects a notification for a different bundle id', async () => {
    const provider = new AppleStoreKitProvider(config(), fetchReturning({}));
    const other = JSON.stringify({
      signedPayload: signAppleJws({
        notificationType: 'DID_RENEW',
        notificationUUID: 'x',
        version: '2.0',
        signedDate: Date.now(),
        data: { bundleId: 'com.someone.else', environment: 'Production' },
      }),
    });
    const result = await provider.verifyWebhookSignature({ rawBody: other, headers: {} });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('different bundle id');
  });

  it('VERIFIES THE NESTED JWS SEPARATELY — the envelope signature does not vouch for its contents', async () => {
    const provider = new AppleStoreKitProvider(config(), fetchReturning({}));
    // A genuine outer notification carrying a transaction blob signed by a
    // foreign chain. If only the envelope were checked, this would be accepted.
    const mixed = JSON.stringify({
      signedPayload: signAppleJws({
        notificationType: 'DID_RENEW',
        notificationUUID: 'mixed',
        version: '2.0',
        signedDate: Date.now(),
        data: {
          bundleId: BUNDLE_ID,
          environment: 'Production',
          signedTransactionInfo: buildForeignChainJws(transaction({ price: 1 })),
        },
      }),
    });
    expect((await provider.verifyWebhookSignature({ rawBody: mixed, headers: {} })).verified).toBe(true);
    await expect(provider.parseWebhook({ rawBody: mixed, headers: {} })).rejects.toThrow(/did not verify/);
  });

  it('parses a renewal into a provider-neutral event with Apple own dedupe key', async () => {
    const provider = new AppleStoreKitProvider(config(), fetchReturning({}));
    const event = await provider.parseWebhook({ rawBody: notification(), headers: {} });
    expect(event.provider).toBe('APPLE_IAP');
    // `notificationUUID` — stable across Apple redeliveries, which is what
    // makes the dedupe unique index work.
    expect(event.providerEventId).toBe('00000000-0000-0000-0000-0000000000aa');
    expect(event.kind).toBe('RENEWED');
    expect(event.verifiedPurchase?.grossAmountMinor).toBe(9_900);
    expect(event.providerAccountRef).toBe('account-token-family-a');
  });

  it('peekEventId reads the dedupe key from an UNVERIFIED body, so the dedupe row is written first', async () => {
    const provider = new AppleStoreKitProvider(config(), fetchReturning({}));
    expect(provider.peekEventId(notification())).toBe('00000000-0000-0000-0000-0000000000aa');
    expect(provider.peekEventId('garbage')).toBeNull();
  });
});

describe('AppleStoreKitProvider — the notificationType table', () => {
  it.each([
    ['SUBSCRIBED', 'INITIAL_BUY', 'PURCHASED'],
    ['SUBSCRIBED', 'RESUBSCRIBE', 'PURCHASED'],
    ['DID_RENEW', undefined, 'RENEWED'],
    ['DID_RENEW', 'BILLING_RECOVERY', 'RENEWED'],
    ['DID_FAIL_TO_RENEW', 'GRACE_PERIOD', 'GRACE_PERIOD_STARTED'],
    ['DID_FAIL_TO_RENEW', undefined, 'BILLING_RETRY'],
    ['GRACE_PERIOD_EXPIRED', undefined, 'GRACE_PERIOD_EXPIRED'],
    ['EXPIRED', 'VOLUNTARY', 'EXPIRED'],
    ['EXPIRED', 'BILLING_RETRY', 'EXPIRED'],
    ['REFUND', undefined, 'REFUNDED'],
    ['REFUND_REVERSED', undefined, 'REFUND_REVERSED'],
    ['REVOKE', undefined, 'REVOKED'],
    ['TEST', undefined, 'TEST'],
    ['CONSUMPTION_REQUEST', undefined, 'UNHANDLED'],
    ['PRICE_INCREASE', 'PENDING', 'UNHANDLED'],
  ] as const)('%s / %s -> %s', (type, subtype, expected) => {
    expect(mapNotificationKind(type, subtype)).toBe(expected);
  });

  it('DID_CHANGE_RENEWAL_STATUS / AUTO_RENEW_DISABLED is a CANCELLATION, not a revocation', () => {
    // The customer has paid through the end of the period and keeps access.
    // Treating this as an immediate revocation takes away something already
    // paid for — the single most common way to get this wrong.
    expect(mapNotificationKind('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED')).toBe('CANCELLED');
    expect(mapNotificationKind('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_ENABLED')).toBe('RENEWED');
  });
});

describe('AppleStoreKitProvider — status mapping', () => {
  it('prefers Apple numeric status from the authenticated API call', () => {
    expect(mapAppleStatus(transaction(), renewalInfo(), 1)).toBe('ACTIVE');
    expect(mapAppleStatus(transaction(), renewalInfo(), 2)).toBe('EXPIRED');
    expect(mapAppleStatus(transaction(), renewalInfo(), 3)).toBe('PAST_DUE');
    expect(mapAppleStatus(transaction(), renewalInfo(), 4)).toBe('GRACE_PERIOD');
    expect(mapAppleStatus(transaction(), renewalInfo(), 5)).toBe('REFUNDED');
  });

  it('a revocationDate beats every other signal — a refunded transaction is REFUNDED', () => {
    expect(mapAppleStatus(transaction({ revocationDate: Date.now() }), renewalInfo(), 1)).toBe('REFUNDED');
  });

  it('falls back to renewal-info fields on the webhook path where no API status exists', () => {
    expect(mapAppleStatus(transaction(), renewalInfo({ gracePeriodExpiresDate: Date.now() + 1000 }), null)).toBe(
      'GRACE_PERIOD',
    );
    expect(mapAppleStatus(transaction(), renewalInfo({ isInBillingRetryPeriod: true }), null)).toBe('PAST_DUE');
    expect(mapAppleStatus(transaction({ expiresDate: Date.now() - 1000 }), renewalInfo(), null)).toBe('EXPIRED');
  });
});

describe('AppStoreServerApiClient — the JWT Apple documents', () => {
  it('signs ES256 with the documented header and payload, and keeps exp inside the 60-minute ceiling', () => {
    const now = new Date('2026-08-16T12:00:00Z');
    const client = new AppStoreServerApiClient(
      {
        issuerId: 'issuer-1',
        keyId: 'KEY123',
        privateKeyPem: apiPrivateKey,
        bundleId: BUNDLE_ID,
        useSandbox: false,
      },
      fetchReturning({}),
      () => now,
    );

    const segments = client.createJwt().split('.');
    expect(segments).toHaveLength(3);
    const header = decodeSegment(segments[0]);
    const payload = decodeSegment(segments[1]);
    expect(header).toMatchObject({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    expect(payload).toMatchObject({ iss: 'issuer-1', aud: 'appstoreconnect-v1', bid: BUNDLE_ID });
    const lifetime = (payload as { exp: number; iat: number }).exp - (payload as { iat: number }).iat;
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(3600);
  });

  it('targets the sandbox base URL when configured to', async () => {
    const fetchImpl = fetchReturning({ '/inApps/v1/subscriptions/': statusResponse(1) });
    const client = new AppStoreServerApiClient(
      { issuerId: 'i', keyId: 'k', privateKeyPem: apiPrivateKey, bundleId: BUNDLE_ID, useSandbox: true },
      fetchImpl,
    );
    await client.getSubscriptionStatuses('orig-1');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('api.storekit-sandbox.itunes.apple.com'),
      expect.anything(),
    );
  });
});

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}
