import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

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

  @Post('subscribe')
  subscribe(@Body() dto: SubscribeDto, @CurrentUser() user: IJwtPayload) {
    return this.subscriptionService.subscribe(user.familyId!, dto.planTier, dto.provider);
  }

  @Post('cancel')
  async cancel(@CurrentUser() user: IJwtPayload): Promise<void> {
    await this.subscriptionService.cancel(user.familyId!);
  }

  @Get('history')
  getBillingHistory(@CurrentUser() user: IJwtPayload) {
    return this.subscriptionService.getBillingHistory(user.familyId!);
  }
}
