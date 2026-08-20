import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import { getBusinessDayRange } from '../../../common/time/family-date';
import { GrowthSettingsService } from './growth-settings.service';
import { PLATFORM_SCOPE } from './kpi.service';
import {
  FUNNEL_STEPS,
  FUNNEL_STEP_DEFINITIONS,
  type FunnelStep,
  type FunnelStepSource,
} from '../domain/growth-events';
import { rate } from '../domain/kpi-definitions';
import { ACQUISITION_CHANNELS, type AcquisitionChannel } from '../domain/attribution';
import { familyCountryWhere } from '../domain/country-attribution';

export interface IFunnelStepResult {
  readonly step: FunnelStep;
  readonly count: number;
  readonly source: FunnelStepSource;
  /** Conversion from the PREVIOUS step. `null` for the first step and for a zero base. */
  readonly stepConversion: number | null;
  /** Conversion from INSTALL — the first step this backend can actually measure. */
  readonly fromMeasurableTop: number | null;
  readonly note: string;
}

export interface IFunnelResult {
  readonly countryCode: string;
  readonly channel: AcquisitionChannel | null;
  readonly campaignId: string | null;
  readonly from: string;
  readonly to: string;
  readonly reportingTimeZone: string;
  readonly steps: readonly IFunnelStepResult[];
  /**
   * TRUE when a later step outnumbers an earlier one. It is REPORTED rather
   * than hidden, because it is a real and diagnosable condition (an ad platform
   * under-reporting visits, or a cohort whose installs predate the window), and
   * silently clamping it would make the data look clean while being wrong.
   */
  readonly monotonicityViolations: readonly string[];
}

/**
 * PHASE D (GROWTH) — THE ELEVEN-STEP ACQUISITION FUNNEL.
 *
 * IMPRESSION → VISIT → INSTALL → REGISTRATION → FAMILY_CREATED → CHILD_ADDED →
 * FIRST_GOAL → FIRST_REWARD → TRIAL → PAID → RENEWAL.
 *
 * THE HONEST PART, AND IT IS THE PART MOST FUNNEL IMPLEMENTATIONS HIDE: this
 * backend cannot observe the first two steps. An ad impression happens inside
 * TikTok and a landing-page visit happens on a marketing site this server does
 * not host. Their numbers come from `campaign_daily_spend`, REPORTED by an
 * operator from the ad platform's own export, and every step carries a `source`
 * of `EXTERNAL_REPORTED`, `ANALYTICS_EVENT` or `DOMAIN_TABLE` so the dashboard
 * can render a reported number differently from a measured one. A funnel that
 * presents an ad network's impression count in the same visual weight as its
 * own payment table is lying by typography.
 *
 * COUNTS ARE OF FAMILIES, NOT OF EVENTS. A household with three children has
 * passed CHILD_ADDED once, not three times. This is the single most common way
 * a funnel produces a conversion rate above 100%.
 */
