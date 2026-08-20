import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { CampaignRedemptionService } from '../../src/modules/organization/application/services/campaign-redemption.service';
import { ORGANIZATION_REPOSITORY } from '../../src/modules/organization/application/ports/organization.repository.port';
import { TrialManager } from '../../src/modules/billing/application/services/trial-manager.service';
import { BILLING_REPOSITORY } from '../../src/modules/billing/application/ports/billing.repository.port';
import { FamilyDateService } from '../../src/common/time/family-date.service';
import { getBusinessDate } from '../../src/common/time/family-date';

describe('CampaignRedemptionService (Sprint B4 + follow-up: DISCOUNT support)', () => {
  const repositoryMock = { findActiveCampaignByCode: jest.fn() };
  const trialManagerMock = { extendTrial: jest.fn() };
  /**
   * F1 — the family's calendar, not UTC.
   *
   * The stub delegates to the REAL `getBusinessDate` from `family-date.ts`, so
   * these tests exercise the actual tzdata resolution and only the
   * `Family.timezone` lookup is faked. `familyTimeZone` is what each test sets
   * to say which family it is talking about.
   */
  let familyTimeZone = 'UTC';
  const familyDateMock = {
    getBusinessDate: jest.fn(async (_familyId: string, instant: Date = new Date()) =>
      getBusinessDate(instant, familyTimeZone),
    ),
  };
  // FIXES A REAL BUG found in a follow-up review: this mock was
  // missing entirely after BILLING_REPOSITORY was added as a real
  // constructor dependency (needed for the new DISCOUNT feature) —
  // every test in this file failed with a NestJS "can't resolve
  // dependencies" error until this was added.
  const billingRepositoryMock = { findSubscriptionByFamily: jest.fn(), setPendingDiscount: jest.fn() };

  let service: CampaignRedemptionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    familyTimeZone = 'UTC';
    const moduleRef = await Test.createTestingModule({
      providers: [
        CampaignRedemptionService,
        { provide: ORGANIZATION_REPOSITORY, useValue: repositoryMock },
        { provide: TrialManager, useValue: trialManagerMock },
        { provide: BILLING_REPOSITORY, useValue: billingRepositoryMock },
        { provide: FamilyDateService, useValue: familyDateMock },
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
    // F1: this used to assert `toContain('30 day')` — i.e. it PINNED the
    // English. The sentence a parent reads is the whole deliverable of this
    // method, so it is asserted whole rather than by fragment.
    expect(result.message).toBe('تم تمديد فترتك التجريبية ٣٠ يومًا، وتستمر حتى ١ سبتمبر ٢٠٢٦.');
    expect(result.messageAr).toBe(result.message);
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
      // F1: was `toContain('20%')`. Arabic-Indic digits and the Arabic percent
      // sign `٪` (U+066A), not `20%`.
      expect(result.message).toBe(
        'تم تفعيل خصم ٢٠٪ على اشتراكك، وسيُطبَّق تلقائيًا عند اشتراكك أو تجديدك القادم.',
      );
      expect(result.messageAr).toBe(result.message);
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

  /**
   * =======================================================================
   * F1 — THE SUCCESS SENTENCE IS ARABIC, AND ITS DATE IS THE FAMILY'S.
   * =======================================================================
   *
   * `redeem_code_screen.dart` renders `message` verbatim and deliberately
   * prefers it over its own localised fallback, so anything English here is
   * English on an RTL success box with no client-side remedy. These are the
   * two properties that were broken, asserted directly.
   */
  describe('F1 — Arabic copy and the family calendar', () => {
    const trialCampaign = (extraDays: number) => ({
      id: 'f1', organizationId: 'org-1', code: 'ARABIC', type: 'TRIAL_EXTENSION' as const,
      config: { extraDays }, isActive: true, expiresAt: null,
    });

    /**
     * THE FAILURE CASE, STATED AS A PROPERTY RATHER THAN AS A STRING.
     * `Your trial has been extended by 30 day(s), now ending 2026-09-01.` and
     * `A 20% discount has been applied…` both fail this; so would any future
     * regression that reintroduced a Latin word, a Latin digit or `%`. The one
     * exception carved out is nothing — a campaign success sentence has no
     * legitimate Latin content.
     */
    const LATIN = /[A-Za-z0-9%]/;

    it('the TRIAL_EXTENSION sentence carries no Latin letter, no Latin digit and no `%`', async () => {
      repositoryMock.findActiveCampaignByCode.mockResolvedValue(trialCampaign(30));
      trialManagerMock.extendTrial.mockResolvedValue(new Date('2026-09-01T09:00:00.000Z'));

      const result = await service.redeem('ARABIC', 'family-1');

      expect(result.message).not.toMatch(LATIN);
      expect(result.message).not.toMatch(/day\(s\)/);
    });

    it('the DISCOUNT sentence carries no Latin letter, no Latin digit and no `%`', async () => {
      repositoryMock.findActiveCampaignByCode.mockResolvedValue({
        id: 'f2', organizationId: 'org-1', code: 'ARABICOFF', type: 'DISCOUNT' as const,
        config: { discountPercent: 25 }, isActive: true, expiresAt: null,
      });
      billingRepositoryMock.findSubscriptionByFamily.mockResolvedValue({ id: 'sub-9', familyId: 'family-1' });

      const result = await service.redeem('ARABICOFF', 'family-1');

      expect(result.message).not.toMatch(LATIN);
      expect(result.message).toBe(
        'تم تفعيل خصم ٢٥٪ على اشتراكك، وسيُطبَّق تلقائيًا عند اشتراكك أو تجديدك القادم.',
      );
    });

    /**
     * THE DATE, AND THE PREMISE ASSERTED BEFORE THE CONCLUSION.
     *
     * A JANUARY instant, deliberately: Africa/Cairo is GMT+02:00 in January
     * (Egypt reintroduced DST in 2023, so August would be GMT+03:00 — a
     * different, larger offset, and the point is that the test does not depend
     * on which). 22:30 UTC on the 1st is 00:30 local on the 2nd, so the
     * family's calendar and UTC's disagree — which the first assertion PROVES
     * rather than assumes, because a test whose premise silently stops holding
     * is a test that passes for the wrong reason.
     */
    it('announces the trial end on the FAMILY\'s calendar day, not UTC\'s', async () => {
      familyTimeZone = 'Africa/Cairo';
      const trialEndsAt = new Date('2026-01-01T22:30:00.000Z');

      // PREMISE: UTC says the 1st, Cairo says the 2nd.
      expect(trialEndsAt.toISOString().split('T')[0]).toBe('2026-01-01');
      expect(getBusinessDate(trialEndsAt, 'Africa/Cairo')).toBe('2026-01-02');

      repositoryMock.findActiveCampaignByCode.mockResolvedValue(trialCampaign(14));
      trialManagerMock.extendTrial.mockResolvedValue(trialEndsAt);

      const result = await service.redeem('ARABIC', 'family-cairo');

      // «٢ يناير ٢٠٢٦» — the family's day. «١ يناير ٢٠٢٦» would be the defect.
      expect(result.message).toBe('تم تمديد فترتك التجريبية ١٤ يومًا، وتستمر حتى ٢ يناير ٢٠٢٦.');
      expect(result.message).not.toContain('١ يناير');
      expect(familyDateMock.getBusinessDate).toHaveBeenCalledWith('family-cairo', trialEndsAt);
    });

    /** Arabic counts nouns in four cases, and `day(s)` is none of them. */
    it.each([
      [1, 'تم تمديد فترتك التجريبية يومًا واحدًا، وتستمر حتى ١ سبتمبر ٢٠٢٦.'],
      [2, 'تم تمديد فترتك التجريبية يومين، وتستمر حتى ١ سبتمبر ٢٠٢٦.'],
      [7, 'تم تمديد فترتك التجريبية ٧ أيام، وتستمر حتى ١ سبتمبر ٢٠٢٦.'],
      [30, 'تم تمديد فترتك التجريبية ٣٠ يومًا، وتستمر حتى ١ سبتمبر ٢٠٢٦.'],
    ])('inflects %i day(s) correctly in Arabic', async (extraDays, expected) => {
      repositoryMock.findActiveCampaignByCode.mockResolvedValue(trialCampaign(extraDays as number));
      trialManagerMock.extendTrial.mockResolvedValue(new Date('2026-09-01T09:00:00.000Z'));

      const result = await service.redeem('ARABIC', 'family-1');

      expect(result.message).toBe(expected);
    });
  });
});
