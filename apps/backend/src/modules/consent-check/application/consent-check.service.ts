import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type { ConsentTypeValue } from '../../compliance/domain/compliance.types';

/**
 * Sprint 1 (Consent Enforcement, Option C) — CLOSES A REAL
 * ARCHITECTURAL GAP found while wiring enforcement: `ConsentService`
 * (compliance module) cannot safely be depended on by
 * `life-intelligence` — `ComplianceModule` already imports
 * `LifeIntelligenceModule` (for Data Export), so the reverse import
 * would create a circular module dependency and break NestJS's
 * bootstrap entirely.
 *
 * This is the fix: a deliberately minimal, standalone service —
 * ZERO dependencies beyond PrismaService (available everywhere) —
 * living at the bottom of the dependency tree so any module can
 * safely import it. It duplicates a small amount of read-only query
 * logic already in PrismaConsentRepository rather than depending on
 * that repository's module, which is the correct tradeoff here: a
 * few duplicated lines of a simple SELECT is far safer than a
 * circular module graph.
 */
@Injectable()
export class ConsentCheckService {
  constructor(private readonly prisma: PrismaService) {}

  async hasConsent(childId: string, consentType: ConsentTypeValue): Promise<boolean> {
    const record = await this.prisma.parentalConsent.findUnique({
      where: { childId_consentType: { childId, consentType } },
    });
    return record?.granted === true;
  }
}
