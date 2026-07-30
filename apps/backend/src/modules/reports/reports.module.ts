import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { ScreenTimeModule } from '../screen-time/screen-time.module';
import { PairingModule } from '../pairing/pairing.module';
import { AiCoreModule } from '../ai-core/ai-core.module';
import { ReportsController } from './presentation/controllers/reports.controller';
import { ReportsService } from './application/reports.service';

@Module({
  imports: [ChildrenModule, ScreenTimeModule, PairingModule, AiCoreModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
