import { Module } from '@nestjs/common';

import { OperatorsModule } from '../operators/operators.module';
import { SafetyReviewService } from './application/services/safety-review.service';
import { SafetyOperationsController } from './presentation/controllers/safety-operations.controller';

/**
 * SPRINT F2 — THE SAFETY DESK, AND WHY IT IS NOT IN `ai-core`.
 *
 * It started there, because `ai_alerts` is written by `ai-core`'s distress
 * escalation. `ai-boundary.spec.ts` rejected it, and the rejection was right:
 * that suite forbids raw SQL anywhere in the AI module, because a raw statement
 * is a hole straight through the read allow-list that keeps the AI a DATA
 * PRODUCT rather than a privileged client.
 *
 * The safety desk is not the AI. It is an OPERATIONS surface that happens to
 * read a table the AI writes — it takes no model decision, calls no provider,
 * and its cross-tenant reads are exactly the thing the AI must never have. So
 * it lives in its own module, the AI boundary stays intact, and the guard did
 * its job rather than being given an exemption.
 *
 * It imports `OperatorsModule` because a safety action is taken by a NAMED
 * member of staff. This module and `OperatorAuthController` are the only two
 * consumers of `OperatorAuthGuard` today.
 */
@Module({
  imports: [OperatorsModule],
  controllers: [SafetyOperationsController],
  providers: [SafetyReviewService],
  exports: [SafetyReviewService],
})
export class SafetyModule {}
