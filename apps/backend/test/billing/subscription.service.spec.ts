import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SubscriptionService } from '../../src/modules/billing/application/services/subscription.service';
import { BILLING_REPOSITORY } from '../../src/modules/billing/application/ports/billing.repository.port';
import { TrialManager } from '../../src/modules/billing/application/services/trial-manager.service';
import { PaymentService } from '../../src/modules/billing/application/services/payment.service';
import { InvoiceService } from '../../src/modules/billing/application/services/invoice.service';
import { AuditService } from '../../src/modules/audit/application/audit.service';
import { GrowthEventEmitter } from '../../src/modules/analytics/application/growth-event-emitter.service';
import type { PersistedSubscriptionStatus } from '../../src/modules/billing/domain/subscription-status';

describe('SubscriptionService', () => {
  const repositoryMock = {
    findSubscriptionByFamily: jest.fn(),
    createSubscription: jest.fn(),
    updateSubscriptionStatus: jest.fn(),
    findPlanByTier: jest.fn(),
  };
  const trialManagerMock = { computeTrialEndDate: jest.fn(() => new Date('2026-08-01')) };
  const paymentServiceMock = { charge: jest.fn() };
  const invoiceServiceMock = {
    createDraftInvoice: jest.fn(),
    markPaid: jest.fn(),
    listForSubscription: jest.fn(),
  };
  const auditServiceMock = { record: jest.fn() };

  let service: SubscriptionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: BILLING_REPOSITORY, useValue: repositoryMock },
        { provide: TrialManager, useValue: trialManagerMock },
        { provide: PaymentService, useValue: paymentServiceMock },
        { provide: InvoiceService, useValue: invoiceServiceMock },
        { provide: AuditService, useValue: auditServiceMock },
        // PHASE D (GROWTH). `emit` never throws by contract (see the emitter's
        // class docstring), so a double that resolves is a faithful stand-in —
        // and these suites are about the business path, not about telemetry.
        { provide: GrowthEventEmitter, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = moduleRef.get(SubscriptionService);
  });

  describe('startTrial', () => {
    it('creates a TRIALING PREMIUM subscription for a family with none', async () => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);
      repositoryMock.createSubscription.mockResolvedValue({ id: 'sub-1' });

      await service.startTrial('family-1');

      expect(repositoryMock.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ familyId: 'family-1', planTier: 'PREMIUM', status: 'TRIALING' }),
      );
    });

    it('rejects a second trial for the same family', async () => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'existing-sub' });

      await expect(service.startTrial('family-1')).rejects.toBeInstanceOf(ConflictException);
      expect(repositoryMock.createSubscription).not.toHaveBeenCalled();
    });
  });

  describe('subscribe', () => {
    it('throws NotFoundException for an unknown plan tier', async () => {
      repositoryMock.findPlanByTier.mockResolvedValue(null);
      await expect(service.subscribe('family-1', 'PREMIUM', 'MANUAL')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('marks the subscription ACTIVE and the invoice PAID on a successful charge', async () => {
      repositoryMock.findPlanByTier.mockResolvedValue({ priceCents: 999, currency: 'USD', billingIntervalMonths: 1 });
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-1' });
      invoiceServiceMock.createDraftInvoice.mockResolvedValue({ id: 'invoice-1' });
      paymentServiceMock.charge.mockResolvedValue({ success: true, providerChargeId: 'charge-1', failureReason: null });

      await service.subscribe('family-1', 'PREMIUM', 'MANUAL');

      expect(invoiceServiceMock.markPaid).toHaveBeenCalledWith('invoice-1');
      expect(repositoryMock.updateSubscriptionStatus).toHaveBeenCalledWith(
        'sub-1', 'ACTIVE', expect.objectContaining({ currentPeriodStart: expect.any(Date), currentPeriodEnd: expect.any(Date) }),
      );
    });

    it('marks the subscription PAST_DUE (not ACTIVE, invoice stays unpaid) when the charge fails', async () => {
      repositoryMock.findPlanByTier.mockResolvedValue({ priceCents: 999, currency: 'USD', billingIntervalMonths: 1 });
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-1' });
      invoiceServiceMock.createDraftInvoice.mockResolvedValue({ id: 'invoice-1' });
      paymentServiceMock.charge.mockResolvedValue({ success: false, providerChargeId: null, failureReason: 'card declined' });

      await service.subscribe('family-1', 'PREMIUM', 'MANUAL');

      expect(invoiceServiceMock.markPaid).not.toHaveBeenCalled();
      expect(repositoryMock.updateSubscriptionStatus).toHaveBeenCalledWith('sub-1', 'PAST_DUE');
    });

    it('creates a new subscription (ACTIVE) if the family had none yet', async () => {
      repositoryMock.findPlanByTier.mockResolvedValue({ priceCents: 999, currency: 'USD', billingIntervalMonths: 1 });
      repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);
      repositoryMock.createSubscription.mockResolvedValue({ id: 'new-sub' });
      invoiceServiceMock.createDraftInvoice.mockResolvedValue({ id: 'invoice-1' });
      paymentServiceMock.charge.mockResolvedValue({ success: true, providerChargeId: 'c1', failureReason: null });

      await service.subscribe('family-1', 'PREMIUM', 'STRIPE');

      expect(repositoryMock.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ familyId: 'family-1', planTier: 'PREMIUM', provider: 'STRIPE', status: 'ACTIVE' }),
      );
    });
  });

  describe('cancel', () => {
    it('throws NotFoundException when the family has no subscription', async () => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);
      await expect(service.cancel('family-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sets status to CANCELED with a canceledAt timestamp', async () => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-1', status: 'ACTIVE' });
      await service.cancel('family-1');
      expect(repositoryMock.updateSubscriptionStatus).toHaveBeenCalledWith(
        'sub-1', 'CANCELED', expect.objectContaining({ canceledAt: expect.any(Date) }),
      );
    });

    /**
     * SPRINT F1 (DECISION 3) — THE WHOLE STATUS MATRIX, ONE CASE PER STATE.
     *
     * The affordance used to be gated on `status === 'ACTIVE'` in the client,
     * which left a `GRACE_PERIOD` household — entitled, treated as paying, and
     * in that state BECAUSE its card had just failed — with no way out. The
     * decision now lives on the server in `CANCELLABLE_STATUSES`, and this is
     * that decision ENFORCED. The cases are written in the PERSISTED spellings
     * the database actually holds, so a mistake in the two-vocabulary mapping
     * fails here as well as in `money-and-status.spec.ts`.
     */
    const MAY_CANCEL: Array<[PersistedSubscriptionStatus, string]> = [
      ['TRIALING', 'a trial ends by BECOMING a charge; stopping that is the commonest cancellation there is'],
      ['ACTIVE', 'the ordinary case'],
      ['PAST_DUE', 'the provider is retrying a failed card and the customer may refuse the retry'],
      ['GRACE_PERIOD', 'THE DEFECT: entitled, treated as paying, and previously trapped'],
    ];
    const MAY_NOT_CANCEL: Array<[PersistedSubscriptionStatus, string]> = [
      ['PENDING', 'an unsettled kiosk reference: nothing charged, nothing entitled, nothing renewing'],
      ['CANCELED', 'renewal has already ended'],
      ['EXPIRED', 'the period is over and nothing renews'],
      ['REFUNDED', 'terminal: the money went back'],
    ];

    it.each(MAY_CANCEL)('CAN cancel from %s — %s', async (status) => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({
        id: 'sub-1',
        status,
        currentPeriodEnd: new Date('2026-02-01T00:00:00.000Z'),
      });

      const result = await service.cancel('family-1', 'user-1');

      expect(repositoryMock.updateSubscriptionStatus).toHaveBeenCalledWith(
        'sub-1', 'CANCELED', expect.objectContaining({ canceledAt: expect.any(Date) }),
      );
      // THE SHAPE THE CLIENT NOW GETS: what changed, and what the household
      // KEEPS. `accessUntil` is `currentPeriodEnd` untouched.
      expect(result.status).toBe('CANCELLED');
      expect(result.accessUntil).toEqual(new Date('2026-02-01T00:00:00.000Z'));
      // AND THE PERIOD END WAS NOT MOVED. The only `extra` this call may carry
      // is `canceledAt`; a `currentPeriodEnd` here would be an early revocation
      // wearing a cancellation's clothes.
      const extra = repositoryMock.updateSubscriptionStatus.mock.calls[0][2];
      expect(Object.keys(extra)).toEqual(['canceledAt']);
    });

    it.each(MAY_NOT_CANCEL)('CANNOT cancel from %s — %s', async (status) => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-1', status });

      await expect(service.cancel('family-1', 'user-1')).rejects.toBeInstanceOf(ConflictException);
      // AND NOTHING MOVED. A refused cancellation must not write a status, must
      // not audit, and must not emit a growth marker that would report a
      // cancellation that never happened.
      expect(repositoryMock.updateSubscriptionStatus).not.toHaveBeenCalled();
      expect(auditServiceMock.record).not.toHaveBeenCalled();
    });

    it('an already-cancelled household gets its OWN code, so a client can say «already cancelled»', async () => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-1', status: 'CANCELED' });

      const error = await service.cancel('family-1').catch((err) => err);
      expect(error).toBeInstanceOf(ConflictException);
      const body = error.getResponse() as { code: string; messageAr: string; status: string };
      expect(body.code).toBe('SUBSCRIPTION_ALREADY_CANCELLED');
      expect(body.status).toBe('CANCELLED');
      // NO RAW ENUM OR STATUS CODE IN A USER-VISIBLE STRING. The machine value
      // travels in its own field; the sentence is Arabic and says what happened.
      expect(body.messageAr).toMatch(/[؀-ۿ]/);
      expect(body.messageAr).not.toMatch(/[A-Z_]{4,}/);
    });

    it('a state with no renewal to end gets the other code, and an Arabic sentence too', async () => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-1', status: 'EXPIRED' });

      const error = await service.cancel('family-1').catch((err) => err);
      const body = error.getResponse() as { code: string; messageAr: string; status: string };
      expect(body.code).toBe('SUBSCRIPTION_NOT_CANCELLABLE');
      expect(body.status).toBe('EXPIRED');
      expect(body.messageAr).toMatch(/[؀-ۿ]/);
      expect(body.messageAr).not.toMatch(/[A-Z_]{4,}/);
    });
  });

  /**
   * SPRINT F1 (DECISION 3) — THE SERVER ANSWERS THE QUESTION IT ENFORCES.
   *
   * A client that computes «may I cancel?» for itself is how the trap was built
   * the first time, so the two are asserted AGAINST EACH OTHER rather than each
   * against its own list: whatever `cancel()` really accepts is what
   * `GET /billing/subscription` really reports.
   */
  describe('describeCancellability', () => {
    it.each(['TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'PENDING', 'CANCELED', 'EXPIRED', 'REFUNDED'])(
      'agrees with what cancel() actually does, for %s',
      async (status) => {
        repositoryMock.findSubscriptionByFamily.mockResolvedValue({
          id: 'sub-1',
          status,
          currentPeriodEnd: new Date('2026-02-01T00:00:00.000Z'),
        });

        const described = await service.describeCancellability('family-1');
        const accepted = await service
          .cancel('family-1', 'user-1')
          .then(() => true)
          .catch(() => false);

        expect(`${status}:${described.canCancel}`).toBe(`${status}:${accepted}`);
        // The CANONICAL vocabulary leaves the building, never the database's.
        expect(['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'PENDING', 'CANCELLED', 'EXPIRED', 'REFUNDED'])
          .toContain(described.status as string);
        expect(described.accessUntil).toEqual(new Date('2026-02-01T00:00:00.000Z'));
      },
    );

    it('a family with no subscription cannot cancel, and asking is not an error', async () => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);
      await expect(service.describeCancellability('family-1')).resolves.toEqual({
        canCancel: false,
        status: null,
        accessUntil: null,
      });
    });
  });

  describe('getBillingHistory', () => {
    it('returns an empty array for a family with no subscription (not an error)', async () => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);
      await expect(service.getBillingHistory('family-1')).resolves.toEqual([]);
    });
  });
});
