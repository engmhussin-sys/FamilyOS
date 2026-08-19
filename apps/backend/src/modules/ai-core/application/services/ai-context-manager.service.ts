import { Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { ScreenTimeService } from '../../../screen-time/application/services/screen-time.service';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import type { IChildAIContext } from '../../domain/ai-context.types';

/**
 * Builds the structured context every AI engine grounds its requests in
 * (Decision-068's Layer 1 "إدارة Context"). Moved here, unchanged in
 * logic, from what was originally AiAssistantService's private
 * buildChildContext method — now a shared, independently testable
 * service instead of logic embedded in one feature.
 *
 * ============ «HOW OLD IS THIS CHILD?» HAS ONE ANSWER, AND THIS ASKS IT =====
 *
 * This was the LAST caller of `common/utils/age.ts` (`calculateAge`), the third
 * of three age implementations in this codebase. It read the CONTAINER'S clock
 * — `new Date()` interpreted in whatever zone the deploy host happens to run in
 * — so a Cairo or Riyadh household served from a European staging host could be
 * told its child is a year younger on the child's own birthday, and the AI
 * context every engine grounds its answers in is precisely where that lands in
 * front of a parent.
 *
 * It now asks `FamilyDateService.ageInYears`, the same call
 * `PrismaCoachSignalRepository` makes, which resolves the FAMILY'S timezone and
 * delegates to `businessAgeInYears` — the one home for this question.
 * `common/utils/age.ts` and its suite are deleted with this change.
 */
@Injectable()
export class AiContextManagerService {
  constructor(
    private readonly childrenService: ChildrenService,
    private readonly screenTimeService: ScreenTimeService,
    private readonly familyDate: FamilyDateService,
  ) {}

  /** `now` is injectable for the same reason it is on `CoachSignals.build`: a
   *  birthday boundary can only be asserted against a frozen clock. */
  async buildChildContext(childId: string, familyId: string, now: Date = new Date()): Promise<IChildAIContext> {
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
      ageYears: await this.familyDate.ageInYears(familyId, child.dateOfBirth, now),
      screenTime: {
        dailyLimitMinutes: policy?.dailyLimitMinutes ?? null,
        focusModeEnabled: policy?.focusModeEnabled ?? false,
      },
    };
  }
}
