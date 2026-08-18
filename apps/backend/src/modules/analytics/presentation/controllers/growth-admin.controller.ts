import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { KpiService, PLATFORM_SCOPE } from '../../application/kpi.service';
import { FunnelService } from '../../application/funnel.service';
import { CampaignService } from '../../application/campaign.service';
import { ForecastService } from '../../application/forecast.service';
import { GrowthAlertsService } from '../../application/growth-alerts.service';
import { GrowthAggregationService } from '../../application/growth-aggregation.service';
import { GrowthSettingsService } from '../../application/growth-settings.service';
import { MarketReportingService } from '../../application/market-reporting.service';
import { PilotEnrollmentService } from '../../application/pilot-enrollment.service';
import { KPI_DEFINITIONS } from '../../domain/kpi-definitions';
import {
  FUNNEL_STEPS,
  FUNNEL_STEP_DEFINITIONS,
  GROWTH_EVENT_CATALOGUE,
  GROWTH_EVENT_NAMES,
} from '../../domain/growth-events';
import { ACQUISITION_CHANNELS, type AcquisitionChannel } from '../../domain/attribution';
import { FORECAST_SCENARIOS, QUARTERS, TARGET_METRICS, type Quarter, type TargetMetric } from '../../domain/forecast';
import { ACTIVATION_RULE_VERSION, MEANINGFUL_COMPLETION_KINDS } from '../../domain/activation';

const COUNTRY_PATTERN = /^([A-Z]{2}|\*\*)$/;

class ScopeQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;

  @IsOptional()
  @IsDateString()
  asOf?: string;
}

class RangeQueryDto extends ScopeQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsIn(ACQUISITION_CHANNELS)
  channel?: AcquisitionChannel;

  @IsOptional()
  @IsString()
  campaignId?: string;
}

class CreateCampaignDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(ACQUISITION_CHANNELS)
  channel!: AcquisitionChannel;

  @IsString()
  @MaxLength(2)
  countryCode!: string;

  /** ADMIN-SET. There is no default budget anywhere in this module. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budgetMinor!: number;

  @IsString()
  @MaxLength(3)
  currencyCode!: string;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  targetUsers!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  targetPaidUsers!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  utmCampaign?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

class RecordSpendDto {
  @IsDateString()
  businessDate!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  spendMinor!: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) impressions?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) clicks?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) visits?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) leads?: number;
}

class UpsertScenarioDto {
  @IsIn(FORECAST_SCENARIOS)
  scenario!: 'CONSERVATIVE' | 'BASE' | 'AGGRESSIVE';

  @IsString() @MaxLength(2) countryCode!: string;
  @IsString() @MaxLength(3) currencyCode!: string;

  @Type(() => Number) @IsInt() @Min(0) monthlyAcquisition!: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) conversionRate!: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) paidConversionRate!: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) churnRate!: number;
  @Type(() => Number) @IsInt() @Min(0) arpuMinor!: number;
  @Type(() => Number) @IsInt() @Min(0) cacMinor!: number;
  @Type(() => Number) @IsNumber() @Min(0) @Max(1) retentionD30!: number;
}

class SetTargetDto {
  @IsString() @MaxLength(2) countryCode!: string;
  @Type(() => Number) @IsInt() @Min(2024) @Max(2100) year!: number;
  @Type(() => Number) @IsInt() @IsIn([...QUARTERS]) quarter!: Quarter;
  @IsIn(TARGET_METRICS) metric!: TargetMetric;
  @Type(() => Number) @IsNumber() targetValue!: number;

  @IsOptional() @IsString() @MaxLength(3) currencyCode?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class SetSettingDto {
  @IsString() @MaxLength(80) key!: string;
  @IsString() @MaxLength(200) value!: string;
}

/** F1. A half-open `[from, to)` window, with no channel/campaign slicing. */
class WindowQueryDto extends ScopeQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

/**
 * F1. `cohortId` is FREE TEXT against `growth_settings.pilot.cohortId`, so it is
 * length-bounded here and nowhere else — it names a marketing wave, not a row a
 * tenant could reach.
 */
class PilotQueryDto extends ScopeQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  cohortId?: string;
}

class AlertQueryDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  acknowledged?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

