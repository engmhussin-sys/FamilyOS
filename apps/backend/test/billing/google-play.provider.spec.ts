import * as crypto from 'crypto';

import { ConfigService } from '@nestjs/config';

import {
  GooglePlayProvider,
  GooglePlayVerificationError,
  googleMoneyToMinor,
  mapNotificationKind,
  mapSubscriptionState,
} from '../../src/modules/billing/infrastructure/adapters/google-play.provider';
import { PlayDeveloperApiClient } from '../../src/modules/billing/infrastructure/google/play-developer-api.client';
import type { FetchLike } from '../../src/modules/billing/infrastructure/google/play-developer-api.client';
import type {
  IGoogleDeveloperNotification,
  IGoogleSubscriptionPurchaseV2,
} from '../../src/modules/billing/infrastructure/google/google-play.types';

/**
 * PHASE D — GOOGLE PLAY BILLING, SERVER-SIDE.
 *
 * MOCKED: Google's HTTP responses (the OAuth token endpoint and
 *         `purchases.subscriptionsv2.get`).
 * NOT MOCKED: the state mapping, the money conversion, the notification-type
 *         table, the package check, the Pub/Sub envelope decoding, the tenant
 *         reference extraction. All production code.
 *
 * SANDBOX VERIFICATION AGAINST REAL GOOGLE SERVERS IS BLOCKED — no Play
 * Console account, no published package, no linked GCP project, no service
 * account, no Pub/Sub topic, no licence tester. None may be invented.
 */

const PACKAGE_NAME = 'com.abny.app';
const SERVICE_ACCOUNT = 'abny-play@abny.iam.gserviceaccount.com';
const PUBSUB_AUDIENCE = 'https://api.abny.app/webhooks/payments/google';

/** An RSA key for the service-account assertion. Ours, not Google's. */
const rsaKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

function config(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
    GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY: rsaKey,
    GOOGLE_PLAY_PACKAGE_NAME: PACKAGE_NAME,
    GOOGLE_PUBSUB_AUDIENCE: PUBSUB_AUDIENCE,
    GOOGLE_PUBSUB_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function purchase(overrides: Partial<IGoogleSubscriptionPurchaseV2> = {}): IGoogleSubscriptionPurchaseV2 {
  return {
    regionCode: 'SA',
    startTime: '2026-08-01T00:00:00Z',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    latestOrderId: 'GPA.3300-1234-5678-90123',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    externalAccountIdentifiers: { obfuscatedExternalAccountId: 'obf-family-a' },
    lineItems: [
      {
        productId: 'abny_premium',
        expiryTime: '2026-09-01T00:00:00Z',
        autoRenewingPlan: {
          autoRenewEnabled: true,
          // 34.00 SAR = {units: "34", nanos: 0} -> 3400 minor units.
          recurringPrice: { currencyCode: 'SAR', units: '34', nanos: 0 },
        },
        offerDetails: { basePlanId: 'premium-monthly' },
      },
    ],
    ...overrides,
  };
}

/** Mocks GOOGLE'S HTTP RESPONSES. Nothing else. */
function fetchReturning(bodies: Record<string, unknown>, options: { failWith?: number } = {}): FetchLike {
  return jest.fn(async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'at-1', expires_in: 3600 }) };
    }
    if (options.failWith) {
      return { ok: false, status: options.failWith, text: async () => '{"error":"nope"}' };
    }
    const match = Object.keys(bodies).find((fragment) => url.includes(fragment));
    if (!match) return { ok: false, status: 404, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(bodies[match]) };
  });
}

function pubsubEnvelope(notification: IGoogleDeveloperNotification, messageId = 'msg-1'): string {
  return JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify(notification), 'utf8').toString('base64'),
      messageId,
      publishTime: '2026-08-16T12:00:00Z',
    },
    subscription: 'projects/abny/subscriptions/play-rtdn',
  });
}

