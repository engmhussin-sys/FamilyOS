import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import { cac, kpiValue, rate, roas, type KpiValue } from '../domain/kpi-definitions';
import type { AcquisitionChannel } from '../domain/attribution';

export interface ICampaignInput {
  readonly name: string;
  readonly channel: AcquisitionChannel;
  readonly countryCode: string;
  readonly budgetMinor: number;
  readonly currencyCode: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly targetUsers: number;
  readonly targetPaidUsers: number;
  readonly utmCampaign?: string;
  readonly notes?: string;
}

export interface ICampaignSpendInput {
  readonly businessDate: Date;
  readonly spendMinor: number;
  readonly impressions?: number;
  readonly clicks?: number;
  readonly visits?: number;
  readonly leads?: number;
}

export interface ICampaignPerformance {
  readonly id: string;
  readonly name: string;
  readonly channel: AcquisitionChannel;
  readonly countryCode: string;
  readonly currencyCode: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly isActive: boolean;
  /** ADMIN-SET. Never derived, never defaulted. */
  readonly budgetMinor: number;
  readonly targetUsers: number;
  readonly targetPaidUsers: number;
  /** COMPUTED from `campaign_daily_spend`. */
  readonly spendMinor: number;
  readonly budgetUtilisation: number | null;
  readonly impressions: number;
  readonly clicks: number;
  readonly visits: number;
  readonly leads: number;
  readonly installs: number;
  readonly registrations: number;
  readonly paidUsers: number;
  readonly netRevenueMinor: number;
  readonly kpis: readonly KpiValue[];
  readonly targetAttainment: {
    readonly users: number | null;
    readonly paidUsers: number | null;
  };
}

/**
 * PHASE D (GROWTH) — CAMPAIGNS, AND THE LINE BETWEEN WHAT AN ADMIN STATES AND
 * WHAT THE SYSTEM MEASURES.
 *
 * STATED BY AN ADMIN (and NOT NULL in the schema, so a campaign cannot exist
 * without them): budget, country, channel, window, target users, target paid
 * users. There is no default budget and no default target anywhere in this
 * module — the brief's «never hardcoded» rule is enforced by the columns being
 * mandatory rather than by anybody remembering it.
 *
 * REPORTED BY AN AD PLATFORM, imported daily and idempotently: spend,
 * impressions, clicks, visits, leads. `(campaign_id, business_date)` is UNIQUE,
 * so re-importing yesterday's export corrects a row instead of doubling spend
 * — which would have halved the reported CAC, in the flattering direction.
 *
 * MEASURED BY US: installs, registrations, paid users, revenue. All four are
 * counted from rows this server wrote, joined to the campaign through
 * `acquisition_attributions`, and every derived ratio goes through the KPI
 * definitions module rather than being computed here.
 *
 * ROAS USES REALISED REVENUE ONLY. A ROAS that includes projected lifetime
 * revenue is a forecast, and this method returns `provenance: 'ACTUAL'`.
 */
@Injectable()
export class CampaignService {
  constructor(private readonly prisma: PrismaService) {}

  private sys<T>(what: string, fn: () => Promise<T>): Promise<T> {
    return runInSystemScope(
      'ADMIN_CONSOLE',
      `Campaigns are platform-level marketing configuration with no family_id; ${what}.`,
      fn,
    );
  }

  async create(input: ICampaignInput, createdByUserId: string | null): Promise<{ id: string }> {
    return this.sys('an admin is creating one', async () => {
      const created = await this.prisma.growthCampaign.create({
        data: {
          name: input.name,
          channel: input.channel,
          countryCode: input.countryCode.toUpperCase(),
          budgetMinor: input.budgetMinor,
          currencyCode: input.currencyCode.toUpperCase(),
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          targetUsers: input.targetUsers,
          targetPaidUsers: input.targetPaidUsers,
          utmCampaign: input.utmCampaign ?? null,
          notes: input.notes ?? null,
          createdByUserId,
        },
        select: { id: true },
      });
      return created;
    });
  }

  /** Idempotent daily import. Re-running the same day corrects it. */
  async recordSpend(campaignId: string, input: ICampaignSpendInput): Promise<void> {
    await this.sys('an admin is importing a day of ad-platform spend', async () => {
      const campaign = await this.prisma.growthCampaign.findUnique({
        where: { id: campaignId },
        select: { id: true },
      });
      if (!campaign) throw new NotFoundException(`No campaign ${campaignId}.`);

      const data = {
        spendMinor: input.spendMinor,
        impressions: input.impressions ?? 0,
        clicks: input.clicks ?? 0,
        visits: input.visits ?? 0,
        leads: input.leads ?? 0,
      };

      await this.prisma.campaignDailySpend.upsert({
        where: { campaignId_businessDate: { campaignId, businessDate: input.businessDate } },
        create: { campaignId, businessDate: input.businessDate, ...data },
        update: data,
      });
    });
  }

