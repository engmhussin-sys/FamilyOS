import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaRewardsRepository } from '../../infrastructure/repositories/prisma-rewards.repository';
import { IRewardRule } from '../../domain/rewards.types';
import { RULE_MAX_PER_FAMILY, isRuleEventType } from '../../../../shared/rewards/reward-rule-catalogue';
import { CreateRewardRuleDto, UpdateRewardRuleDto } from '../dto/reward-rule.dto';

/**
 * B4 (PA-B-015) — THE CREATION AND MANAGEMENT PATH `RewardRule` NEVER HAD.
 *
 * WHAT THIS IS NOT. It is not a reward engine. It writes rows and reads rows;
 * it never grants, never touches `rewards_ledger_entries`, never composes an
 * idempotency key and never emits an event. Granting stays where it has always
 * been — `RewardsEngineService.processTriggerEvent`, one implementation, called
 * by every domain. There is no `HabitRewardService`, no `QuranRewardService`
 * and no `LearningRewardService`, because a domain that needed one would be a
 * domain the central engine cannot express, and B4 extended the central engine
 * instead (event-type matching, verification floors, business-day caps).
 *
 * WHAT IT ADDS ON TOP OF THE REPOSITORY, and why a service exists at all:
 *
 *   - CATEGORY VALIDATION AGAINST THE TABLE. `reward_program_categories` is a
 *     TABLE precisely so the client's list can grow by INSERT. Validating
 *     against the rows keeps that true; validating against a TypeScript union
 *     would have quietly turned it back into an enum.
 *   - DUPLICATE DETECTION WITH A READABLE ARABIC ERROR. The database has the
 *     final word (`reward_rules_active_scope_uniq`), but a 500 from a unique
 *     violation is not an answer a parent can act on.
 *   - A CAP ON HOW MANY RULES A FAMILY MAY HOLD. Every rule is evaluated on
 *     every completion for its engine; the count is the evaluation cost.
 *   - REFUSING TO TOUCH THE PLATFORM TIER. A platform rule has `family_id IS
 *     NULL`, is visible to everyone, and is therefore not a thing one family
 *     may edit or delete. Every write here is scoped to a family-owned row.
 */
@Injectable()
export class RewardRuleService {
  constructor(private readonly repository: PrismaRewardsRepository) {}

  /** The category catalogue a parent picks from — straight out of the table. */
  async listCategories(): Promise<Array<{ code: string; labelAr: string; streakKind: string; sortOrder: number }>> {
    return this.repository.listRewardCategories();
  }

  /**
   * Everything in force for this family: its own rules AND the platform
   * defaults it inherits, each labelled with which tier it came from and
   * whether it is currently being applied.
   *
   * `isInEffect` is computed with the SAME `selectApplicableRules` precedence
   * the grant path uses, not re-derived here — a parent screen that disagreed
   * with the engine about which rules are live would be worse than no screen.
   */
  async listForFamily(familyId: string): Promise<
    Array<IRewardRule & { tier: 'FAMILY' | 'PLATFORM'; isInEffect: boolean }>
  > {
    const rules = await this.repository.listRewardRulesForFamily(familyId);
    const ownedEngines = new Set(rules.filter((r) => r.familyId !== null).map((r) => r.triggerEngine));

    return rules.map((rule) => {
      const tier: 'FAMILY' | 'PLATFORM' = rule.familyId === null ? 'PLATFORM' : 'FAMILY';
      const shadowed = tier === 'PLATFORM' && ownedEngines.has(rule.triggerEngine);
      return { ...rule, tier, isInEffect: rule.isActive && !shadowed };
    });
  }

