import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { RecommendationEngineService } from '../../application/services/recommendation-engine.service';
import { BehavioralIntelligenceEngineService } from '../../application/services/behavioral-intelligence-engine.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

@Controller('ai-core')
export class AiPlatformController {
  constructor(
    private readonly recommendationEngine: RecommendationEngineService,
    private readonly behavioralEngine: BehavioralIntelligenceEngineService,
  ) {}

  @Get('recommendation/:childId')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  getRecommendation(
    @Param('childId') childId: string,
    @Query('deviceId') deviceId: string,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.recommendationEngine.recommend(childId, user.familyId!, deviceId);
  }

  @Get('behavioral-trend/:childId')
  @UseGuards(JwtAuthGuard)
  getBehavioralTrend(
    @Param('childId') childId: string,
    @Query('deviceId') deviceId: string,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.behavioralEngine.computeTrend(deviceId, childId, user.familyId!);
  }
}
