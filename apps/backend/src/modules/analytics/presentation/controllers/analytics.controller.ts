import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { EventCollectorService } from '../../application/event-collector.service';
import { GrowthEventEmitter } from '../../application/growth-event-emitter.service';
import { DashboardMetricsService } from '../../application/dashboard-metrics.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface, PlatformAdminSurface } from '../../../../common/authz/roles.decorator';

class TrackEventDto {
  sessionId!: string;
  eventName!: string;
  payload?: Record<string, unknown>;
}

/**
 * PHASE D (GROWTH). The ONLY growth event a client may originate, because it
 * is the only one that happens before the server knows anything at all — there
 * is no account, no family and no token when an app is first launched.
 *
 * Every other growth event describes a fact the SERVER wrote (a payment, a
 * reward, a family), and accepting a client's word for any of them would let a
 * device manufacture conversions and referral credit. That rule is not a
 * convention here: `CLIENT_INGESTIBLE_GROWTH_EVENTS` in `domain/growth-events.ts`
 * contains exactly one name, and this is the only route that reads it.
 */
class AppInstalledDto {
  /** The anonymous session id. The ONLY join to a later registration. */
  @IsString()
  @MaxLength(100)
  sessionId!: string;

  @IsOptional() @IsString() @MaxLength(20) platform?: string;
  @IsOptional() @IsString() @MaxLength(2) countryCode?: string;
  @IsOptional() @IsString() @MaxLength(20) appVersion?: string;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
  @IsOptional() @IsString() @MaxLength(120) source?: string;
  @IsOptional() @IsString() @MaxLength(120) campaign?: string;
  @IsOptional() @IsString() @MaxLength(60) medium?: string;
  @IsOptional() @IsString() @MaxLength(32) referralCode?: string;
}

@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly eventCollector: EventCollectorService,
    private readonly dashboardMetrics: DashboardMetricsService,
    private readonly growthEvents: GrowthEventEmitter,
  ) {}

  /**
   * PHASE D (GROWTH) — the INSTALL funnel step.
   *
   * PUBLIC, and it has to be: an install precedes every credential this system
   * could check. The controls are (a) a hard throttle, (b) a payload that
   * cannot name a family, a user or a child, and (c) the fact that the event
   * grants nothing — the worst an abuser achieves is inflating a chart they
   * cannot see. It writes to `analytics_events`, whose `family_id` is NULL for
   * exactly this case (PLATFORM_ANNOTATED — invisible to every tenant).
   */
  @Post('growth/install')
  @SystemRoute(
    'AUTH_BOOTSTRAP',
    'An app install happens before any account exists; there is nothing to authenticate and the row it writes carries no tenant.',
  )
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  async appInstalled(@Body() dto: AppInstalledDto): Promise<void> {
    await this.growthEvents.emit({
      name: 'APP_INSTALLED',
      familyId: null,
      sessionId: dto.sessionId,
      payload: {
        platform: dto.platform,
        countryCode: dto.countryCode,
        appVersion: dto.appVersion,
        locale: dto.locale,
        source: dto.source,
        campaign: dto.campaign,
        medium: dto.medium,
        referralCode: dto.referralCode,
      },
    });
  }

  @Post('track')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  async track(@Body() dto: TrackEventDto, @CurrentUser() user: IJwtPayload): Promise<void> {
    await this.eventCollector.track({
      familyId: user.familyId,
      userId: user.sub,
      sessionId: dto.sessionId,
      eventName: dto.eventName,
      payload: dto.payload,
    });
  }

  /** CLOSES A CRITICAL GAP (proactive business audit): was reachable
   * by ANY authenticated user before this — see InternalAdminGuard's
   * own docstring for the full finding. */
  @Get('dashboard-metrics')
  @PlatformAdminSurface()
  @SystemRoute('ADMIN_CONSOLE', 'Product-wide dashboard metrics; cross-tenant aggregation is the feature, behind InternalAdminGuard.')
  @UseGuards(InternalAdminGuard)
  getDashboardMetrics() {
    return this.dashboardMetrics.getMetrics();
  }
}
