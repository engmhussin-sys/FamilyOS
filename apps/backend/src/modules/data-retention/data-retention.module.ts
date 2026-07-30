import { Module } from '@nestjs/common';

import { DataRetentionController } from './presentation/controllers/data-retention.controller';
import { DataRetentionPolicyService } from './domain/data-retention-policy.service';
import { DataRetentionEnforcementService } from './application/data-retention-enforcement.service';

@Module({
  controllers: [DataRetentionController],
  providers: [DataRetentionPolicyService, DataRetentionEnforcementService],
  exports: [DataRetentionPolicyService, DataRetentionEnforcementService],
})
export class DataRetentionModule {}
