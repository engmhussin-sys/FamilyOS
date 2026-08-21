import { Module } from '@nestjs/common';

import { AiCoreModule } from '../ai-core/ai-core.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { SystemDiagnosticsController } from './presentation/controllers/system-diagnostics.controller';
import { AccountsConsoleController } from './presentation/controllers/accounts-console.controller';
import { AccountsConsoleService } from './application/accounts-console.service';
import { MigrationStatusService } from './application/migration-status.service';
import { ReadinessCheckService } from './application/readiness-check.service';

@Module({
  imports: [AiCoreModule, FeatureFlagsModule],
  controllers: [SystemDiagnosticsController, AccountsConsoleController],
  providers: [ReadinessCheckService, MigrationStatusService, AccountsConsoleService],
})
export class SystemDiagnosticsModule {}
