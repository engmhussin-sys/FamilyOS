import { Module } from '@nestjs/common';

import { AiCoreModule } from '../ai-core/ai-core.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { SystemDiagnosticsController } from './presentation/controllers/system-diagnostics.controller';
import { MigrationStatusService } from './application/migration-status.service';
import { ReadinessCheckService } from './application/readiness-check.service';

@Module({
  imports: [AiCoreModule, FeatureFlagsModule],
  controllers: [SystemDiagnosticsController],
  providers: [ReadinessCheckService, MigrationStatusService],
})
export class SystemDiagnosticsModule {}
