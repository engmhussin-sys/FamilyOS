import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentCoachService } from '../../application/services/parent-coach.service';
import { AiBudgetService } from '../../infrastructure/ai-budget.service';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

/**
 * B8 — THE PARENT'S AI COACH TAB — `/api/v1/ai-coach/*`.
 *
 * GUARDS, per the pattern F1 established and B1–B5 kept: `@UseGuards(
 * JwtAuthGuard)` PER ROUTE, never a class-level guard, and never stacked with a
 * device guard. `JwtAuthGuard` is the `'jwt'` Passport strategy; a child's
 * device token is issued for `'device-jwt'`, so "a child cannot read the
 * parent's coach" is a property of the strategy rather than a role check
 * someone can forget to write.
 *
 * `familyId` COMES FROM THE TOKEN, NEVER THE PATH (CONTEXT §3 principle 3).
 * `childId` is a path parameter, but it is only ever used as an ARGUMENT to
 * `ChildrenService.getChildOrThrow(childId, familyId)` inside the signal
 * repository — another family's child id yields a 404, not their data.
 *
 * ERRORS FOLLOW B3'S GLOBAL CONTRACT with no per-route work: every throw below
 * this line reaches `GlobalExceptionFilter`, which supplies `code`, `messageAr`,
 * `requestId` and `correlationId`. There is no `try/catch` in this file
 * shaping an error body by hand, which is exactly what B3 made unnecessary.
 *
 * THROTTLES ARE DELIBERATELY TIERED. `summary` and `progress` may reach a
 * provider and are throttled like the existing `/ai-assistant/ask`; the three
 * purely-deterministic routes are not billed and are throttled only against
 * abuse.
 *
 * WHAT IS NOT HERE, AND WHY: there is no route on this controller that creates,
 * accepts, approves or grants anything. Reward-program advisory drafts already
 * have their door — `GET /reward-programs/suggestions/:childId` and
 * `POST /reward-programs/suggestions/:childId/accept` (F4/B4) — and that accept
 * re-derives the draft server-side under the parent's own session. Adding a
 * second, coach-flavoured accept path here would have created exactly the
 * bypass that whole design exists to prevent.
 */
@Controller('ai-coach')
export class ParentCoachController {
  constructor(
    private readonly coach: ParentCoachService,
    private readonly budget: AiBudgetService,
  ) {}

  /** The whole tab in one call: headline insight, secondary insights, activities. */
  @Get('parent/:childId/summary')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  summary(@Param('childId', ParseUUIDPipe) childId: string, @CurrentUser() user: IJwtPayload) {
    return this.coach.summary(childId, user.familyId!);
  }

  /** «اشرح لي تقدّم طفلي» */
  @Get('parent/:childId/progress')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  progress(@Param('childId', ParseUUIDPipe) childId: string, @CurrentUser() user: IJwtPayload) {
    return this.coach.explainProgress(childId, user.familyId!);
  }

  /** «ما الخطوة التالية؟» — deterministic, never billed. */
  @Get('parent/:childId/next-steps')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  nextSteps(@Param('childId', ParseUUIDPipe) childId: string, @CurrentUser() user: IJwtPayload) {
    return this.coach.nextSteps(childId, user.familyId!);
  }

  /** «اقترح أنشطة» — deterministic, never billed. */
  @Get('parent/:childId/activities')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  activities(@Param('childId', ParseUUIDPipe) childId: string, @CurrentUser() user: IJwtPayload) {
    return this.coach.activities(childId, user.familyId!);
  }

  /** «كيف تعمل قواعد المكافآت؟» — read off the shared reward tables, never a
   * model's recollection of how this product works. */
  @Get('parent/:childId/reward-rules')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  rewardRules(@Param('childId', ParseUUIDPipe) childId: string, @CurrentUser() user: IJwtPayload) {
    return this.coach.explainRewardRules(childId, user.familyId!);
  }

  /**
   * §12's transparency requirement, made concrete: the family's own AI spend
   * this month against their own cap. Scoped by the tenant extension to the
   * caller's family — this is NOT the platform-wide roll-up, which lives on
   * `GET /ai-core/usage-summary` behind `InternalAdminGuard` and stays there.
   */
  @Get('budget')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  budgetStatus() {
    return this.budget.status();
  }
}