@Injectable()
export class FunnelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GrowthSettingsService,
  ) {}

  async build(params: {
    countryCode: string;
    channel?: AcquisitionChannel;
    campaignId?: string;
    from: Date;
    to: Date;
  }): Promise<IFunnelResult> {
    const timeZone = await this.settings.reportingTimeZone(params.countryCode);
    const fromRange = getBusinessDayRange(params.from, timeZone);
    const toRange = getBusinessDayRange(params.to, timeZone);
    const window = { gte: fromRange.start, lt: toRange.endExclusive };

    return runInSystemScope(
      'ADMIN_CONSOLE',
      'The acquisition funnel counts households across every tenant; the aggregation is the feature and the surface is behind InternalAdminGuard.',
      async () => {
        // The attribution predicate every family-level step is filtered by.
        // A step that ignored it would silently report the WHOLE funnel under
        // one channel's name.
        //
        // F1 SPLIT THIS IN TWO, and the split is the point. CHANNEL and CAMPAIGN
        // are properties of the acquisition record — there is nowhere else they
        // could come from. COUNTRY is a property of the HOUSEHOLD, and now has a
        // server-held, foreign-key-backed column of its own; reading it off the
        // marketing label meant a family that told us its market at registration
        // but arrived without UTM parameters appeared in NO country's funnel.
        const attributionWhere: Record<string, unknown> = {};
        if (params.channel) attributionWhere.channel = params.channel;
        if (params.campaignId) attributionWhere.campaignId = params.campaignId;

        const familyWhere = {
          deletedAt: null,
          createdAt: window,
          ...familyCountryWhere(params.countryCode),
          ...(Object.keys(attributionWhere).length > 0
            ? { acquisitionAttribution: attributionWhere }
            : {}),
        };

        // ---- EXTERNAL_REPORTED steps -------------------------------------
        const spendWhere = {
          businessDate: { gte: fromRange.start, lte: toRange.start },
          campaign: {
            ...(params.countryCode === PLATFORM_SCOPE ? {} : { countryCode: params.countryCode }),
            ...(params.channel ? { channel: params.channel } : {}),
            ...(params.campaignId ? { id: params.campaignId } : {}),
          },
        };
        const reported = await this.prisma.campaignDailySpend.aggregate({
          where: spendWhere,
          _sum: { impressions: true, visits: true },
        });

        // ---- INSTALL: an anonymous analytics event, so it is counted by
        //      DISTINCT SESSION rather than by family (there is no family yet).
        const installSessions = await this.prisma.analyticsEvent.findMany({
          where: { eventName: 'APP_INSTALLED', occurredAt: window },
          distinct: ['sessionId'],
          select: { sessionId: true },
        });

        // ---- DOMAIN_TABLE steps ------------------------------------------
        const [registrations, withChild, withGoal, withReward, withTrial, paid, renewed] = await Promise.all([
          this.prisma.family.count({ where: familyWhere }),
          this.prisma.family.count({ where: { ...familyWhere, children: { some: { deletedAt: null } } } }),
          this.goalFamilies(familyWhere, window),
          this.prisma.family.count({
            where: { ...familyWhere, rewardsLedgerEntries: { some: { type: 'EARN' } } },
          }),
          this.prisma.family.count({ where: { ...familyWhere, trial: { isNot: null } } }),
          this.prisma.family.count({
            where: { ...familyWhere, paymentTransactions: { some: { status: 'SUCCEEDED' } } },
          }),
          this.renewedFamilies(familyWhere),
        ]);

        const counts: Record<FunnelStep, number> = {
          IMPRESSION: reported._sum.impressions ?? 0,
          VISIT: reported._sum.visits ?? 0,
          INSTALL: installSessions.length,
          REGISTRATION: registrations,
          FAMILY_CREATED: registrations,
          CHILD_ADDED: withChild,
          FIRST_GOAL: withGoal,
          FIRST_REWARD: withReward,
          TRIAL: withTrial,
          PAID: paid,
          RENEWAL: renewed,
        };

        const steps: IFunnelStepResult[] = [];
        const violations: string[] = [];
        const measurableTop = counts.INSTALL;

        FUNNEL_STEPS.forEach((step, index) => {
          const previous = index === 0 ? null : counts[FUNNEL_STEPS[index - 1]];
          if (previous !== null && counts[step] > previous) {
            violations.push(
              `${step} (${counts[step]}) exceeds ${FUNNEL_STEPS[index - 1]} (${previous}) — reported upstream data is incomplete or the cohort predates the window.`,
            );
          }
          const definition = FUNNEL_STEP_DEFINITIONS[step];
          steps.push({
            step,
            count: counts[step],
            source: definition.source,
            stepConversion: previous === null ? null : rate(Math.min(counts[step], previous), previous),
            fromMeasurableTop:
              index < 2 ? null : rate(Math.min(counts[step], measurableTop), measurableTop),
            note: definition.note,
          });
        });

        return {
          countryCode: params.countryCode,
          channel: params.channel ?? null,
          campaignId: params.campaignId ?? null,
          from: fromRange.start.toISOString(),
          to: toRange.endExclusive.toISOString(),
          reportingTimeZone: timeZone,
          steps,
          monotonicityViolations: violations,
        };
      },
    );
  }

  /**
   * Households that created a goal. Counted from the GROWTH EVENT rather than
   * from four separate tables (habits, tasks, learning goals, reward programs),
   * because "a goal" is a product concept spanning all four and the emitter is
   * the one place that already knows they are the same thing.
   */
  private async goalFamilies(
    familyWhere: Record<string, unknown>,
    window: { gte: Date; lt: Date },
  ): Promise<number> {
    const families = await this.prisma.family.findMany({ where: familyWhere, select: { id: true } });
    if (families.length === 0) return 0;
    const ids = families.map((f) => f.id);

    const rows = await this.prisma.analyticsEvent.findMany({
      where: { eventName: 'GOAL_CREATED', familyId: { in: ids }, occurredAt: window },
      distinct: ['familyId'],
      select: { familyId: true },
    });
    return rows.length;
  }

  /**
   * RENEWAL is the SECOND successful charge. Reading `auto_renewing` instead
   * would count intent; a renewal is money, and money is a row in
   * `payment_transactions`.
   */
  private async renewedFamilies(familyWhere: Record<string, unknown>): Promise<number> {
    const families = await this.prisma.family.findMany({
      where: familyWhere,
      select: { id: true, _count: { select: { paymentTransactions: true } } },
    });
    // `_count` is unconditional, so the SUCCEEDED filter is applied by a second
    // pass over only the households that could possibly qualify.
    const candidates = families.filter((f) => f._count.paymentTransactions >= 2).map((f) => f.id);
    if (candidates.length === 0) return 0;

    const grouped = await this.prisma.paymentTransaction.groupBy({
      by: ['familyId'],
      where: { familyId: { in: candidates }, status: 'SUCCEEDED' },
      _count: { _all: true },
    });
    return grouped.filter((g) => g._count._all >= 2).length;
  }

  /** Registrations broken down by channel — the "which channel works" view. */
  async byChannel(params: { countryCode: string; from: Date; to: Date }): Promise<
    Array<{ channel: AcquisitionChannel; registrations: number; paid: number; conversion: number | null }>
  > {
    const timeZone = await this.settings.reportingTimeZone(params.countryCode);
    const window = {
      gte: getBusinessDayRange(params.from, timeZone).start,
      lt: getBusinessDayRange(params.to, timeZone).endExclusive,
    };

    return runInSystemScope(
      'ADMIN_CONSOLE',
      'Channel performance is a count over households by acquisition channel; behind InternalAdminGuard.',
      async () => {
        const out = [];
        for (const channel of ACQUISITION_CHANNELS) {
          // F1: the CHANNEL still comes from the acquisition record (it can come
          // from nowhere else); the COUNTRY comes from the shared household
          // predicate, so this view counts the same families as every other one.
          const where = {
            deletedAt: null,
            createdAt: window,
            ...familyCountryWhere(params.countryCode),
            acquisitionAttribution: { channel },
          };
          const [registrations, paid] = await Promise.all([
            this.prisma.family.count({ where }),
            this.prisma.family.count({
              where: { ...where, paymentTransactions: { some: { status: 'SUCCEEDED' } } },
            }),
          ]);
          if (registrations === 0 && paid === 0) continue;
          out.push({ channel, registrations, paid, conversion: rate(paid, registrations) });
        }
        return out;
      },
    );
  }
}
