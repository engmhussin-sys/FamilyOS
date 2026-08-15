import { Module } from '@nestjs/common';

import { FamilyMembershipService } from './application/services/family-membership.service';
import { FamiliesController } from './presentation/controllers/families.controller';

/**
 * PHASE C. The family-membership surface: who is in this family, who owns it,
 * and who may remove whom. It exists because A4's adversarial-parent scenario
 * has no answer without it — before this module there was no way to see the
 * other parent, no way to remove one, and no way to hand the family over, so
 * "OWNER" was a role nobody could ever gain, lose, or exercise.
 *
 * `AuditService` comes from the @Global `AuditModule`; `PrismaService` from the
 * @Global `PrismaModule`. Nothing else is imported, which keeps this module a
 * leaf and stops it becoming the place where cross-module authorization logic
 * accumulates.
 */
@Module({
  controllers: [FamiliesController],
  providers: [FamilyMembershipService],
  exports: [FamilyMembershipService],
})
export class FamiliesModule {}
