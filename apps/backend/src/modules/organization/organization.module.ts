import { Module } from '@nestjs/common';

import { OrganizationController } from './presentation/controllers/organization.controller';
import { OrganizationService } from './application/services/organization.service';
import { RbacEngineService } from './application/services/rbac-engine.service';
import { PolicyEngineService } from './application/services/policy-engine.service';
import { CampaignRedemptionService } from './application/services/campaign-redemption.service';
import { PrismaOrganizationRepository } from './infrastructure/repositories/prisma-organization.repository';
import { ORGANIZATION_REPOSITORY } from './application/ports/organization.repository.port';
import { RBAC_ENGINE } from './application/ports/rbac-engine.port';
import { POLICY_ENGINE } from './application/ports/policy-engine.port';
import { BillingModule } from '../billing/billing.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Sprint B1 — CLOSES A REAL GAP: this module did not exist at all
 * before this (only contracts did, per Sprint 9's own explicit
 * "architecture and interfaces, not full implementation" scope).
 * Standalone (zero imports) — the Organization surface is
 * deliberately independent of Family/Children/Billing for this first
 * pass, per Sprint 9's own "does not replace anything, additive
 * only" principle.
 */
@Module({
  imports: [BillingModule, AuditModule, AuthModule],
  controllers: [OrganizationController],
  providers: [
    OrganizationService,
    RbacEngineService,
    PolicyEngineService,
    CampaignRedemptionService,
    { provide: ORGANIZATION_REPOSITORY, useClass: PrismaOrganizationRepository },
    { provide: RBAC_ENGINE, useExisting: RbacEngineService },
    { provide: POLICY_ENGINE, useExisting: PolicyEngineService },
  ],
  exports: [ORGANIZATION_REPOSITORY, RBAC_ENGINE, POLICY_ENGINE],
})
export class OrganizationModule {}
