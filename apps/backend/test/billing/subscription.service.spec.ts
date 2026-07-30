import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SubscriptionService } from '../../src/modules/billing/application/services/subscription.service';
import { BILLING_REPOSITORY } from '../../src/modules/billing/application/ports/billing.repository.port';
import { TrialManager } from '../../src/modules/billing/application/services/trial-manager.service';
import { PaymentService } from '../../src/modules/billing/application/services/payment.service';
import { InvoiceService } from '../../src/modules/billing/application/services/invoice.service';
import { AuditService } from '../../src/modules/audit/application/audit.service';

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
      repositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-1' });
      await service.cancel('family-1');
      expect(repositoryMock.updateSubscriptionStatus).toHaveBeenCalledWith(
        'sub-1', 'CANCELED', expect.objectContaining({ canceledAt: expect.any(Date) }),
      );
    });
  });

  describe('getBillingHistory', () => {
    it('returns an empty array for a family with no subscription (not an error)', async () => {
      repositoryMock.findSubscriptionByFamily.mockResolvedValue(null);
      await expect(service.getBillingHistory('family-1')).resolves.toEqual([]);
    });
  });
});
