import * as crypto from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { StripeWebhookService } from '../../src/modules/billing/application/services/stripe-webhook.service';
import { BILLING_REPOSITORY } from '../../src/modules/billing/application/ports/billing.repository.port';

describe('StripeWebhookService (CLOSES A REAL GAP confirmed genuinely missing in the master audit)', () => {
  const configServiceMock = { get: jest.fn() };
  const repositoryMock = {
    findSubscriptionByProviderSubscriptionId: jest.fn(),
    updateSubscriptionStatus: jest.fn(),
  };

  let service: StripeWebhookService;
  const secret = 'whsec_test_secret_value';

  function signPayload(rawBody: string, timestamp: string, usedSecret = secret): string {
    const signature = crypto.createHmac('sha256', usedSecret).update(`${timestamp}.${rawBody}`).digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        StripeWebhookService,
        { provide: ConfigService, useValue: configServiceMock },
        { provide: BILLING_REPOSITORY, useValue: repositoryMock },
      ],
    }).compile();
    service = moduleRef.get(StripeWebhookService);
  });

  describe('verifySignature — the critical security boundary', () => {
    it('FAILS CLOSED (rejects) when STRIPE_WEBHOOK_SECRET is not configured, even with a syntactically valid-looking signature', () => {
      configServiceMock.get.mockReturnValue(undefined);
      const header = signPayload('{"type":"test"}', '1000');

      expect(service.verifySignature('{"type":"test"}', header)).toBe(false);
    });

    it('rejects a request with no signature header at all', () => {
      configServiceMock.get.mockReturnValue(secret);

      expect(service.verifySignature('{"type":"test"}', undefined)).toBe(false);
    });

    it('accepts a correctly signed payload', () => {
      configServiceMock.get.mockReturnValue(secret);
      const rawBody = '{"type":"invoice.payment_failed"}';
      const header = signPayload(rawBody, '1700000000');

      expect(service.verifySignature(rawBody, header)).toBe(true);
    });

    it('CRITICAL: rejects a payload signed with the WRONG secret (simulating a forged webhook)', () => {
      configServiceMock.get.mockReturnValue(secret);
      const rawBody = '{"type":"invoice.payment_failed"}';
      const forgedHeader = signPayload(rawBody, '1700000000', 'attacker_guessed_secret');

      expect(service.verifySignature(rawBody, forgedHeader)).toBe(false);
    });

    it('CRITICAL: rejects a TAMPERED payload even with a signature that was valid for the ORIGINAL body', () => {
      configServiceMock.get.mockReturnValue(secret);
      const originalBody = '{"type":"invoice.payment_failed","amount":100}';
      const header = signPayload(originalBody, '1700000000');
      const tamperedBody = '{"type":"invoice.payment_failed","amount":999999}';

      expect(service.verifySignature(tamperedBody, header)).toBe(false);
    });

    it('rejects a malformed signature header (missing v1 or t)', () => {
      configServiceMock.get.mockReturnValue(secret);

      expect(service.verifySignature('{}', 't=1700000000')).toBe(false);
      expect(service.verifySignature('{}', 'v1=abc123')).toBe(false);
      expect(service.verifySignature('{}', 'garbage')).toBe(false);
    });
  });

  describe('handleEvent', () => {
    it('marks the subscription PAST_DUE on invoice.payment_failed', async () => {
      repositoryMock.findSubscriptionByProviderSubscriptionId.mockResolvedValue({ id: 'sub-1' });

      await service.handleEvent({ type: 'invoice.payment_failed', data: { object: { subscription: 'stripe_sub_123' } } });

      expect(repositoryMock.findSubscriptionByProviderSubscriptionId).toHaveBeenCalledWith('stripe_sub_123');
      expect(repositoryMock.updateSubscriptionStatus).toHaveBeenCalledWith('sub-1', 'PAST_DUE');
    });

    it('cancels the subscription on customer.subscription.deleted', async () => {
      repositoryMock.findSubscriptionByProviderSubscriptionId.mockResolvedValue({ id: 'sub-2' });

      await service.handleEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'stripe_sub_456' } } });

      expect(repositoryMock.updateSubscriptionStatus).toHaveBeenCalledWith('sub-2', 'CANCELED', { canceledAt: expect.any(Date) });
    });

    it('BOUNDARY CASE: silently no-ops (does not throw) for an unknown providerSubscriptionId', async () => {
      repositoryMock.findSubscriptionByProviderSubscriptionId.mockResolvedValue(null);

      await expect(
        service.handleEvent({ type: 'invoice.payment_failed', data: { object: { subscription: 'unknown_id' } } }),
      ).resolves.toBeUndefined();

      expect(repositoryMock.updateSubscriptionStatus).not.toHaveBeenCalled();
    });

    it('BOUNDARY CASE: unrecognized event types are safely acknowledged (no throw, no action)', async () => {
      await expect(
        service.handleEvent({ type: 'customer.updated', data: { object: {} } }),
      ).resolves.toBeUndefined();

      expect(repositoryMock.updateSubscriptionStatus).not.toHaveBeenCalled();
    });
  });
});
