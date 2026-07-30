import { Module } from '@nestjs/common';

import { FeatureFlagsController } from './presentation/controllers/feature-flags.controller';
import { FeatureFlagService } from './application/feature-flag.service';
import { PrismaFeatureFlagRepository } from './infrastructure/prisma-feature-flag.repository';
import { FEATURE_FLAG_REPOSITORY } from './domain/feature-flag.repository.port';

@Module({
  controllers: [FeatureFlagsController],
  providers: [
    FeatureFlagService,
    { provide: FEATURE_FLAG_REPOSITORY, useClass: PrismaFeatureFlagRepository },
  ],
  exports: [FeatureFlagService],
})
export class FeatureFlagsModule {}
