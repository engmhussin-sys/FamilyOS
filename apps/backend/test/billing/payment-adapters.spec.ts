import { ConfigService } from '@nestjs/config';

import { ManualPaymentAdapter } from '../../src/modules/billing/infrastructure/adapters/manual-payment.adapter';
import { StripeAdapter } from '../../src/modules/billing/infrastructure/adapters/stripe.adapter';
import { PaymobProvider } from '../../src/modules/billing/infrastructure/adapters/paymob.provider';
import { FawryProvider } from '../../src/modules/billing/infrastructure/adapters/fawry.provider';
import { MoyasarProvider } from '../../src/modules/billing/infrastructure/adapters/moyasar.provider';
import { AppleStoreKitProvider } from '../../src/modules/billing/infrastructure/adapters/apple-storekit.provider';
import { GooglePlayProvider } from '../../src/modules/billing/infrastructure/adapters/google-play.provider';
import { PaymentProviderNotConfiguredException } from '../../src/modules/billing/domain/billing.errors';
import type { IPaymentProvider } from '../../src/modules/billing/application/ports/payment-provider.port';

/**
 * PHASE D — THE SPRINT 8 SUITE, KEPT, with its four rebuilt adapters pointed
 * at their new classes.
 *
 * The original assertion is the one that mattered and it is unchanged: an
 * adapter with no credentials FAILS LOUDLY with a typed exception and never
 * silently succeeds. Phase D adds the half Sprint 8 could not express, because
 * the interface had no webhook members: an unconfigured adapter must also
 * REFUSE TO VERIFY A SIGNATURE rather than wave one through. An adapter that
 * returns `{verified: true}` when its secret is missing is a backdoor, and it
 * is exactly the shortcut that gets written at 2am during an integration.
 */

const noConfig = () => ({ get: jest.fn(() => undefined) }) as unknown as ConfigService;

describe('ManualPaymentAdapter', () => {
  it('always succeeds — no external config required', async () => {
    const adapter = new ManualPaymentAdapter();
    const result = await adapter.charge({ subscriptionId: 'sub-1', amountCents: 999, currency: 'USD' });
    expect(result.success).toBe(true);
    expect(result.providerChargeId).toContain('manual-sub-1');
  });

  it('is configured (nothing external to configure) but advertises no Phase D capability', () => {
    const adapter = new ManualPaymentAdapter();
    expect(adapter.isConfigured()).toBe(true);
    expect(adapter.supports('CHECKOUT')).toBe(false);
    expect(adapter.supports('VERIFY')).toBe(false);
  });
});

describe('Unconfigured provider adapters fail loudly on charge()', () => {
  it.each([
    ['StripeAdapter', () => new StripeAdapter(noConfig())],
    ['PaymobProvider', () => new PaymobProvider(noConfig())],
    ['FawryProvider', () => new FawryProvider(noConfig())],
    ['MoyasarProvider', () => new MoyasarProvider(noConfig())],
    ['AppleStoreKitProvider', () => new AppleStoreKitProvider(noConfig())],
    ['GooglePlayProvider', () => new GooglePlayProvider(noConfig())],
  ])('%s throws PaymentProviderNotConfiguredException', async (_name, build) => {
    const adapter = build();
    await expect(
      adapter.charge({ subscriptionId: 'sub-1', amountCents: 999, currency: 'USD' }),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredException);
  });
});

describe('PHASE D — an unconfigured adapter refuses signatures rather than skipping them', () => {
  it.each([
    ['PaymobProvider', () => new PaymobProvider(noConfig())],
    ['FawryProvider', () => new FawryProvider(noConfig())],
    ['MoyasarProvider', () => new MoyasarProvider(noConfig())],
    ['AppleStoreKitProvider', () => new AppleStoreKitProvider(noConfig())],
    ['GooglePlayProvider', () => new GooglePlayProvider(noConfig())],
  ])('%s returns verified:false with a stated reason', async (_name, build) => {
    const adapter = build();
    const result = await adapter.verifyWebhookSignature({
      rawBody: '{"anything":"at all"}',
      headers: { authorization: 'Bearer whatever' },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toEqual(expect.stringContaining('not configured'));
  });

  it.each([
    ['PaymobProvider', () => new PaymobProvider(noConfig())],
    ['FawryProvider', () => new FawryProvider(noConfig())],
    ['MoyasarProvider', () => new MoyasarProvider(noConfig())],
    ['GooglePlayProvider', () => new GooglePlayProvider(noConfig())],
    ['AppleStoreKitProvider', () => new AppleStoreKitProvider(noConfig())],
  ])('%s reports isConfigured() === false', (_name, build) => {
    expect(build().isConfigured()).toBe(false);
  });
});

describe('PHASE D — store providers deliberately do NOT advertise checkout or refund', () => {
  it('Apple and Google own their own purchase and refund flows', () => {
    const stores: IPaymentProvider[] = [new AppleStoreKitProvider(noConfig()), new GooglePlayProvider(noConfig())];
    for (const store of stores) {
      expect(store.kind).toBe('STORE');
      expect(store.supports('VERIFY')).toBe(true);
      expect(store.supports('WEBHOOK')).toBe(true);
      // A server that offered "refund this Apple purchase" would be lying:
      // only Apple can refund an Apple purchase. Q17 states the business rule
      // («a refund is not applied to a Play purchase except through Play») and
      // this is the code that makes the opposite unstatable.
      expect(store.supports('REFUND')).toBe(false);
      expect(store.supports('CHECKOUT')).toBe(false);
      expect(store.createCheckout).toBeUndefined();
      expect(store.refund).toBeUndefined();
    }
  });

  it('gateways advertise checkout and refund', () => {
    for (const gateway of [
      new PaymobProvider(noConfig()),
      new FawryProvider(noConfig()),
      new MoyasarProvider(noConfig()),
    ]) {
      expect(gateway.kind).toBe('GATEWAY');
      expect(gateway.supports('CHECKOUT')).toBe(true);
      expect(gateway.supports('REFUND')).toBe(true);
    }
  });
});
