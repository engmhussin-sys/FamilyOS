import { Injectable, NotFoundException } from '@nestjs/common';

import { FamilyDateService } from '../../../../common/time/family-date.service';
import {
  buildLearningCatalogue,
  buildLearningCatalogueDomains,
  type LearningCatalogue,
  type LearningCatalogueDomainsOnly,
} from '../../domain/learning-catalogue';
import { ageInYears } from '../../domain/program-rules';
import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';

/**
 * THE ONE PIECE OF I/O THE CHILD CATALOGUE NEEDS: how old is this child?
 *
 * Everything else is `buildLearningCatalogue`, a pure function over that one
 * number. This service exists to resolve the age and nothing else, which is
 * why it has no `create`, no `update` and no method that takes a value from a
 * caller.
 *
 * THE CALENDAR IS THE FAMILY'S, deliberately. `RewardSuggestionService` states
 * the reason and it applies verbatim here: the age this catalogue annotates
 * with must be the same age `checkProgramEligibility` will compare against
 * `minAge` when the child actually starts something — otherwise a child could
 * be shown a domain as "مقترح لعمرك" on the day they turn eligible and then be
 * refused it, or the reverse. Both read `FamilyDateService.timeZoneOf`.
 */
@Injectable()
export class LearningCatalogueService {
  constructor(
    private readonly repo: PrismaRewardProgramRepository,
    private readonly familyDate: FamilyDateService,
  ) {}

  /**
   * `childId` and `familyId` come from the DEVICE in a verified token — see
   * `ChildCatalogueController`. This method has no overload that accepts them
   * from anywhere else.
   */
  async forChild(childId: string, familyId: string, now = new Date()): Promise<LearningCatalogue> {
    return buildLearningCatalogue(await this.ageOf(childId, familyId, now));
  }

  async domainsForChild(
    childId: string,
    familyId: string,
    now = new Date(),
  ): Promise<LearningCatalogueDomainsOnly> {
    return buildLearningCatalogueDomains(await this.ageOf(childId, familyId, now));
  }

  private async ageOf(childId: string, familyId: string, now: Date): Promise<number> {
    const child = await this.repo.findChild(childId);
    if (!child) {
      // B3 envelope. A paired device whose child row is gone is a real state
      // (deletion in flight), and the child's app must render a sentence.
      throw new NotFoundException({ code: 'CHILD_NOT_FOUND', messageAr: 'الطفل غير موجود.' });
    }
    return ageInYears(
      new Date(child.dateOfBirth as string | Date),
      now,
      await this.familyDate.timeZoneOf(familyId),
    );
  }
}
