import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { ScreenTimeController, AppBlockRuleController } from './presentation/controllers/screen-time.controller';
import { ScreenTimeService } from './application/services/screen-time.service';
import { PrismaScreenTimePolicyRepository } from './infrastructure/repositories/prisma-screen-time-policy.repository';
import { PrismaAppBlockRuleRepository } from './infrastructure/repositories/prisma-app-block-rule.repository';
import { PrismaScreenTimeBonusRepository } from './infrastructure/repositories/prisma-screen-time-bonus.repository';
import {
  SCREEN_TIME_POLICY_REPOSITORY,
  APP_BLOCK_RULE_REPOSITORY,
  SCREEN_TIME_BONUS_REPOSITORY,
} from './application/ports/screen-time.repository.port';

@Module({
  imports: [ChildrenModule],
  controllers: [ScreenTimeController, AppBlockRuleController],
  providers: [
    ScreenTimeService,
    { provide: SCREEN_TIME_POLICY_REPOSITORY, useClass: PrismaScreenTimePolicyRepository },
    { provide: APP_BLOCK_RULE_REPOSITORY, useClass: PrismaAppBlockRuleRepository },
    // F4: the READ side of screen-time rewards. The rewards engine writes the
    // grants; this module owns the question they answer.
    { provide: SCREEN_TIME_BONUS_REPOSITORY, useClass: PrismaScreenTimeBonusRepository },
  ],
  // Exported so other modules — AiAssistantModule (needs the child's
  // current policy) and PairingModule (needs getBlockedPackageNames
  // for getPolicySync, closing that module's own documented gap) —
  // can read screen time data without duplicating this module's logic.
  exports: [ScreenTimeService],
})
export class ScreenTimeModule {}
