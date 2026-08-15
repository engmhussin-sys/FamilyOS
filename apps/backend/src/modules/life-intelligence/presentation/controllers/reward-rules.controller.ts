import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { RewardRuleService } from '../../application/services/reward-rule.service';
import { CreateRewardRuleDto, UpdateRewardRuleDto } from '../../application/dto/reward-rule.dto';
import {
  PLATFORM_DEFAULT_REWARD_RULES,
  RULE_ENGINES,
  RULE_EVENT_TYPES,
  MIN_VERIFIED_BY_VALUES,
} from '../../../../shared/rewards/reward-rule-catalogue';

/**
 * B4 (PA-B-015) — THE MISSING CONTROLLER.
 *
 * Phase A's finding was exact: "zero controller, zero seed, zero INSERT in the
 * migrations". This file is the zero-th of the three; migration 0007 is the
 * other two.
 *
 * A SEPARATE CONTROLLER, not more routes on `LifeIntelligenceController`. That
 * file is already 600+ lines across nine engines, and reward-rule management is
 * a coherent parent-facing resource with its own lifecycle. The module wiring
 * is identical, so nothing is duplicated by the split.
 *
 * GUARDS PER ROUTE, per the pattern F1 established and
 * `controller-guard-coverage.spec.ts` enforces on every handler in the
 * codebase. Every route here is `JwtAuthGuard` — PARENT ONLY.
 *
 * THERE IS DELIBERATELY NO `/self/*` ROUTE IN THIS FILE, and no
 * `DeviceJwtAuthGuard` anywhere in it. A child device that could write a
 * `RewardRule` could write itself a rule paying 1000 XP per habit tick — a
 * self-grant with extra steps. The separation is structural (two Passport
 * strategies, `jwt` vs `device-jwt`), not a role check that could be forgotten,
 * which is the same property PA-B-016 measured 45/45 on for F4.
 *
 * TENANCY: `familyId` comes from the verified JWT and never from the client
 * (CONTEXT §3 principle 3). No route here takes a `familyId` parameter at all,
 * so there is nothing to probe.
 */
@Controller('reward-rules')
export class RewardRulesController {
  constructor(private readonly rewardRules: RewardRuleService) {}

  /**
   * Everything a parent needs to author a rule without guessing: the engines,
   * the event types, the verification floors, the CATEGORY TABLE, and the
   * platform defaults themselves so the UI can show what a family currently
   * inherits before they change anything.
   */
  @Get('catalogue')
  @UseGuards(JwtAuthGuard)
  async catalogue() {
    return {
      engines: RULE_ENGINES,
      eventTypes: RULE_EVENT_TYPES,
      minVerifiedByValues: MIN_VERIFIED_BY_VALUES,
      // Read from `reward_program_categories`, a TABLE — so a category added by
      // an operator appears here with no deploy. This is the client's
      // "categories must stay configurable" requirement, kept honest.
      categories: await this.rewardRules.listCategories(),
      platformDefaults: PLATFORM_DEFAULT_REWARD_RULES,
    };
  }

  /** The family's own rules AND the platform defaults it inherits, each marked
   * `tier` and `isInEffect` using the engine's own precedence function. */
  @Get()
  @UseGuards(JwtAuthGuard)
  list(@CurrentUser() user: IJwtPayload) {
    return this.rewardRules.listForFamily(user.familyId!);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: CreateRewardRuleDto, @CurrentUser() user: IJwtPayload) {
    return this.rewardRules.create(user.familyId!, user.sub, dto);
  }

  @Patch(':ruleId')
  @UseGuards(JwtAuthGuard)
  update(@Param('ruleId') ruleId: string, @Body() dto: UpdateRewardRuleDto, @CurrentUser() user: IJwtPayload) {
    return this.rewardRules.update(user.familyId!, ruleId, dto);
  }

  /** Switch a rule OFF. The family keeps ownership of the engine, so the
   * platform defaults stay suppressed — see `selectApplicableRules`. */
  @Post(':ruleId/deactivate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async deactivate(@Param('ruleId') ruleId: string, @CurrentUser() user: IJwtPayload) {
    await this.rewardRules.deactivate(user.familyId!, ruleId);
  }

  /** REMOVE the rule entirely. When it was the last one this family owned for
   * its engine, the platform defaults take over again on the next completion. */
  @Delete(':ruleId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async remove(@Param('ruleId') ruleId: string, @CurrentUser() user: IJwtPayload) {
    await this.rewardRules.remove(user.familyId!, ruleId);
  }
}
