import { Module } from '@nestjs/common';

import { SupportController } from './presentation/controllers/support.controller';
import { SupportService } from './application/services/support.service';
import { PrismaSupportRequestRepository } from './infrastructure/repositories/prisma-support-request.repository';
import { SUPPORT_REQUEST_REPOSITORY } from './domain/support.types';
import { BillingModule } from '../billing/billing.module';

/**
 * Sprint 6 — Support. UPDATED (proactive business/code audit): no
 * longer fully standalone — imports BillingModule to check
 * priority_support entitlement at submission time. BillingModule
 * itself has zero imports (bottom of the dependency tree), so this
 * carries no circular-dependency risk.
 */
@Module({
  imports: [BillingModule],
  controllers: [SupportController],
  providers: [
    SupportService,
    { provide: SUPPORT_REQUEST_REPOSITORY, useClass: PrismaSupportRequestRepository },
  ],
})
export class SupportModule {}