/**
 * PHASE D (GROWTH) — THE ADMIN API THE COMMERCIAL DASHBOARD CONSUMES.
 *
 * EVERY ROUTE HERE IS CROSS-TENANT BY DEFINITION and every one of them is
 * behind `InternalAdminGuard` + `@PlatformAdminSurface()` + a `@SystemRoute`
 * that states why. There is deliberately NO parent-facing variant of any of
 * them: "how many households converted in Egypt last week" is not a question a
 * tenant may ask, and the way to guarantee that is for the endpoint not to
 * exist rather than for a filter to be remembered.
 *
 * THE CONTRACT IS STABLE BY CONSTRUCTION, and the two properties that make it
 * so are worth stating for the dashboard that will be built against it:
 *
 *   1. EVERY NUMERIC VALUE CARRIES A `provenance` OF `ACTUAL | TARGET |
 *      FORECAST`, and money carries a `currencyCode`. A field will never
 *      change meaning between releases; a new KPI arrives as a new entry in
 *      the `values` array, which an existing dashboard ignores harmlessly.
 *   2. `null` MEANS "NO DATA", NEVER ZERO. A cohort too young to have a D90
 *      number returns `null`, and a dashboard must render that as "—" rather
 *      than as 0%. This is the single most important line in this contract.
 *
 * `GET /admin/growth/catalogue` exists so the dashboard never hardcodes a KPI
 * list, a channel list, a funnel order or an event name. It is the machine-
 * readable form of everything `domain/` declares.
 */
@Controller('admin/growth')
@PlatformAdminSurface()
@UseGuards(InternalAdminGuard)
export class GrowthAdminController {
  constructor(
    private readonly kpis: KpiService,
    private readonly funnel: FunnelService,
    private readonly campaigns: CampaignService,
    private readonly forecasts: ForecastService,
    private readonly alerts: GrowthAlertsService,
    private readonly aggregation: GrowthAggregationService,
    private readonly settings: GrowthSettingsService,
    private readonly markets: MarketReportingService,
    private readonly pilot: PilotEnrollmentService,
  ) {}

  private scope(countryCode: string | undefined): string {
    const value = (countryCode ?? PLATFORM_SCOPE).toUpperCase();
    if (!COUNTRY_PATTERN.test(value)) {
      throw new BadRequestException('countryCode must be an ISO-3166 alpha-2 code, or ** for the whole platform.');
    }
    return value;
  }

