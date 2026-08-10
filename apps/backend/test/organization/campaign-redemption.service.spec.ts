import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CampaignRedemptionService } from '../../src/modules/organization/application/services/campaign-redemption.service';
import { ORGANIZATION_REPOSITORY } from '../../src/modules/organization/application/ports/organization.repository.port';
import { TrialManager } from '../../src/modules/billing/application/services/trial-manager.service';

describe('CampaignRedemptionService (Sprint B4)', () => {
  const repositoryMock = { findActiveCampaignByCode: jest.fn() };
  const trialManagerMock = { extendTrial: jest.fn() };

  let service: CampaignRedemptionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        CampaignRedemptionService,
        { provide: ORGANIZATION_REPOSITORY, useValue: repositoryMock },
        { provide: TrialManager, useValue: trialManagerMock },
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

  it('throws BadRequestException for a misconfigured campaign (missing/invalid extraDays), and touches TrialManager NOT AT ALL', async () => {
    repositoryMock.findActiveCampaignByCode.mockResolvedValue({
      id: 'c3', organizationId: 'org-1', code: 'BROKEN', type: 'COUPON',
      config: { extraDays: -5 }, isActive: true, expiresAt: null,
    });

    await expect(service.redeem('BROKEN', 'family-1')).rejects.toBeInstanceOf(BadRequestException);

    expect(trialManagerMock.extendTrial).not.toHaveBeenCalled();
  });

  it('DISCOUNT campaigns fail loudly with an honest "not yet supported" error, never silently redeeming for nothing', async () => {
    repositoryMock.findActiveCampaignByCode.mockResolvedValue({
      id: 'c4', organizationId: 'org-1', code: 'SAVE20', type: 'DISCOUNT',
      config: { percent: 20 }, isActive: true, expiresAt: null,
    });

    await expect(service.redeem('SAVE20', 'family-1')).rejects.toThrow('not yet supported');
  });
});