  async create(familyId: string, userId: string, dto: CreateRewardRuleDto): Promise<IRewardRule> {
    // Belt to the DTO's braces: the DTO validates against the same constant,
    // but this method is also reachable from a future internal caller.
    if (!isRuleEventType(dto.eventType)) {
      throw new BadRequestException({
        code: 'UNKNOWN_RULE_EVENT_TYPE',
        messageAr: 'نوع الحدث غير معروف. اختر حدثًا من القائمة المتاحة.',
      });
    }

    const category = await this.resolveCategory(dto.category ?? null);
    const condition = dto.triggerCondition ?? {};

    const existingCount = await this.repository.countFamilyRewardRules(familyId);
    if (existingCount >= RULE_MAX_PER_FAMILY) {
      throw new ConflictException({
        code: 'RULE_LIMIT_REACHED',
        messageAr: `وصلت إلى الحد الأقصى لعدد قواعد المكافآت (${RULE_MAX_PER_FAMILY}). عطّل قاعدة قديمة أولًا.`,
      });
    }

    const duplicate = (await this.repository.listRewardRulesForFamily(familyId)).find(
      (rule) =>
        rule.familyId === familyId &&
        rule.isActive &&
        rule.triggerEngine === dto.triggerEngine &&
        rule.eventType === dto.eventType &&
        rule.rewardType === dto.rewardType &&
        JSON.stringify(rule.triggerCondition) === JSON.stringify(condition),
    );
    if (duplicate) {
      throw new ConflictException({
        code: 'RULE_ALREADY_EXISTS',
        messageAr: 'لديك قاعدة فعّالة بنفس الشروط ونفس نوع المكافأة. عدّل القاعدة الحالية بدل إنشاء أخرى.',
      });
    }

    return this.repository.createRewardRule(familyId, userId, {
      triggerEngine: dto.triggerEngine,
      eventType: dto.eventType,
      triggerCondition: condition,
      rewardType: dto.rewardType as IRewardRule['rewardType'],
      rewardAmountOrBadgeId: String(dto.amount),
      maxPerDay: dto.maxPerDay ?? null,
      maxPerWeek: dto.maxPerWeek ?? null,
      minVerifiedBy: dto.minVerifiedBy ?? null,
      category,
      labelAr: dto.labelAr ?? null,
      isActive: true,
    });
  }

  async update(familyId: string, ruleId: string, dto: UpdateRewardRuleDto): Promise<IRewardRule> {
    await this.getFamilyRuleOrThrow(familyId, ruleId);
    const category = dto.category === undefined ? undefined : await this.resolveCategory(dto.category);

    return this.repository.updateRewardRule(ruleId, {
      ...(dto.amount !== undefined ? { rewardAmountOrBadgeId: String(dto.amount) } : {}),
      ...(dto.maxPerDay !== undefined ? { maxPerDay: dto.maxPerDay } : {}),
      ...(dto.maxPerWeek !== undefined ? { maxPerWeek: dto.maxPerWeek } : {}),
      ...(dto.minVerifiedBy !== undefined ? { minVerifiedBy: dto.minVerifiedBy } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(dto.labelAr !== undefined ? { labelAr: dto.labelAr } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    });
  }

  /**
   * DEACTIVATE. The rule stops paying and the family KEEPS ownership of the
   * engine, so the platform defaults stay suppressed — "pay nothing for
   * habits" is a real thing a parent may want, and this is how they say it.
   * The row survives because every ledger entry it ever paid records
   * `source = 'reward_rule:<id>'`, and deleting the row would orphan that
   * audit trail.
   */
  async deactivate(familyId: string, ruleId: string): Promise<void> {
    await this.getFamilyRuleOrThrow(familyId, ruleId);
    await this.repository.deactivateRewardRule(ruleId);
  }

  /**
   * REMOVE — the route back to the platform defaults, and the reason it is a
   * separate verb from deactivation. When this was the family's last rule for
   * an engine, the engine reverts to the seeded defaults on the very next
   * completion, with no per-family backfill, because those defaults were never
   * copied anywhere in the first place.
   */
  async remove(familyId: string, ruleId: string): Promise<void> {
    await this.getFamilyRuleOrThrow(familyId, ruleId);
    await this.repository.deleteRewardRule(ruleId);
  }

  /** 404, never 403 — the same anti-enumeration answer every other id-taking
   * route in this codebase gives for a resource outside the caller's tenant
   * (F2 / BA-016). A platform rule answers 404 here too: it is not the
   * family's to edit. */
  private async getFamilyRuleOrThrow(familyId: string, ruleId: string): Promise<IRewardRule> {
    const rule = await this.repository.findFamilyRewardRule(familyId, ruleId);
    if (!rule) {
      throw new NotFoundException({ code: 'REWARD_RULE_NOT_FOUND', messageAr: 'قاعدة المكافأة غير موجودة.' });
    }
    return rule;
  }

  /** Validated against the TABLE. `null` is allowed — a rule without a
   * category is uncategorised, not invalid. */
  private async resolveCategory(code: string | null): Promise<string | null> {
    if (!code) return null;
    const categories = await this.repository.listRewardCategories();
    if (!categories.some((c) => c.code === code)) {
      throw new BadRequestException({
        code: 'UNKNOWN_REWARD_CATEGORY',
        messageAr: 'التصنيف غير معروف. اختر تصنيفًا من القائمة المتاحة.',
      });
    }
    return code;
  }
}