function oidcToken(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.signature-not-checked-here`;
}

const validOidcHeaders = () => ({
  authorization: `Bearer ${oidcToken({
    aud: PUBSUB_AUDIENCE,
    email: SERVICE_ACCOUNT,
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 600,
  })}`,
});

describe('GooglePlayProvider — verifyPurchase (HAPPY PATH)', () => {
  it('reads every fact from an authenticated subscriptionsv2.get, not from the client', async () => {
    const provider = new GooglePlayProvider(
      config(),
      fetchReturning({ '/purchases/subscriptionsv2/tokens/': purchase() }),
    );

    const verified = await provider.verifyPurchase({ providerToken: 'token-abc', familyId: 'family-a' });

    expect(verified.provider).toBe('GOOGLE_PLAY');
    // The per-charge id. A renewal produces a NEW order id under the SAME
    // purchase token — which is exactly the distinction between "this charge"
    // and "this subscription lineage".
    expect(verified.providerTransactionId).toBe('GPA.3300-1234-5678-90123');
    expect(verified.providerOriginalTransactionId).toBe('token-abc');
    expect(verified.productRef).toBe('premium-monthly');
    expect(verified.currency).toBe('SAR');
    expect(verified.grossAmountMinor).toBe(3_400);
    expect(verified.countryCode).toBe('SA');
    expect(verified.status).toBe('ACTIVE');
    expect(verified.autoRenewing).toBe(true);
    expect(verified.isSandbox).toBe(false);
    // THE TENANT LINK — from Google's answer.
    expect(verified.providerAccountRef).toBe('obf-family-a');
  });

  it('calls the documented endpoint with a bearer token obtained from the OAuth flow', async () => {
    const fetchImpl = fetchReturning({ '/purchases/subscriptionsv2/tokens/': purchase() });
    const provider = new GooglePlayProvider(config(), fetchImpl);
    await provider.verifyPurchase({ providerToken: 'token-abc', familyId: 'family-a' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptionsv2/tokens/token-abc`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer at-1' }) }),
    );
  });

  it('detects a licence-tester purchase by the PRESENCE of testPurchase, not its truthiness', async () => {
    // `testPurchase` is `{}` when present and absent otherwise. `=== true`
    // would treat every licence-tester purchase as real money.
    const provider = new GooglePlayProvider(
      config(),
      fetchReturning({ '/purchases/subscriptionsv2/tokens/': purchase({ testPurchase: {} }) }),
    );
    const verified = await provider.verifyPurchase({ providerToken: 'token-abc', familyId: 'family-a' });
    expect(verified.isSandbox).toBe(true);
  });

  it('does not leak the purchase token into an error message when Google refuses', async () => {
    const provider = new GooglePlayProvider(config(), fetchReturning({}, { failWith: 410 }));
    await expect(provider.verifyPurchase({ providerToken: 'secret-token', familyId: 'family-a' })).rejects.toThrow(
      /responded 410/,
    );
    await expect(provider.verifyPurchase({ providerToken: 'secret-token', familyId: 'family-a' })).rejects.not.toThrow(
      /secret-token/,
    );
  });

  it('refuses without credentials rather than degrading', async () => {
    const provider = new GooglePlayProvider(config({ GOOGLE_PLAY_PACKAGE_NAME: undefined }), fetchReturning({}));
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.verifyPurchase({ providerToken: 't', familyId: 'f' })).rejects.toThrow(/not configured/);
  });
});

describe('GooglePlayProvider — Pub/Sub push authentication', () => {
  it('accepts a token with the configured audience and service account', async () => {
    const provider = new GooglePlayProvider(config(), fetchReturning({}));
    const result = await provider.verifyWebhookSignature({
      rawBody: pubsubEnvelope({ version: '1.0', packageName: PACKAGE_NAME, eventTimeMillis: '1' }),
      headers: validOidcHeaders(),
    });
    expect(result.verified).toBe(true);
  });

  it.each([
    ['no bearer token', {}],
    [
      'wrong audience',
      {
        authorization: `Bearer ${oidcToken({ aud: 'https://evil.example', email: SERVICE_ACCOUNT, exp: Math.floor(Date.now() / 1000) + 600 })}`,
      },
    ],
    [
      'wrong service account',
      {
        authorization: `Bearer ${oidcToken({ aud: PUBSUB_AUDIENCE, email: 'attacker@example.com', exp: Math.floor(Date.now() / 1000) + 600 })}`,
      },
    ],
    [
      'expired token',
      {
        authorization: `Bearer ${oidcToken({ aud: PUBSUB_AUDIENCE, email: SERVICE_ACCOUNT, exp: Math.floor(Date.now() / 1000) - 10 })}`,
      },
    ],
    ['non-JWT bearer', { authorization: 'Bearer not-a-jwt' }],
  ])('rejects: %s', async (_label, headers) => {
    const provider = new GooglePlayProvider(config(), fetchReturning({}));
    const result = await provider.verifyWebhookSignature({
      rawBody: pubsubEnvelope({ version: '1.0', packageName: PACKAGE_NAME, eventTimeMillis: '1' }),
      headers: headers as Record<string, string | undefined>,
    });
    expect(result.verified).toBe(false);
  });
});

