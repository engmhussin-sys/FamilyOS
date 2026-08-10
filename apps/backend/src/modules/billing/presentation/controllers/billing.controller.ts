import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { PlanService } from '../../application/services/plan.service';
import { SubscriptionService } from '../../application/services/subscription.service';
import { TrialManager } from '../../application/services/trial-manager.service';
import { SubscribeDto } from '../dto/subscribe.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

@Controller('billing')
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(
    private readonly planService: PlanService,
    private readonly subscriptionService: SubscriptionService,
    private readonly trialManager: TrialManager,
  ) {}

  @Get('plans')
  listPlans() {
    return this.planService.listActivePlans();
  }

  @Get('subscription')
  async getSubscription(@CurrentUser() user: IJwtPayload) {
    const [subscription, isInTrial, trialDaysRemaining] = await Promise.all([
      this.subscriptionService.getForFamily(user.familyId!),
      this.trialManager.isInTrial(user.familyId!),
      this.trialManager.trialDaysRemaining(user.familyId!),
    ]);
    return { subscription, isInTrial, trialDaysRemaining };
  }

  @Post('trial/start')
  startTrial(@CurrentUser() user: IJwtPayload) {
    return this.subscriptionService.startTrial(user.familyId!);
  }

  /**
   * CLOSING A KNOWN GAP (documented since Sprint 10's SECURITY_REVIEW.md
   * and repeated in every subsequent readiness report): this endpoint
   * had no endpoint-specific rate limit, unlike auth's login/register.
   * The `MANUAL` payment adapter always succeeds, so an unthrottled
   * loop here could churn subscription state indefinitely. Same
   * @Throttle pattern already used for auth \u2014 5/min is generous for a
   * real user retrying a failed card, tight enough to block scripted abuse.
   */
  @Post('subscribe')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  subscribe(@Body() dto: SubscribeDto, @CurrentUser() user: IJwtPayload) {
    return this.subscriptionService.subscribe(user.familyId!, dto.planTier, dto.provider, user.sub);
  }

  @Post('cancel')
  async cancel(@CurrentUser() user: IJwtPayload): Promise<void> {
    await this.subscriptionService.cancel(user.familyId!, user.sub);
  }

  @Get('history')
  getBillingHistory(@CurrentUser() user: IJwtPayload) {
    return this.subscriptionService.getBillingHistory(user.familyId!);
  }
}
