import { Module } from '@nestjs/common';

import { AccountDeletionController } from './presentation/controllers/account-deletion.controller';
import { AccountDeletionService } from './application/services/account-deletion.service';
import { AuthModule } from '../auth/auth.module';
import { ChildrenModule } from '../children/children.module';
import { BillingModule } from '../billing/billing.module';

/**
 * CLOSES A REAL GAP (proactive business/code audit): a standalone
 * module, safe to import AuthModule/ChildrenModule/BillingModule
 * since none of them import this one back — no circular risk.
 */
@Module({
  imports: [AuthModule, ChildrenModule, BillingModule],
  controllers: [AccountDeletionController],
  providers: [AccountDeletionService],
})
export class AccountDeletionModule {}