describe('GooglePlayProvider — RTDN parsing', () => {
  it('carries NO purchase data — by design, the notification is a doorbell', async () => {
    const provider = new GooglePlayProvider(config(), fetchReturning({}));
    const event = await provider.parseWebhook({
      rawBody: pubsubEnvelope({
        version: '1.0',
        packageName: PACKAGE_NAME,
        eventTimeMillis: String(Date.UTC(2026, 7, 16)),
        subscriptionNotification: {
          version: '1.0',
          notificationType: 2, // SUBSCRIPTION_RENEWED
          purchaseToken: 'token-abc',
          subscriptionId: 'abny_premium',
        },
      }),
      headers: validOidcHeaders(),
    });

    expect(event.kind).toBe('RENEWED');
    // Google's own reference: «After receiving an RTDN, call the Google Play
    // Developer API to get complete purchase status.» So this is null, on
    // purpose, and the handler must ask Google.
    expect(event.verifiedPurchase).toBeNull();
    expect(event.providerOriginalTransactionId).toBe('token-abc');
    // Pub/Sub's messageId — stable across its own redeliveries.
    expect(event.providerEventId).toBe('msg-1');
  });

  it('REJECTS A NOTIFICATION FOR ANOTHER DEVELOPER PACKAGE', async () => {
    const provider = new GooglePlayProvider(config(), fetchReturning({}));
    await expect(
      provider.parseWebhook({
        rawBody: pubsubEnvelope({
          version: '1.0',
          packageName: 'com.someone.else',
          eventTimeMillis: '1',
          subscriptionNotification: {
            version: '1.0',
            notificationType: 4,
            purchaseToken: 't',
            subscriptionId: 's',
          },
        }),
        headers: validOidcHeaders(),
      }),
    ).rejects.toBeInstanceOf(GooglePlayVerificationError);
  });

  it('maps a voided purchase to a refund and takes the amount from nowhere — Google sends none', async () => {
    const provider = new GooglePlayProvider(config(), fetchReturning({}));
    const event = await provider.parseWebhook({
      rawBody: pubsubEnvelope({
        version: '1.0',
        packageName: PACKAGE_NAME,
        eventTimeMillis: String(Date.UTC(2026, 7, 16)),
        voidedPurchaseNotification: {
          purchaseToken: 'token-abc',
          orderId: 'GPA.3300-1234-5678-90123',
          productType: 1,
          refundType: 1,
        },
      }),
      headers: validOidcHeaders(),
    });

    expect(event.kind).toBe('REFUNDED');
    expect(event.refund?.providerTransactionId).toBe('GPA.3300-1234-5678-90123');
    // NULL is the honest value; the handler reads the amount from the original
    // transaction we recorded, which is the only trustworthy source anyway.
    expect(event.refund?.amountMinor).toBeNull();
    expect(event.refund?.currency).toBeNull();
  });

  it('maps a test notification without touching any subscription', async () => {
    const provider = new GooglePlayProvider(config(), fetchReturning({}));
    const event = await provider.parseWebhook({
      rawBody: pubsubEnvelope({
        version: '1.0',
        packageName: PACKAGE_NAME,
        eventTimeMillis: '1',
        testNotification: { version: '1.0' },
      }),
      headers: validOidcHeaders(),
    });
    expect(event.kind).toBe('TEST');
  });
});

