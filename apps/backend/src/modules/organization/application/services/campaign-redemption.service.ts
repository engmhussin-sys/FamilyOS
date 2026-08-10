import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';

import { ORGANIZATION_REPOSITORY, type IOrganizationRepository } from '../ports/organization.repository.port';
import { TrialManager } from '../../../billing/application/services/trial-manager.service';
import { BILLING_REPOSITORY, type IBillingRepository } from '../../../billing/application/ports/billing.repository.port';
import type { PartnerCampaignTypeValue } from '../../domain/organization.types';

export interface ICampaignRedemptionResult {
  campaignType: PartnerCampaignTypeValue;
  message: string;
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
        return {
          campaignType: campaign.type,
          message: `Your trial has been extended by ${extraDays} day(s), now ending ${newTrialEndsAt.toISOString().split('T')[0]}.`,
        };
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
    return {
      campaignType,
      message: `A ${discountPercent}% discount has been applied — it will be used automatically the next time you subscribe or renew.`,
    };
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
