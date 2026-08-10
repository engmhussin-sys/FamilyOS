import { Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { ScreenTimeService } from '../../../screen-time/application/services/screen-time.service';
import { DigitalWellbeingEngineService } from '../../../life-intelligence/application/services/digital-wellbeing-engine.service';
import { ConsentService } from './consent.service';
import type { IChildDataExport } from '../../domain/compliance.types';

/**
 * Deliberately composes existing services rather than querying Prisma
 * directly. The alternative (a raw multi-table Prisma query) would be
 * fewer lines, but it would duplicate the ownership-check logic that
 * already lives in ChildrenService, and it would need its own mocking
 * strategy in tests instead of reusing the same mocked ports as every
 * other module. This is a case where "compose existing services" is both
 * the DRY-er and the more testable choice, not just the "more layered"
 * one for its own sake.
 */
@Injectable()
export class DataExportService {
  constructor(
    private readonly childrenService: ChildrenService,
    private readonly screenTimeService: ScreenTimeService,
    private readonly consentService: ConsentService,
    private readonly digitalWellbeing: DigitalWellbeingEngineService,
  ) {}

  async exportChildData(childId: string, familyId: string): Promise<IChildDataExport> {
    const child = await this.childrenService.getChildOrThrow(childId, familyId);
    const [policy, consents, wellbeing] = await Promise.all([
      this.screenTimeService.getPolicy(childId, familyId),
      this.consentService.listConsents(childId, familyId),
      // CLOSES A REAL GAP (proactive compliance review): this data
      // subject's Digital Wellbeing history had no representation in
      // their own export until now.
      this.digitalWellbeing.getBehavioralSnapshotSummary(childId, familyId),
    ]);

    return {
      exportedAt: new Date(),
      child: {
        id: child.id,
        firstName: child.firstName,
        lastName: child.lastName,
        dateOfBirth: child.dateOfBirth,
        gender: child.gender,
        isActive: child.isActive,
        createdAt: child.createdAt,
      },
      activeScreenTimePolicy: policy
        ? {
            dailyLimitMinutes: policy.dailyLimitMinutes,
            bedtimeStart: policy.bedtimeStart,
            bedtimeEnd: policy.bedtimeEnd,
            focusModeEnabled: policy.focusModeEnabled,
          }
        : null,
      consents: consents.map((c) => ({
        consentType: c.consentType,
        granted: c.granted,
        grantedAt: c.grantedAt,
        revokedAt: c.revokedAt,
      })),
      digitalWellbeing: wellbeing,
    };
  }
}
