import { BadRequestException, Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { ScreenTimePolicy } from '@prisma/client';

import { ChildrenService } from '../../../children/application/services/children.service';
import type { IAppBlockRule, ICreateAppBlockRuleInput, ISetScreenTimePolicyInput } from '../../domain/screen-time.types';
import {
  APP_BLOCK_RULE_REPOSITORY,
  SCREEN_TIME_POLICY_REPOSITORY,
  type IAppBlockRuleRepository,
  type IScreenTimePolicyRepository,
} from '../ports/screen-time.repository.port';
import { AuditService } from '../../../audit/application/audit.service';

@Injectable()
export class ScreenTimeService {
  constructor(
    private readonly childrenService: ChildrenService,
    @Inject(SCREEN_TIME_POLICY_REPOSITORY)
    private readonly policyRepository: IScreenTimePolicyRepository,
    @Inject(APP_BLOCK_RULE_REPOSITORY)
    private readonly appBlockRuleRepository: IAppBlockRuleRepository,
    private readonly auditService: AuditService,
  ) {}

  async getPolicy(childId: string, familyId: string): Promise<ScreenTimePolicy | null> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.policyRepository.findActiveByChild(childId);
  }

  /**
   * Replaces the child's active policy: the previous one (if any) is
   * soft-deleted, not overwritten in place, so a history of policy
   * changes survives — the AI Parenting Assistant (Phase 2) will want to
   * answer "what changed and when" for questions like "my son's screen
   * time went up last month, why?"
   */
  async setPolicy(
    childId: string,
    familyId: string,
    createdByUserId: string,
    input: ISetScreenTimePolicyInput,
  ): Promise<ScreenTimePolicy> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const existing = await this.policyRepository.findActiveByChild(childId);
    if (existing) {
      await this.policyRepository.deactivate(existing.id);
    }

    const created = await this.policyRepository.create(childId, createdByUserId, input);

    await this.auditService.record({
      actorType: 'USER',
      actorUserId: createdByUserId,
      action: 'screenTime.policy.changed',
      entityType: 'Child',
      entityId: childId,
      metadata: { previousPolicyId: existing?.id ?? null, newPolicyId: created.id },
    });

    return created;
  }

  /**
   * CLOSES A REAL GAP: `AppBlockRule` has existed in the schema since
   * Sprint 4 with no service ever built for it —
   * `PairingOrchestratorService.getPolicySync()`'s own docstring
   * explicitly flagged `blockedPackages` as always `[]` for exactly
   * this reason. This is that service, following ScreenTimePolicy's
   * own pattern in this same file exactly, including audit logging
   * (an app-block rule is just as parental-control-relevant as a
   * screen-time policy change — the same reasoning ScreenTimePolicy
   * itself uses for why it's audited applies here unchanged).
   */
  async createAppBlockRule(
    childId: string,
    familyId: string,
    createdByUserId: string,
    input: ICreateAppBlockRuleInput,
  ): Promise<IAppBlockRule> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    // Real business rule, not just a DTO nicety: a rule must target
    // EITHER a specific package OR a whole category, never both
    // (ambiguous — which one wins at enforcement time?) and never
    // neither (a rule that blocks nothing is not a rule).
    const hasPackage = Boolean(input.packageName);
    const hasCategory = Boolean(input.category);
    if (hasPackage === hasCategory) {
      throw new BadRequestException('Exactly one of packageName or category must be set, not both or neither');
    }
    if (input.ruleType === 'TIME_LIMIT' && !input.limitMinutes) {
      throw new BadRequestException('limitMinutes is required when ruleType is TIME_LIMIT');
    }

    const created = await this.appBlockRuleRepository.create(childId, createdByUserId, input);

    await this.auditService.record({
      actorType: 'USER',
      actorUserId: createdByUserId,
      action: 'screenTime.appBlockRule.created',
      entityType: 'Child',
      entityId: childId,
      metadata: { ruleId: created.id, ruleType: created.ruleType, target: created.packageName ?? created.category },
    });

    return created;
  }

  async listAppBlockRules(childId: string, familyId: string): Promise<IAppBlockRule[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.appBlockRuleRepository.listActiveByChild(childId);
  }

  async deactivateAppBlockRule(ruleId: string, childId: string, familyId: string, deactivatedByUserId: string): Promise<void> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const rule = await this.appBlockRuleRepository.findById(ruleId);
    if (!rule || rule.childId !== childId) {
      // Same ownership discipline as every other module: non-existence
      // and ownership-mismatch fail identically, never leaking which.
      throw new NotFoundException('App block rule not found');
    }

    await this.appBlockRuleRepository.deactivate(ruleId);

    await this.auditService.record({
      actorType: 'USER',
      actorUserId: deactivatedByUserId,
      action: 'screenTime.appBlockRule.deactivated',
      entityType: 'Child',
      entityId: childId,
      metadata: { ruleId },
    });
  }

  /** The exact list `PairingOrchestratorService.getPolicySync()` needs
   * to stop hardcoding `[]` — package names only (categories are
   * resolved to their member packages on-device by the Child App's
   * own PolicyCacheService, not here, matching this module's existing
   * "Pairing triggers Screen Time, does not own its logic" boundary). */
  async getBlockedPackageNames(childId: string): Promise<string[]> {
    const rules = await this.appBlockRuleRepository.listActiveByChild(childId);
    return rules.filter((r) => r.ruleType === 'BLOCK' && r.packageName).map((r) => r.packageName as string);
  }
}
