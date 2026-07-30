import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { RecommendationEngineService } from '../../application/services/recommendation-engine.service';
import { BehavioralIntelligenceEngineService } from '../../application/services/behavioral-intelligence-engine.service';
import { MemoryEngineService } from '../../application/services/memory-engine.service';
import { ChildrenService } from '../../../children/application/services/children.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

@Controller('ai-core')
export class AiPlatformController {
  constructor(
    private readonly recommendationEngine: RecommendationEngineService,
    private readonly behavioralEngine: BehavioralIntelligenceEngineService,
    private readonly memoryEngine: MemoryEngineService,
    private readonly childrenService: ChildrenService,
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

  /** Sprint 8 — AI Decision History. Child-ownership-checked via
   * ChildrenService.getChildOrThrow (this project's established pattern
   * for every child-scoped read), not device-ownership — decision
   * history spans devices over the child's lifetime. */
  @Get('decision-history/:childId')
  @UseGuards(JwtAuthGuard)
  async getDecisionHistory(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    await this.childrenService.getChildOrThrow(childId, user.familyId!);
    return this.memoryEngine.getDecisionHistory(childId);
  }

  /** Sprint 8 — Family Insights. Composes the Recommendation and
   * Behavioral engines into one response \u2014 deliberately NOT a new
   * engine of its own; this endpoint is a read-side composition, same
   * as KnowledgeEngineService already is one layer down. */
  @Get('insights/:childId')
  @UseGuards(JwtAuthGuard)
  async getInsights(
    @Param('childId') childId: string,
    @Query('deviceId') deviceId: string,
    @CurrentUser() user: IJwtPayload,
  ) {
    const [recommendation, behavioralTrend] = await Promise.all([
      this.recommendationEngine.recommend(childId, user.familyId!, deviceId),
      this.behavioralEngine.computeTrend(deviceId, childId, user.familyId!),
    ]);
    return { recommendation, behavioralTrend };
  }
}
