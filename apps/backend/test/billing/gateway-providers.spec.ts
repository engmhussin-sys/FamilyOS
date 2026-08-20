import * as crypto from 'crypto';

import { ConfigService } from '@nestjs/config';

import {
  PAYMOB_HMAC_FIELDS,
  PaymobProvider,
  buildPaymobHmacString,
} from '../../src/modules/billing/infrastructure/adapters/paymob.provider';
import {
  FAWRY_SIGNATURE_FIELDS,
  FawryProvider,
  buildFawrySignatureString,
} from '../../src/modules/billing/infrastructure/adapters/fawry.provider';
import { MoyasarProvider } from '../../src/modules/billing/infrastructure/adapters/moyasar.provider';
import { PaymentProviderNotConfiguredException } from '../../src/modules/billing/domain/billing.errors';

/**
 * PHASE D — EGYPT AND SAUDI ARABIA.
 *
 * ================== WHAT THESE TESTS CAN AND CANNOT PROVE ==================
 *
 * NO MERCHANT CREDENTIALS EXIST FOR THIS PROJECT. Paymob, Fawry and the Saudi
 * gateway all require a completed merchant onboarding (commercial register, tax
 * card, local bank account, signatory documents — 4 to 8 realistic weeks per
 * Q15/Q16), and none of those may be invented.
 *
 * So what is proven here is the SIGNATURE ALGORITHM AND THE FAIL-CLOSED
 * POSTURE, using a test secret: a correctly computed signature is accepted, and
 * every kind of wrong one is refused. What is NOT proven is that our ordered
 * field list matches the vendor's — see `VERIFY BEFORE GO-LIVE` in each
 * adapter, and «افتراضات ومخاطر مفتوحة» in PHASE-D-Payments-Report.md.
 *
 * That distinction is the reason each field list is a SINGLE EXPORTED
 * CONSTANT: when an operator with access to the live documentation corrects
 * it, these tests keep passing (they compute the expected value from the same
 * constant) and the integration starts working. A field list scattered inline
 * would need the same correction in three places and would be corrected in two.
 */

const PAYMOB_SECRET = 'test-paymob-hmac-secret';
const FAWRY_KEY = 'test-fawry-security-key';
const MOYASAR_SECRET = 'test-moyasar-webhook-secret';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

// ===========================================================================
// PAYMOB — Egypt: cards, wallets, Fawry collection behind one integration.
// ===========================================================================