  private instant(value: string | undefined, fallback: Date): Date {
    if (!value) return fallback;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`Not a date: ${value}`);
    return parsed;
  }

  /**
   * THE CATALOGUE. Definitions, not data — safe to cache hard on the client.
   * A dashboard that reads this never has to duplicate a formula, a channel
   * list or a funnel ordering, which is what keeps the two codebases from
   * disagreeing about what a metric means.
   */
  @Get('catalogue')
  @SystemRoute('ADMIN_CONSOLE', 'Static definitions of KPIs, events, channels and funnel steps; contains no tenant data at all.')
  catalogue() {
    return {
      kpis: Object.values(KPI_DEFINITIONS),
      growthEvents: GROWTH_EVENT_NAMES.map((name) => GROWTH_EVENT_CATALOGUE[name]),
      channels: ACQUISITION_CHANNELS,
      funnelSteps: FUNNEL_STEPS.map((step) => FUNNEL_STEP_DEFINITIONS[step]),
      forecastScenarios: FORECAST_SCENARIOS,
      targetMetrics: TARGET_METRICS,
      activation: {
        eventName: 'CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL',
        ruleVersion: ACTIVATION_RULE_VERSION,
        meaningfulCompletionKinds: [...MEANINGFUL_COMPLETION_KINDS],
        gates: [
          'REAL: arrived as a REWARD_GRANTED domain event, i.e. the ledger confirmed a grant.',
          'A GOAL: completionKind is in meaningfulCompletionKinds (STREAK is excluded — it is derived from completions already counted).',
          'NOT A DEMONSTRATION: at least activation.minMinutesAfterChildCreated elapsed between the child row and the completion.',
          'FIRST: family_activations.family_id is UNIQUE.',
        ],
      },
    };
  }

  /** Every KPI for one market at one instant. The dashboard's headline row. */
  @Get('kpis')
  @SystemRoute('ADMIN_CONSOLE', 'Growth KPIs are counts and sums over every household; the cross-tenant aggregation is the feature.')
  kpiSnapshot(@Query() query: ScopeQueryDto) {
    return this.kpis.snapshot({
      countryCode: this.scope(query.countryCode),
      asOf: this.instant(query.asOf, new Date()),
    });
  }

  /** The eleven-step funnel, optionally sliced by channel or campaign. */
  @Get('funnel')
  @SystemRoute('ADMIN_CONSOLE', 'The acquisition funnel counts households across every tenant.')
  funnelReport(@Query() query: RangeQueryDto) {
    const now = new Date();
    return this.funnel.build({
      countryCode: this.scope(query.countryCode),
      channel: query.channel,
      campaignId: query.campaignId,
      from: this.instant(query.from, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
      to: this.instant(query.to, now),
    });
  }

  @Get('channels')
  @SystemRoute('ADMIN_CONSOLE', 'Per-channel registration and conversion counts across every tenant.')
  channelReport(@Query() query: RangeQueryDto) {
    const now = new Date();
    return this.funnel.byChannel({
      countryCode: this.scope(query.countryCode),
      from: this.instant(query.from, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
      to: this.instant(query.to, now),
    });
  }

  /** The stored daily series — what a chart reads instead of re-scanning tables. */
  @Get('daily')
  @SystemRoute('ADMIN_CONSOLE', 'The stored cross-tenant daily aggregate; one row per reporting day and market.')
  daily(@Query() query: RangeQueryDto) {
    const now = new Date();
    const from = this.instant(query.from, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
    const to = this.instant(query.to, now);
    return this.aggregation.series(
      this.scope(query.countryCode),
      from.toISOString().slice(0, 10),
      to.toISOString().slice(0, 10),
    );
  }

  // ---- F1: THE MARKET READS ------------------------------------------------
  //
  // Four routes that exist because `families.country_code` does. Each one is
  // per-market and each one carries `scopeIncludesUnattributable`, so a
  // dashboard can tell «Egypt» from «the platform, including households whose
  // market nobody knows» without guessing. None of them returns money, and none
  // of them returns a zero it did not measure — read the header of
  // `MarketReportingService` for the five rules they all obey.

  /**
   * FAMILIES PER MARKET — registered (stock) and active (the MAU definition).
   * `countryCode` defaults to `**`; pass `EG` or `SA` for one market.
   */
  @Get('families')
  @SystemRoute('ADMIN_CONSOLE', 'A market\'s household count is an aggregate over every tenant; that is the whole question being asked.')
  families(@Query() query: ScopeQueryDto) {
    return this.markets.families(this.scope(query.countryCode), this.instant(query.asOf, new Date()));
  }

  /** THE PLAN MIX — free / monthly / quarterly / annual, per market. */
  @Get('subscriptions')
  @SystemRoute('ADMIN_CONSOLE', 'The plan mix groups every household\'s subscription; no tenant may ask what other households bought.')
  subscriptions(@Query() query: ScopeQueryDto) {
    return this.markets.subscriptionMix(this.scope(query.countryCode), this.instant(query.asOf, new Date()));
  }

  /**
   * PILOT ENROLMENT — invited vs activated, by country and cohort.
   *
   * `pilot_invites` is a GLOBAL allow-list with no `family_id`, and it is
   * attributed by ITS OWN `country_code` because an invitation predates the
   * household — see `PilotEnrollmentService.enrolmentCounts`.
   */
  @Get('pilot')
  @SystemRoute('ADMIN_CONSOLE', 'pilot_invites is a GLOBAL operator allow-list; reading it is a platform question and has no tenant form.')
  pilotEnrolment(@Query() query: PilotQueryDto) {
    const country = this.scope(query.countryCode);
    return this.pilot.enrolmentCounts(country === PLATFORM_SCOPE ? null : country, query.cohortId);
  }

  /**
   * GOALS COMPLETED AND REWARDS GRANTED over `[from, to)`, per market.
   * Defaults to the last 30 days, the same default `funnel` and `daily` use.
   */
  @Get('product')
  @SystemRoute('ADMIN_CONSOLE', 'Goal completions and reward grants are counted across every household; the aggregation is the feature.')
  product(@Query() query: WindowQueryDto) {
    const now = new Date();
    return this.markets.product(
      this.scope(query.countryCode),
      this.instant(query.from, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
      this.instant(query.to, now),
    );
  }

  // ---- campaigns ----------------------------------------------------------

  @Get('campaigns')
  @SystemRoute('ADMIN_CONSOLE', 'Marketing campaigns are platform configuration; performance joins every household they acquired.')
  listCampaigns(@Query() query: ScopeQueryDto) {
    const country = query.countryCode ? this.scope(query.countryCode) : undefined;
    return this.campaigns.list(country === PLATFORM_SCOPE ? undefined : country);
  }

  @Get('campaigns/:id')
  @SystemRoute('ADMIN_CONSOLE', 'One campaign\'s realised spend, acquisition and revenue.')
  campaign(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.performance(id);
  }

  @Post('campaigns')
  @SystemRoute('ADMIN_CONSOLE', 'An admin creates a campaign; every budget and target is stated by them, never defaulted.')
  createCampaign(@Body() dto: CreateCampaignDto, @CurrentUser() user: IJwtPayload | undefined) {
    return this.campaigns.create(
      {
        name: dto.name,
        channel: dto.channel,
        countryCode: dto.countryCode,
        budgetMinor: dto.budgetMinor,
        currencyCode: dto.currencyCode,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        targetUsers: dto.targetUsers,
        targetPaidUsers: dto.targetPaidUsers,
        utmCampaign: dto.utmCampaign,
        notes: dto.notes,
      },
      user?.sub ?? null,
    );
  }

  /** Idempotent per (campaign, day) — re-importing corrects rather than doubles. */
  @Post('campaigns/:id/spend')
  @SystemRoute('ADMIN_CONSOLE', 'An admin imports a day of ad-platform spend for a campaign.')
  async recordSpend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordSpendDto) {
    await this.campaigns.recordSpend(id, {
      businessDate: new Date(`${dto.businessDate.slice(0, 10)}T00:00:00.000Z`),
      spendMinor: dto.spendMinor,
      impressions: dto.impressions,
      clicks: dto.clicks,
      visits: dto.visits,
      leads: dto.leads,
    });
    return { ok: true };
  }

  // ---- forecasting --------------------------------------------------------

  @Get('forecast')
  @SystemRoute('ADMIN_CONSOLE', 'Projections from admin-editable assumptions; every value is tagged FORECAST.')
  forecast(@Query() query: ScopeQueryDto & { months?: string }) {
    const country = this.scope(query.countryCode);
    if (country === PLATFORM_SCOPE) {
      throw new BadRequestException('A forecast is per-market: countryCode is required and cannot be **.');
    }
    const months = Number(query.months ?? 12);
    return this.forecasts.project(country, Number.isInteger(months) ? months : 12);
  }

  @Post('forecast/scenario')
  @SystemRoute('ADMIN_CONSOLE', 'An admin edits a scenario\'s assumptions; the assumptions are returned with every projection derived from them.')
  async upsertScenario(@Body() dto: UpsertScenarioDto, @CurrentUser() user: IJwtPayload | undefined) {
    await this.forecasts.upsertScenario(dto, user?.sub ?? null);
    return { ok: true };
  }

  /**
   * THE THREE-WAY QUARTERLY VIEW. `target`, `actual` and `forecast` are three
   * separate fields on every row, and a `null` target means nobody committed to
   * one — it is never inferred from the forecast.
   */
  @Get('quarterly')
  @SystemRoute('ADMIN_CONSOLE', 'Target vs actual vs forecast per market and quarter; actuals span every household.')
  quarterly(@Query() query: ScopeQueryDto & { year?: string }) {
    const country = this.scope(query.countryCode);
    if (country === PLATFORM_SCOPE) {
      throw new BadRequestException('Quarterly targets are per-market: countryCode is required and cannot be **.');
    }
    const year = Number(query.year ?? new Date().getUTCFullYear());
    if (!Number.isInteger(year)) throw new BadRequestException('year must be an integer.');
    return this.forecasts.quarterlyComparison(country, year, new Date());
  }

  @Post('quarterly/target')
  @SystemRoute('ADMIN_CONSOLE', 'An admin commits to a quarterly target. A target is an input; nothing in this system invents one.')
  async setTarget(@Body() dto: SetTargetDto, @CurrentUser() user: IJwtPayload | undefined) {
    await this.forecasts.setTarget(
      dto.countryCode,
      dto.year,
      dto.quarter,
      dto.metric,
      dto.targetValue,
      dto.currencyCode ?? null,
      user?.sub ?? null,
      dto.note ?? null,
    );
    return { ok: true };
  }

  // ---- alerts and settings -------------------------------------------------

  @Get('alerts')
  @SystemRoute('ADMIN_CONSOLE', 'Platform operator alerts; growth_alerts is platform-annotated and invisible to tenants.')
  listAlerts(@Query() query: AlertQueryDto) {
    return this.alerts.list({ acknowledged: query.acknowledged, limit: query.limit ?? 50 });
  }

  @Post('alerts/:id/acknowledge')
  @SystemRoute('ADMIN_CONSOLE', 'An operator acknowledges a platform alert.')
  async acknowledge(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: IJwtPayload | undefined) {
    await this.alerts.acknowledge(id, user?.sub ?? null);
    return { ok: true };
  }

  /**
   * Every business number the growth module obeys, with its schema, its bounds,
   * whether it is still at its default and whether it is an OPEN BUSINESS
   * DECISION. The dashboard renders `humanDecision: true` differently on
   * purpose — those are the numbers somebody still has to own.
   */
  @Get('settings')
  @SystemRoute('ADMIN_CONSOLE', 'Platform growth configuration; growth_settings has no family_id column.')
  listSettings() {
    return this.settings.listAll();
  }

  @Post('settings')
  @SystemRoute('ADMIN_CONSOLE', 'An admin edits a growth setting; the value is validated against its schema before it is stored.')
  async setSetting(@Body() dto: SetSettingDto, @CurrentUser() user: IJwtPayload | undefined) {
    await this.settings.set(dto.key, dto.value, user?.sub ?? null);
    return { ok: true };
  }
}
