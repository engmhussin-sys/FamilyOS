import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';

import { ORGANIZATION_REPOSITORY, type IOrganizationRepository } from '../ports/organization.repository.port';
import { TrialManager } from '../../../billing/application/services/trial-manager.service';
import { BILLING_REPOSITORY, type IBillingRepository } from '../../../billing/application/ports/billing.repository.port';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import type { PartnerCampaignTypeValue } from '../../domain/organization.types';
import { CAMPAIGN_COPY_AR } from '../../domain/campaign-copy';

export interface ICampaignRedemptionResult {
  campaignType: PartnerCampaignTypeValue;
  /**
   * THE SENTENCE THE PARENT READS, and it is Arabic.
   *
   * `redeem_code_screen.dart` renders this field verbatim and deliberately
   * prefers it over its own localised fallback, because only the server knows
   * the real numbers. That is the right call — and it is precisely why this
   * field being English was a defect no client could compensate for.
   */
  message: string;
  /**
   * The same string under the name B3 established for user-facing prose
   * (`common/errors/error-response.ts`), so a client written to
   * `messageAr ?? message` — which is what the parent app does on every FAILURE
   * path — reads the same sentence on the SUCCESS path. It is an ALIAS, not a
   * second translation: two copies free to drift is the defect this module is
   * removing, and the shipped client keys on `message`.
   */
  messageAr: string;
}

/**
 * Sprint B4 — the real business value of Partner Campaigns: applying
 * a code's actual benefit to a family, not just storing the code.
 *
 * UPDATED (CLOSES A REAL GAP previously explicitly flagged as
 * unimplemented): DISCOUNT campaigns now apply a one-time percentage
 * discount to the family's subscription — see Subscription's own
 * schema docstring for the exact, deliberately narrow semantic
 * (single use, not stackable, not recurring).
 *
 * REFERRAL/COUPON/QR_CODE are, in this first pass, the SAME
 * underlying mechanism as TRIAL_EXTENSION or DISCOUNT — a campaign's
 * `type` says WHAT KIND of code it is; `config`'s shape (whether it
 * has `extraDays` or `discountPercent`) drives the actual behavior,
 * matching this module's own established "config varies by type,
 * Json by design" principle from PartnerCampaign's own schema
 * docstring.
 */
@Injectable()
export class CampaignRedemptionService {
  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly repository: IOrganizationRepository,
    private readonly trialManager: TrialManager,
    @Inject(BILLING_REPOSITORY) private readonly billingRepository: IBillingRepository,
    /** From the `@Global` TimeModule — the ONE reader of `Family.timezone`. */
    private readonly familyDate: FamilyDateService,
  ) {}

  async redeem(code: string, familyId: string): Promise<ICampaignRedemptionResult> {
    const campaign = await this.repository.findActiveCampaignByCode(code);
    if (!campaign) {
      throw new NotFoundException('This code is invalid, expired, or no longer active.');
    }

    switch (campaign.type) {
      case 'TRIAL_EXTENSION':
      case 'REFERRAL':
      case 'COUPON':
      case 'QR_CODE': {
        // A REFERRAL/COUPON/QR_CODE campaign MAY be configured with
        // a discount instead of a trial extension — checked first,
        // since a campaign's config decides its real behavior, not
        // its type code alone.
        const discountPercent = this.readDiscountPercent(campaign.config);
        if (discountPercent !== null) {
          return this.applyDiscount(campaign.type, familyId, discountPercent);
        }

        const extraDays = this.readExtraDays(campaign.config);
        if (extraDays === null) {
          throw new BadRequestException(`Campaign "${code}" is misconfigured — missing a valid "extraDays" or "discountPercent" value.`);
        }
        const newTrialEndsAt = await this.trialManager.extendTrial(familyId, extraDays);
        // WHICH DAY THE TRIAL ENDS ON IS THE FAMILY'S QUESTION, NOT UTC'S.
        // `toISOString().split('T')[0]` is the exact construct B1+B2 removed
        // from fourteen sites: a trial ending at 01:00 on the 1st in Cairo was
        // announced to that family as the 31st. The instant comes from
        // TrialManager; only `Family.timezone` decides which calendar day it is.
        const trialEndsOn = await this.familyDate.getBusinessDate(familyId, newTrialEndsAt);
        const message = CAMPAIGN_COPY_AR.trialExtended(extraDays, trialEndsOn);
        return { campaignType: campaign.type, message, messageAr: message };
      }
      case 'DISCOUNT': {
        const discountPercent = this.readDiscountPercent(campaign.config);
        if (discountPercent === null) {
          throw new BadRequestException(`Campaign "${code}" is misconfigured — missing a valid "discountPercent" value.`);
        }
        return this.applyDiscount(campaign.type, familyId, discountPercent);
      }
      default:
        throw new BadRequestException('Unknown campaign type.');
    }
  }

  private async applyDiscount(campaignType: PartnerCampaignTypeValue, familyId: string, discountPercent: number): Promise<ICampaignRedemptionResult> {
    const subscription = await this.billingRepository.findSubscriptionByFamily(familyId);
    if (!subscription) {
      throw new NotFoundException('No subscription found for this family to apply a discount to.');
    }
    await this.billingRepository.setPendingDiscount(subscription.id, discountPercent);
    const message = CAMPAIGN_COPY_AR.discountApplied(discountPercent);
    return { campaignType, message, messageAr: message };
  }

  private readExtraDays(config: Record<string, unknown>): number | null {
    const value = config.extraDays;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    return null;
  }

  private readDiscountPercent(config: Record<string, unknown>): number | null {
    const value = config.discountPercent;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100) return value;
    return null;
  }
}
