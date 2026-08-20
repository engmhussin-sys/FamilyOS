import { Inject, Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { ScreenTimeService } from '../../../screen-time/application/services/screen-time.service';
import { DigitalWellbeingEngineService } from '../../../life-intelligence/application/services/digital-wellbeing-engine.service';
import { ConsentService } from './consent.service';
import { CHILD_EXPORT_REPOSITORY, type IChildExportRepository } from '../ports/child-export.repository.port';
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
 *
 * WHAT THIS EXPORT WAS, AND WHY IT NEEDED A REPOSITORY OF ITS OWN.
 *
 * It shipped as identity + ONE screen-time policy + consents + a wellbeing
 * average, and was called a subject-access export. Absent from it: every
 * message the child had ever been sent, their entire rewards ledger, their
 * habit / health / learning history, and any acknowledgement that location
 * data is held about them at all. The field selection was clean; the coverage
 * was not — the gap was never a leak, it was an absence.
 *
 * Those categories have no existing service method to compose. There is no
 * «list this child's whole reward ledger» read anywhere in `src/`, and adding
 * one to `life-intelligence` would put a compliance-shaped query in a module
 * with no compliance reason to change and scatter this export's field
 * selection across six modules. `CHILD_EXPORT_REPOSITORY` keeps it in one file
 * a privacy review can read start to finish. The three services above are
 * still composed, unchanged, for the parts they already own.
 *
 * TWO CONSTRAINTS OUTRANK COMPLETENESS HERE, and both are enforced in that
 * repository rather than asked for in a comment: every read names its columns
 * (no raw model ever reaches the response), and every enumerated category is
 * capped and reports its true total, so a family with years of history cannot
 * turn this GET into an out-of-memory incident. Location is summarised rather
 * than listed — see `IExportedLocationSummary` for why that is a privacy
 * decision before it is a size one.
 *
 * WHOSE EXPORT THIS IS. The controller is `@ParentSurface()`: this is a parent
 * exercising a child's right of access, not the child reading their own file.
 * That is why the identity of the PARENT who wrote a message is not in it — a
 * third party's identity is not the child's personal data — while the message
 * itself, which is a fact about the child, is.
 */
@Injectable()
export class DataExportService {
  constructor(
    private readonly childrenService: ChildrenService,
    private readonly screenTimeService: ScreenTimeService,
    private readonly consentService: ConsentService,
    private readonly digitalWellbeing: DigitalWellbeingEngineService,
    @Inject(CHILD_EXPORT_REPOSITORY)
    private readonly records: IChildExportRepository,
  ) {}

  async exportChildData(childId: string, familyId: string): Promise<IChildDataExport> {
    const child = await this.childrenService.getChildOrThrow(childId, familyId);
    const [policy, consents, wellbeing, records] = await Promise.all([
      this.screenTimeService.getPolicy(childId, familyId),
      this.consentService.listConsents(childId, familyId),
      // CLOSES A REAL GAP (proactive compliance review): this data
      // subject's Digital Wellbeing history had no representation in
      // their own export until now.
      this.digitalWellbeing.getBehavioralSnapshotSummary(childId, familyId),
      // Runs only AFTER `getChildOrThrow` above has proved the child belongs
      // to this family — the ownership check stays the first thing that
      // happens, exactly as it did when this export was four fields.
      this.records.loadRecords(childId),
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
      records,
    };
  }
}
