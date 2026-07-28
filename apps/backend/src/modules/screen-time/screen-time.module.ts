import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { ScreenTimeController } from './presentation/controllers/screen-time.controller';
import { ScreenTimeService } from './application/services/screen-time.service';
import { PrismaScreenTimePolicyRepository } from './infrastructure/repositories/prisma-screen-time-policy.repository';
import { SCREEN_TIME_POLICY_REPOSITORY } from './application/ports/screen-time.repository.port';

@Module({
  imports: [ChildrenModule],
  controllers: [ScreenTimeController],
  providers: [
    ScreenTimeService,
    { provide: SCREEN_TIME_POLICY_REPOSITORY, useClass: PrismaScreenTimePolicyRepository },
  ],
  // Exported so other modules — starting with AiAssistantModule, which
  // needs the child's current policy to ground its prompts — can read
  // screen time data without duplicating this module's logic.
  exports: [ScreenTimeService],
})
export class ScreenTimeModule {}