describe('PaymobProvider — HMAC-SHA512 callback verification', () => {
  const provider = () =>
    new PaymobProvider(
      config({
        PAYMOB_API_KEY: 'test-key',
        PAYMOB_HMAC_SECRET: PAYMOB_SECRET,
        PAYMOB_INTEGRATION_ID: '12345',
      }),
    );

  const transactionObject = (over: Record<string, unknown> = {}) => ({
    id: 987_654,
    amount_cents: 17_900,
    created_at: '2026-08-16T12:00:00Z',
    currency: 'EGP',
    error_occured: false,
    has_parent_transaction: false,
    integration_id: 12_345,
    is_3d_secure: true,
    is_auth: false,
    is_capture: false,
    is_refunded: false,
    is_standalone_payment: true,
    is_voided: false,
    owner: 4_242,
    pending: false,
    success: true,
    order: { id: 55_555, merchant_order_id: 'abny-order-1' },
    source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
    ...over,
  });

  const sign = (obj: Record<string, unknown>) =>
    crypto.createHmac('sha512', PAYMOB_SECRET).update(buildPaymobHmacString(obj)).digest('hex');

  it('accepts a correctly signed callback', async () => {
    const obj = transactionObject();
    const result = await provider().verifyWebhookSignature({
      rawBody: JSON.stringify({ type: 'TRANSACTION', obj }),
      headers: { 'x-paymob-hmac': sign(obj) },
    });
    expect(result.verified).toBe(true);
  });

  it('REJECTS a callback whose amount was changed after signing — the tampered-amount attack', async () => {
    const obj = transactionObject();
    const signature = sign(obj);
    const tampered = { ...obj, amount_cents: 1 };
    const result = await provider().verifyWebhookSignature({
      rawBody: JSON.stringify({ type: 'TRANSACTION', obj: tampered }),
      headers: { 'x-paymob-hmac': signature },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('does not match');
  });

  it('REJECTS a callback whose currency was changed after signing', async () => {
    const obj = transactionObject();
    const signature = sign(obj);
    const result = await provider().verifyWebhookSignature({
      rawBody: JSON.stringify({ type: 'TRANSACTION', obj: { ...obj, currency: 'SAR' } }),
      headers: { 'x-paymob-hmac': signature },
    });
    expect(result.verified).toBe(false);
  });

  it('REJECTS a callback flipped from failed to successful', async () => {
    const failed = transactionObject({ success: false });
    const signature = sign(failed);
    const result = await provider().verifyWebhookSignature({
      rawBody: JSON.stringify({ type: 'TRANSACTION', obj: { ...failed, success: true } }),
      headers: { 'x-paymob-hmac': signature },
    });
    expect(result.verified).toBe(false);
  });

  it('rejects a missing HMAC, a wrong-length HMAC, and a malformed body', async () => {
    const obj = transactionObject();
    const body = JSON.stringify({ type: 'TRANSACTION', obj });
    expect((await provider().verifyWebhookSignature({ rawBody: body, headers: {} })).verified).toBe(false);
    expect(
      (await provider().verifyWebhookSignature({ rawBody: body, headers: { 'x-paymob-hmac': 'short' } })).verified,
    ).toBe(false);
    expect(
      (await provider().verifyWebhookSignature({ rawBody: 'not json', headers: { 'x-paymob-hmac': sign(obj) } }))
        .verified,
    ).toBe(false);
  });

  it('FAILS CLOSED without the secret — refuses rather than skips', async () => {
    const unconfigured = new PaymobProvider(config({}));
    const obj = transactionObject();
    const result = await unconfigured.verifyWebhookSignature({
      rawBody: JSON.stringify({ obj }),
      headers: { 'x-paymob-hmac': sign(obj) },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('PAYMOB_HMAC_SECRET is not configured');
  });

  it('parses a successful callback, carrying OUR merchant reference for tenant resolution', async () => {
    const event = await provider().parseWebhook({
      rawBody: JSON.stringify({ type: 'TRANSACTION', obj: transactionObject() }),
      headers: {},
    });
    expect(event.provider).toBe('PAYMOB');
    expect(event.providerEventId).toBe('987654');
    expect(event.kind).toBe('PAYMENT_SUCCEEDED');
    // NO verified purchase from the callback: an HMAC proves WHO sent it, not
    // WHAT it should have said. The handler compares against our own order.
    expect(event.verifiedPurchase).toBeNull();
    // The reference WE generated at checkout — not anything an attacker sets.
    expect(event.providerAccountRef).toBe('abny-order-1');
  });

  it('maps a Fawry-style pending transaction to PAYMENT_PENDING, not to success', async () => {
    // Q15: Fawry collection through Paymob is NOT instant. The customer has a
    // reference and has not paid; treating this as success gives the product
    // away.
    const event = await provider().parseWebhook({
      rawBody: JSON.stringify({ type: 'TRANSACTION', obj: transactionObject({ pending: true, success: false }) }),
      headers: {},
    });
    expect(event.kind).toBe('PAYMENT_PENDING');
  });

  it('maps a refund and a void to REFUNDED', async () => {
    for (const flag of ['is_refund', 'is_voided']) {
      const event = await provider().parseWebhook({
        rawBody: JSON.stringify({ type: 'TRANSACTION', obj: transactionObject({ [flag]: true }) }),
        headers: {},
      });
      expect(event.kind).toBe('REFUNDED');
      expect(event.refund?.amountMinor).toBe(17_900);
      expect(event.refund?.currency).toBe('EGP');
    }
  });

  it('throws a typed 503 from every method that would need a real Paymob account', async () => {
    const unconfigured = new PaymobProvider(config({}));
    expect(unconfigured.isConfigured()).toBe(false);
    await expect(
      unconfigured.createCheckout({
        subscriptionId: 's',
        familyId: 'f',
        planTier: 'PREMIUM',
        billingPeriod: 'MONTHLY',
        countryCode: 'EG',
        currency: 'EGP',
        grossAmountMinor: 17_900,
      }),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredException);
    await expect(unconfigured.verifyPurchase({ providerToken: 't', familyId: 'f' })).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredException,
    );
    await expect(
      unconfigured.refund({ providerTransactionId: 't', amountMinor: 1, currency: 'EGP', reason: null, idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredException);
  });
});

describe('buildPaymobHmacString', () => {
  it('concatenates the ordered fields with no separator, lowercasing booleans', () => {
    const built = buildPaymobHmacString({ amount_cents: 100, success: true, pending: false, id: 7 });
    expect(built).toContain('100');
    expect(built).toContain('true');
    expect(built).toContain('false');
    expect(built).not.toContain('True');
  });

  it('reads dotted paths, and renders a missing field as empty rather than "undefined"', () => {
    const built = buildPaymobHmacString({ order: { id: 55 }, source_data: { pan: '2346' } });
    expect(built).toContain('55');
    expect(built).toContain('2346');
    expect(built).not.toContain('undefined');
    expect(built).not.toContain('null');
  });

  it('the ordered field list is a single exported constant of the documented length', () => {
    // If a reviewer with access to Paymob's live HMAC page corrects this, they
    // correct it HERE and nowhere else.
    expect(PAYMOB_HMAC_FIELDS).toHaveLength(20);
    expect(new Set(PAYMOB_HMAC_FIELDS).size).toBe(PAYMOB_HMAC_FIELDS.length);
  });
});

// ===========================================================================
// FAWRY — Egypt: cash collection. NOT instant, and NOT auto-debitable.
// ===========================================================================

describe('FawryProvider — SHA-256 callback verification', () => {
  const provider = () =>
    new FawryProvider(config({ FAWRY_MERCHANT_CODE: 'merchant-1', FAWRY_SECURITY_KEY: FAWRY_KEY }));

  const callback = (over: Record<string, unknown> = {}) => {
    const body = {
      fawryRefNumber: '9900123456',
      merchantRefNumber: 'abny-order-1',
      paymentAmount: 179.0,
      orderAmount: 179.0,
      orderStatus: 'PAID',
      paymentMethod: 'PAYATFAWRY',
      paymentTime: Date.UTC(2026, 7, 16),
      ...over,
    };
    return {
      ...body,
      messageSignature: crypto.createHash('sha256').update(buildFawrySignatureString(body, FAWRY_KEY)).digest('hex'),
    };
  };

  it('accepts a correctly signed notification', async () => {
    const result = await provider().verifyWebhookSignature({
      rawBody: JSON.stringify(callback()),
      headers: {},
    });
    expect(result.verified).toBe(true);
  });

  it('REJECTS a notification whose amount was changed after signing', async () => {
    const signed = callback();
    const result = await provider().verifyWebhookSignature({
      rawBody: JSON.stringify({ ...signed, paymentAmount: 1.0 }),
      headers: {},
    });
    expect(result.verified).toBe(false);
  });

  it('REJECTS a notification flipped from UNPAID to PAID', async () => {
    const signed = callback({ orderStatus: 'UNPAID' });
    const result = await provider().verifyWebhookSignature({
      rawBody: JSON.stringify({ ...signed, orderStatus: 'PAID' }),
      headers: {},
    });
    expect(result.verified).toBe(false);
  });

  it('FAILS CLOSED without the security key', async () => {
    const result = await new FawryProvider(config({})).verifyWebhookSignature({
      rawBody: JSON.stringify(callback()),
      headers: {},
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('FAWRY_SECURITY_KEY is not configured');
  });

  it('maps the ORDER STATUS vocabulary — and UNPAID is PENDING, never success', async () => {
    // The whole reason `SubscriptionStatus.PENDING` exists: the customer has a
    // reference and may pay at a kiosk in three days, or never.
    const kinds: Record<string, string> = {
      PAID: 'PAYMENT_SUCCEEDED',
      NEW: 'PAYMENT_PENDING',
      UNPAID: 'PAYMENT_PENDING',
      EXPIRED: 'PAYMENT_FAILED',
      CANCELED: 'PAYMENT_FAILED',
      FAILED: 'PAYMENT_FAILED',
      REFUNDED: 'REFUNDED',
    };
    for (const [orderStatus, expected] of Object.entries(kinds)) {
      const event = await provider().parseWebhook({
        rawBody: JSON.stringify(callback({ orderStatus })),
        headers: {},
      });
      expect(event.kind).toBe(expected);
      expect(event.providerAccountRef).toBe('abny-order-1');
    }
  });

  it('formats monetary values to two decimals in the signature string', () => {
    // Fawry expects "179.00" where `String(179)` gives "179". That one
    // difference is the usual cause of a signature mismatch that gets "fixed"
    // by disabling verification.
    const built = buildFawrySignatureString({ paymentAmount: 179, orderAmount: 179 }, FAWRY_KEY);
    expect(built).toContain('179.00');
    expect(built.endsWith(FAWRY_KEY)).toBe(true);
  });

  it('the ordered field list is a single exported constant', () => {
    expect(FAWRY_SIGNATURE_FIELDS).toHaveLength(6);
    expect(new Set(FAWRY_SIGNATURE_FIELDS).size).toBe(FAWRY_SIGNATURE_FIELDS.length);
  });
});

// ===========================================================================
// SAUDI ARABIA — mada + cards. Real auto-renewal, unlike Egypt.
// ===========================================================================

describe('MoyasarProvider — shared-secret callback verification', () => {
  const provider = () =>
    new MoyasarProvider(config({ MOYASAR_SECRET_KEY: 'sk_test', MOYASAR_WEBHOOK_SECRET: MOYASAR_SECRET }));

  const callback = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: 'evt-1',
      type: 'payment_paid',
      created_at: '2026-08-16T12:00:00Z',
      secret_token: MOYASAR_SECRET,
      data: {
        id: 'pay-1',
        status: 'paid',
        amount: 3_400,
        currency: 'SAR',
        metadata: { merchant_reference: 'abny-order-sa-1' },
        ...over,
      },
    });

  it('accepts the configured secret_token', async () => {
    expect((await provider().verifyWebhookSignature({ rawBody: callback(), headers: {} })).verified).toBe(true);
  });

  it('rejects a wrong secret_token, and compares in constant time', async () => {
    const wrong = JSON.parse(callback()) as Record<string, unknown>;
    wrong.secret_token = 'not-the-secret';
    const result = await provider().verifyWebhookSignature({ rawBody: JSON.stringify(wrong), headers: {} });
    expect(result.verified).toBe(false);

    // Both sides are SHA-256'd before `timingSafeEqual`, so a token of a
    // different LENGTH is rejected by comparison rather than by a thrown
    // length mismatch — which would itself be a timing oracle.
    const shortToken = JSON.parse(callback()) as Record<string, unknown>;
    shortToken.secret_token = 'x';
    expect(
      (await provider().verifyWebhookSignature({ rawBody: JSON.stringify(shortToken), headers: {} })).verified,
    ).toBe(false);
  });

  it('rejects a callback with no secret_token at all', async () => {
    const noToken = JSON.parse(callback()) as Record<string, unknown>;
    delete noToken.secret_token;
    expect(
      (await provider().verifyWebhookSignature({ rawBody: JSON.stringify(noToken), headers: {} })).verified,
    ).toBe(false);
  });

  it('FAILS CLOSED without the webhook secret', async () => {
    const result = await new MoyasarProvider(config({})).verifyWebhookSignature({
      rawBody: callback(),
      headers: {},
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('MOYASAR_WEBHOOK_SECRET is not configured');
  });

  it('parses paid / initiated / failed / refunded, carrying OUR merchant reference', async () => {
    const cases: Record<string, string> = {
      paid: 'PAYMENT_SUCCEEDED',
      initiated: 'PAYMENT_PENDING',
      failed: 'PAYMENT_FAILED',
      refunded: 'REFUNDED',
    };
    for (const [status, expected] of Object.entries(cases)) {
      const event = await provider().parseWebhook({ rawBody: callback({ status }), headers: {} });
      expect(event.kind).toBe(expected);
      expect(event.providerAccountRef).toBe('abny-order-sa-1');
      expect(event.verifiedPurchase).toBeNull();
    }
  });

  it('is the SLOT for the Saudi gateway decision, and refuses everything until one is chosen', async () => {
    // Q16 leaves Moyasar vs Tap vs HyperPay to two commercial offers. Swapping
    // is a new class implementing IPaymentProvider plus one registry line.
    const unconfigured = new MoyasarProvider(config({}));
    expect(unconfigured.isConfigured()).toBe(false);
    await expect(
      unconfigured.createCheckout({
        subscriptionId: 's',
        familyId: 'f',
        planTier: 'PREMIUM',
        billingPeriod: 'MONTHLY',
        countryCode: 'SA',
        currency: 'SAR',
        grossAmountMinor: 3_400,
      }),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredException);
  });
});
