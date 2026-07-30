import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { EventCollectorService } from '../../application/event-collector.service';
import { DashboardMetricsService } from '../../application/dashboard-metrics.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

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

  @Get('dashboard-metrics')
  @UseGuards(JwtAuthGuard)
  getDashboardMetrics() {
    return this.dashboardMetrics.getMetrics();
  }
}
