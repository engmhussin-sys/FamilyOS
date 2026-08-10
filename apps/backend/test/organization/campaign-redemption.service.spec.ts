import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CampaignRedemptionService } from '../../src/modules/organization/application/services/campaign-redemption.service';
import { ORGANIZATION_REPOSITORY } from '../../src/modules/organization/application/ports/organization.repository.port';
import { TrialManager } from '../../src/modules/billing/application/services/trial-manager.service';
import { BILLING_REPOSITORY } from '../../src/modules/billing/application/ports/billing.repository.port';

describe('CampaignRedemptionService (Sprint B4 + follow-up: DISCOUNT support)', () => {
  const repositoryMock = { findActiveCampaignByCode: jest.fn() };
  const trialManagerMock = { extendTrial: jest.fn() };
  // FIXES A REAL BUG found in a follow-up review: this mock was
  // missing entirely after BILLING_REPOSITORY was added as a real
  // constructor dependency (needed for the new DISCOUNT feature) —
  // every test in this file failed with a NestJS "can't resolve
  // dependencies" error until this was added.
  const billingRepositoryMock = { findSubscriptionByFamily: jest.fn(), setPendingDiscount: jest.fn() };

  let service: CampaignRedemptionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CampaignRedemptionService,
        { provide: ORGANIZATION_REPOSITORY, useValue: repositoryMock },
        { provide: TrialManager, useValue: trialManagerMock },
        { provide: BILLING_REPOSITORY, useValue: billingRepositoryMock },
      ],
    }).compile();
    service = moduleRef.get(CampaignRedemptionService);
  });

  it("throws NotFoundException for an invalid/expired/inactive code — matches findActiveCampaignByCode's own null-on-any-of-those-cases contract", async () => {
    repositoryMock.findActiveCampaignByCode.mockResolvedValue(null);

    await expect(service.redeem('BADCODE', 'family-1')).rejects.toBeInstanceOf(NotFoundException);

    expect(trialManagerMock.extendTrial).not.toHaveBeenCalled();
  });

  it('extends the trial for a TRIAL_EXTENSION campaign with a valid config', async () => {
    repositoryMock.findActiveCampaignByCode.mockResolvedValue({
      id: 'c1', organizationId: 'org-1', code: 'WELCOME30', type: 'TRIAL_EXTENSION',
      config: { extraDays: 30 }, isActive: true, expiresAt: null,
    });
    trialManagerMock.extendTrial.mockResolvedValue(new Date('2026-09-01'));

    const result = await service.redeem('WELCOME30', 'family-1');

    expect(trialManagerMock.extendTrial).toHaveBeenCalledWith('family-1', 30);
    expect(result.campaignType).toBe('TRIAL_EXTENSION');
    expect(result.message).toContain('30 day');
  });

  it('treats REFERRAL/COUPON/QR_CODE the same as TRIAL_EXTENSION when config has extraDays — type says WHAT KIND, config drives behavior', async () => {
    repositoryMock.findActiveCampaignByCode.mockResolvedValue({
      id: 'c2', organizationId: 'org-1', code: 'FRIEND10', type: 'REFERRAL',
      config: { extraDays: 10 }, isActive: true, expiresAt: null,
    });
    trialManagerMock.extendTrial.mockResolvedValue(new Date('2026-09-01'));

    const result = await service.redeem('FRIEND10', 'family-1');

    expect(trialManagerMock.extendTrial).toHaveBeenCalledWith('family-1', 10);
    expect(result.campaignType).toBe('REFERRAL');
  });

  it('throws BadRequestException for a misconfigured campaign (missing/invalid extraDays AND missing discountPercent), and touches TrialManager NOT AT ALL', async () => {
    repositoryMock.findActiveCampaignByCode.mockResolvedValue({
      id: 'c3', organizationId: 'org-1', code: 'BROKEN', type: 'COUPON',
      config: { extraDays: -5 }, isActive: true, expiresAt: null,
    });

    await expect(service.redeem('BROKEN', 'family-1')).rejects.toBeInstanceOf(BadRequestException);

    expect(trialManagerMock.extendTrial).not.toHaveBeenCalled();
  });

  describe('DISCOUNT campaigns (CLOSES A REAL GAP previously explicitly flagged as unimplemented)', () => {
    it('applies a one-time pending discount to the family subscription', async () => {
      repositoryMock.findActiveCampaignByCode.mockResolvedValue({
        id: 'c4', organizationId: 'org-1', code: 'SAVE20', type: 'DISCOUNT',
        config: { discountPercent: 20 }, isActive: true, expiresAt: null,
      });
      billingRepositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-1', familyId: 'family-1' });

      const result = await service.redeem('SAVE20', 'family-1');

      expect(billingRepositoryMock.setPendingDiscount).toHaveBeenCalledWith('sub-1', 20);
      expect(result.campaignType).toBe('DISCOUNT');
      expect(result.message).toContain('20%');
    });

    it('throws NotFoundException when the family has no subscription to discount', async () => {
      repositoryMock.findActiveCampaignByCode.mockResolvedValue({
        id: 'c5', organizationId: 'org-1', code: 'SAVE20', type: 'DISCOUNT',
        config: { discountPercent: 20 }, isActive: true, expiresAt: null,
      });
      billingRepositoryMock.findSubscriptionByFamily.mockResolvedValue(null);

      await expect(service.redeem('SAVE20', 'family-1')).rejects.toBeInstanceOf(NotFoundException);

      expect(billingRepositoryMock.setPendingDiscount).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for an invalid discountPercent (e.g. over 100 or zero)', async () => {
      repositoryMock.findActiveCampaignByCode.mockResolvedValue({
        id: 'c6', organizationId: 'org-1', code: 'BADDISCOUNT', type: 'DISCOUNT',
        config: { discountPercent: 150 }, isActive: true, expiresAt: null,
      });

      await expect(service.redeem('BADDISCOUNT', 'family-1')).rejects.toBeInstanceOf(BadRequestException);

      expect(billingRepositoryMock.setPendingDiscount).not.toHaveBeenCalled();
    });

    it('a REFERRAL/COUPON/QR_CODE campaign configured with discountPercent (instead of extraDays) applies a discount, not a trial extension', async () => {
      repositoryMock.findActiveCampaignByCode.mockResolvedValue({
        id: 'c7', organizationId: 'org-1', code: 'REFDISCOUNT', type: 'REFERRAL',
        config: { discountPercent: 15 }, isActive: true, expiresAt: null,
      });
      billingRepositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-2', familyId: 'family-1' });

      const result = await service.redeem('REFDISCOUNT', 'family-1');

      expect(trialManagerMock.extendTrial).not.toHaveBeenCalled();
      expect(billingRepositoryMock.setPendingDiscount).toHaveBeenCalledWith('sub-2', 15);
      expect(result.campaignType).toBe('REFERRAL');
    });
  });
});
