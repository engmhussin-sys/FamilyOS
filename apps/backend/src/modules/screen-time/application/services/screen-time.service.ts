import { Injectable, Inject } from '@nestjs/common';
import type { ScreenTimePolicy } from '@prisma/client';

import { ChildrenService } from '../../../children/application/services/children.service';
import type { ISetScreenTimePolicyInput } from '../../domain/screen-time.types';
import {
  SCREEN_TIME_POLICY_REPOSITORY,
  type IScreenTimePolicyRepository,
} from '../ports/screen-time.repository.port';

@Injectable()
export class ScreenTimeService {
  constructor(
    private readonly childrenService: ChildrenService,
    @Inject(SCREEN_TIME_POLICY_REPOSITORY)
    private readonly policyRepository: IScreenTimePolicyRepository,
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

    return this.policyRepository.create(childId, createdByUserId, input);
  }
}
