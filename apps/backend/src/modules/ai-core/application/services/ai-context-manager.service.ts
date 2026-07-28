import { Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { ScreenTimeService } from '../../../screen-time/application/services/screen-time.service';
import { calculateAge } from '../../../../common/utils/age';
import type { IChildAIContext } from '../../domain/ai-context.types';

/**
 * Builds the structured context every AI engine grounds its requests in
 * (Decision-068's Layer 1 "إدارة Context"). Moved here, unchanged in
 * logic, from what was originally AiAssistantService's private
 * buildChildContext method — now a shared, independently testable
 * service instead of logic embedded in one feature.
 */
@Injectable()
export class AiContextManagerService {
  constructor(
    private readonly childrenService: ChildrenService,
    private readonly screenTimeService: ScreenTimeService,
  ) {}

  async buildChildContext(childId: string, familyId: string): Promise<IChildAIContext> {
    // Ownership check happens here and is allowed to throw
    // ChildNotFoundException directly — a 404, not an AI-availability
    // error. Callers (AiCoreOrchestratorService) must not swallow this
    // into a generic 503, same distinction the original
    // AiAssistantService made explicit.
    const child = await this.childrenService.getChildOrThrow(childId, familyId);
    const policy = await this.screenTimeService.getPolicy(childId, familyId);

    return {
      childId,
      firstName: child.firstName,
      ageYears: calculateAge(child.dateOfBirth),
      screenTime: {
        dailyLimitMinutes: policy?.dailyLimitMinutes ?? null,
        focusModeEnabled: policy?.focusModeEnabled ?? false,
      },
    };
  }
}
