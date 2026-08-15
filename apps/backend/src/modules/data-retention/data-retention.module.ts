import { Module } from '@nestjs/common';

import { DataRetentionController } from './presentation/controllers/data-retention.controller';
import { DataRetentionPolicyService } from './domain/data-retention-policy.service';
import { DataRetentionEnforcementService } from './application/data-retention-enforcement.service';
import { EvidenceStorageModule } from '../rewards-engine/evidence-storage.module';

@Module({
  // B5 (PA-B-019): the retention sweep deletes the BYTES, so it needs the same
  // storage instance the upload path writes through — not a second one.
  imports: [EvidenceStorageModule],
  controllers: [DataRetentionController],
  providers: [DataRetentionPolicyService, DataRetentionEnforcementService],
  exports: [DataRetentionPolicyService, DataRetentionEnforcementService],
})
export class DataRetentionModule {}