describe('GooglePlayProvider — the SubscriptionState table', () => {
  it.each([
    ['SUBSCRIPTION_STATE_ACTIVE', 'ACTIVE'],
    ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'GRACE_PERIOD'],
    ['SUBSCRIPTION_STATE_ON_HOLD', 'PAST_DUE'],
    ['SUBSCRIPTION_STATE_PENDING', 'PENDING'],
    ['SUBSCRIPTION_STATE_EXPIRED', 'EXPIRED'],
    ['SUBSCRIPTION_STATE_PAUSED', 'EXPIRED'],
    ['SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', 'CANCELLED'],
  ] as const)('%s -> %s', (state, expected) => {
    expect(mapSubscriptionState(state)).toBe(expected);
  });

  it('CANCELED means "cancelled but not expired yet" — access continues to expiryTime', () => {
    // Mapping this to something that revokes immediately takes away access the
    // customer has already paid for. Same trap as Apple's AUTO_RENEW_DISABLED.
    expect(mapSubscriptionState('SUBSCRIPTION_STATE_CANCELED')).toBe('CANCELLED');
  });

  it('FAILS CLOSED on an unspecified or future state — never ACTIVE', () => {
    expect(mapSubscriptionState('SUBSCRIPTION_STATE_UNSPECIFIED')).toBe('EXPIRED');
    expect(mapSubscriptionState('SOMETHING_GOOGLE_ADDS_IN_2027' as never)).toBe('EXPIRED');
  });
});

describe('GooglePlayProvider — the RTDN notificationType table', () => {
  it.each([
    [4, 'PURCHASED'],
    [2, 'RENEWED'],
    [1, 'RENEWED'],
    [7, 'RENEWED'],
    [6, 'GRACE_PERIOD_STARTED'],
    [5, 'BILLING_RETRY'],
    [3, 'CANCELLED'],
    [18, 'CANCELLED'],
    [12, 'REVOKED'],
    [13, 'EXPIRED'],
    [10, 'EXPIRED'],
    [9, 'UNHANDLED'],
    [19, 'UNHANDLED'],
  ] as const)('type %i -> %s', (type, expected) => {
    expect(mapNotificationKind(type)).toBe(expected);
  });
});

describe('googleMoneyToMinor', () => {
  it('converts units + nanos to minor units without a float in the middle', () => {
    // `units` is an int64 as a STRING; a nano is 1e-9 units, i.e. 1e-7 minor
    // units. Getting the scale wrong by a factor of ten is the classic bug.
    expect(googleMoneyToMinor({ units: '34', nanos: 0 })).toBe(3_400);
    expect(googleMoneyToMinor({ units: '0', nanos: 990_000_000 })).toBe(99);
    expect(googleMoneyToMinor({ units: '99', nanos: 990_000_000 })).toBe(9_999);
    expect(googleMoneyToMinor({ units: '1', nanos: 500_000_000 })).toBe(150);
    expect(googleMoneyToMinor(undefined)).toBe(0);
  });
});

describe('PlayDeveloperApiClient — the service-account assertion', () => {
  it('signs RS256 with the documented issuer, scope and audience', () => {
    const client = new PlayDeveloperApiClient(
      { clientEmail: SERVICE_ACCOUNT, privateKeyPem: rsaKey, packageName: PACKAGE_NAME },
      fetchReturning({}),
      () => new Date('2026-08-16T12:00:00Z'),
    );
    const segments = client.createAssertion().split('.');
    expect(segments).toHaveLength(3);
    const header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toMatchObject({
      iss: SERVICE_ACCOUNT,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
    });
  });

  it('caches the access token instead of paying an OAuth round trip per webhook', async () => {
    const fetchImpl = fetchReturning({ '/purchases/subscriptionsv2/tokens/': purchase() });
    const client = new PlayDeveloperApiClient(
      { clientEmail: SERVICE_ACCOUNT, privateKeyPem: rsaKey, packageName: PACKAGE_NAME },
      fetchImpl,
    );
    await client.getSubscriptionV2('t1');
    await client.getSubscriptionV2('t2');
    const tokenCalls = (fetchImpl as jest.Mock).mock.calls.filter(([url]: [string]) => url.includes('oauth2'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('acknowledges through the v1 subscriptions resource — subscriptionsv2 has no acknowledge method', async () => {
    // Not pedantry: Google AUTOMATICALLY REFUNDS AND CANCELS any purchase not
    // acknowledged within three days.
    const fetchImpl = fetchReturning({ ':acknowledge': {} });
    const client = new PlayDeveloperApiClient(
      { clientEmail: SERVICE_ACCOUNT, privateKeyPem: rsaKey, packageName: PACKAGE_NAME },
      fetchImpl,
    );
    await client.acknowledgeSubscription('abny_premium', 'token-abc');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/purchases/subscriptions/abny_premium/tokens/token-abc:acknowledge'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
