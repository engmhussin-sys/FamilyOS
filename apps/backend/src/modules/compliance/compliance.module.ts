import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { ScreenTimeModule } from '../screen-time/screen-time.module';
import { LifeIntelligenceModule } from '../life-intelligence/life-intelligence.module';
import { ConsentController } from './presentation/controllers/consent.controller';
import { DataExportController } from './presentation/controllers/data-export.controller';
import { ConsentService } from './application/services/consent.service';
import { DataExportService } from './application/services/data-export.service';
import { PrismaConsentRepository } from './infrastructure/repositories/prisma-consent.repository';
import { CONSENT_REPOSITORY } from './application/ports/consent.repository.port';

@Module({
  imports: [ChildrenModule, ScreenTimeModule, LifeIntelligenceModule],
  controllers: [ConsentController, DataExportController],
  providers: [
    ConsentService,
    DataExportService,
    { provide: CONSENT_REPOSITORY, useClass: PrismaConsentRepository },
  ],
})
export class ComplianceModule {}
