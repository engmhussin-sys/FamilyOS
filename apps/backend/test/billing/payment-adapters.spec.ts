import { ConfigService } from '@nestjs/config';
import { ManualPaymentAdapter } from '../../src/modules/billing/infrastructure/adapters/manual-payment.adapter';
import { StripeAdapter } from '../../src/modules/billing/infrastructure/adapters/stripe.adapter';
import { PaymobAdapter } from '../../src/modules/billing/infrastructure/adapters/paymob.adapter';
import { FawryAdapter } from '../../src/modules/billing/infrastructure/adapters/fawry.adapter';
import { PaymentProviderNotConfiguredException } from '../../src/modules/billing/domain/billing.errors';

describe('ManualPaymentAdapter', () => {
  it('always succeeds \u2014 no external config required', async () => {
    const adapter = new ManualPaymentAdapter();
    const result = await adapter.charge({ subscriptionId: 'sub-1', amountCents: 999, currency: 'USD' });
    expect(result.success).toBe(true);
    expect(result.providerChargeId).toContain('manual-sub-1');
  });
});

describe('Unconfigured provider adapters (Stripe/Paymob/Fawry)', () => {
  it('StripeAdapter throws PaymentProviderNotConfiguredException with no API key set', async () => {
    const configService = { get: jest.fn(() => undefined) } as unknown as ConfigService;
    const adapter = new StripeAdapter(configService);
    await expect(
      adapter.charge({ subscriptionId: 'sub-1', amountCents: 999, currency: 'USD' }),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredException);
  });

  it('PaymobAdapter throws PaymentProviderNotConfiguredException with no API key set', async () => {
    const configService = { get: jest.fn(() => undefined) } as unknown as ConfigService;
    const adapter = new PaymobAdapter(configService);
    await expect(
      adapter.charge({ subscriptionId: 'sub-1', amountCents: 999, currency: 'USD' }),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredException);
  });

  it('FawryAdapter throws PaymentProviderNotConfiguredException with no API key set', async () => {
    const configService = { get: jest.fn(() => undefined) } as unknown as ConfigService;
    const adapter = new FawryAdapter(configService);
    await expect(
      adapter.charge({ subscriptionId: 'sub-1', amountCents: 999, currency: 'USD' }),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredException);
  });
});
