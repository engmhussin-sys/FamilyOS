import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';

import { ORGANIZATION_REPOSITORY, type IOrganizationRepository } from '../ports/organization.repository.port';
import { TrialManager } from '../../../billing/application/services/trial-manager.service';
import type { PartnerCampaignTypeValue } from '../../domain/organization.types';

export interface ICampaignRedemptionResult {
  campaignType: PartnerCampaignTypeValue;
  message: string;
}

/**
 * Sprint B4 — the real business value of Partner Campaigns: applying
 * a code's actual benefit to a family, not just storing the code.
 * Deliberately implements TRIAL_EXTENSION only for this first pass:
 *
 * - DISCOUNT would need a real per-invoice discount mechanism in
 *   billing (a genuine schema/logic addition to InvoiceService, not
 *   guessed at here). Fails loudly with a clear "not yet supported"
 *   error rather than silently doing nothing.
 * - REFERRAL/COUPON/QR_CODE are, in this first pass, the SAME
 *   underlying mechanism as TRIAL_EXTENSION — a campaign's `type`
 *   says WHAT KIND of code it is; `config`'s shape drives the actual
 *   behavior, matching this module's own established "config varies
 *   by type, Json by design" principle from PartnerCampaign's own
 *   schema docstring.
 */
@Injectable()
export class CampaignRedemptionService {
  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly repository: IOrganizationRepository,
    private readonly trialManager: TrialManager,
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
        const extraDays = this.readExtraDays(campaign.config);
        if (extraDays === null) {
          throw new BadRequestException(`Campaign "${code}" is misconfigured — missing a valid "extraDays" value.`);
        }
        const newTrialEndsAt = await this.trialManager.extendTrial(familyId, extraDays);
        return {
          campaignType: campaign.type,
          message: `Your trial has been extended by ${extraDays} day(s), now ending ${newTrialEndsAt.toISOString().split('T')[0]}.`,
        };
      }
      case 'DISCOUNT':
        throw new BadRequestException('Discount codes are not yet supported — this is a real, flagged gap, not silently ignored.');
      default:
        throw new BadRequestException('Unknown campaign type.');
    }
  }

  private readExtraDays(config: Record<string, unknown>): number | null {
    const value = config.extraDays;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    return null;
  }
}
