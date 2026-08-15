import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { EventCollectorService } from '../../application/event-collector.service';
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

@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly eventCollector: EventCollectorService,
    private readonly dashboardMetrics: DashboardMetricsService,
  ) {}

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