  async list(countryCode?: string): Promise<ICampaignPerformance[]> {
    const campaigns = await this.sys('an admin is listing them', () =>
      this.prisma.growthCampaign.findMany({
        where: countryCode ? { countryCode: countryCode.toUpperCase() } : {},
        orderBy: { startsAt: 'desc' },
        select: { id: true },
      }),
    );
    const out: ICampaignPerformance[] = [];
    for (const c of campaigns) out.push(await this.performance(c.id));
    return out;
  }

  async performance(campaignId: string): Promise<ICampaignPerformance> {
    return this.sys('computing one campaign\'s realised performance across every household it acquired', async () => {
      const campaign = await this.prisma.growthCampaign.findUnique({ where: { id: campaignId } });
      if (!campaign) throw new NotFoundException(`No campaign ${campaignId}.`);

      const spend = await this.prisma.campaignDailySpend.aggregate({
        where: { campaignId },
        _sum: { spendMinor: true, impressions: true, clicks: true, visits: true, leads: true },
      });
      const spendMinor = spend._sum.spendMinor ?? 0;

      // THE JOIN. A household belongs to a campaign either by the explicit
      // `campaign_id` written at registration, or by the `utm_campaign` string
      // the campaign is recognised by. Both, because a UTM may name a campaign
      // that did not exist yet when the click happened.
      const attributionWhere = {
        OR: [
          { campaignId },
          ...(campaign.utmCampaign ? [{ campaign: { equals: campaign.utmCampaign, mode: 'insensitive' as const } }] : []),
        ],
      };

      const [registrations, paidUsers, installs] = await Promise.all([
        this.prisma.acquisitionAttribution.count({ where: attributionWhere }),
        this.prisma.family.count({
          where: {
            acquisitionAttribution: attributionWhere,
            paymentTransactions: { some: { status: 'SUCCEEDED' } },
          },
        }),
        this.installsFor(attributionWhere),
      ]);

      const revenue = await this.prisma.paymentTransaction.aggregate({
        where: {
          status: 'SUCCEEDED',
          currency: campaign.currencyCode,
          family: { acquisitionAttribution: attributionWhere },
        },
        _sum: { netAmountMinor: true },
      });
      const netRevenueMinor = revenue._sum.netAmountMinor ?? 0;

      const cacValue = cac(spendMinor, paidUsers, campaign.currencyCode);
      const roasValue = roas(
        { amountMinor: netRevenueMinor, currencyCode: campaign.currencyCode },
        { amountMinor: spendMinor, currencyCode: campaign.currencyCode },
      );

      return {
        id: campaign.id,
        name: campaign.name,
        channel: campaign.channel as AcquisitionChannel,
        countryCode: campaign.countryCode,
        currencyCode: campaign.currencyCode,
        startsAt: campaign.startsAt.toISOString(),
        endsAt: campaign.endsAt.toISOString(),
        isActive: campaign.isActive,
        budgetMinor: campaign.budgetMinor,
        targetUsers: campaign.targetUsers,
        targetPaidUsers: campaign.targetPaidUsers,
        spendMinor,
        budgetUtilisation: campaign.budgetMinor === 0 ? null : Math.round((spendMinor / campaign.budgetMinor) * 10_000) / 10_000,
        impressions: spend._sum.impressions ?? 0,
        clicks: spend._sum.clicks ?? 0,
        visits: spend._sum.visits ?? 0,
        leads: spend._sum.leads ?? 0,
        installs,
        registrations,
        paidUsers,
        netRevenueMinor,
        kpis: [
          kpiValue('CAC', 'ACTUAL', cacValue),
          kpiValue('ROAS', 'ACTUAL', roasValue),
          kpiValue('CONVERSION_RATE', 'ACTUAL', rate(paidUsers, registrations)),
        ],
        targetAttainment: {
          users: campaign.targetUsers === 0 ? null : Math.round((registrations / campaign.targetUsers) * 10_000) / 10_000,
          paidUsers:
            campaign.targetPaidUsers === 0
              ? null
              : Math.round((paidUsers / campaign.targetPaidUsers) * 10_000) / 10_000,
        },
      };
    });
  }

  /**
   * Installs attributable to the campaign, joined through the SESSION id the
   * install event carried and the attribution row later recorded. Households
   * whose client did not send a session id are simply not counted — an honest
   * undercount rather than an invented number.
   */
  private async installsFor(attributionWhere: Record<string, unknown>): Promise<number> {
    const sessions = await this.prisma.acquisitionAttribution.findMany({
      where: { ...attributionWhere, sessionId: { not: null } },
      select: { sessionId: true },
    });
    const ids = sessions.map((s) => s.sessionId).filter((s): s is string => s !== null);
    if (ids.length === 0) return 0;

    const rows = await this.prisma.analyticsEvent.findMany({
      where: { eventName: 'APP_INSTALLED', sessionId: { in: ids } },
      distinct: ['sessionId'],
      select: { sessionId: true },
    });
    return rows.length;
  }

  async setActive(campaignId: string, isActive: boolean): Promise<void> {
    await this.sys('an admin is pausing or resuming a campaign', () =>
      this.prisma.growthCampaign.update({ where: { id: campaignId }, data: { isActive } }),
    );
  }
}
