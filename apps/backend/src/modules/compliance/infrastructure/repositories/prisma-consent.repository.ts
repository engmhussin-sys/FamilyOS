import { Injectable } from '@nestjs/common';
import type { ParentalConsent } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { ConsentTypeValue } from '../../domain/compliance.types';
import type { IConsentRepository } from '../../application/ports/consent.repository.port';

@Injectable()
export class PrismaConsentRepository implements IConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  findManyByChild(childId: string): Promise<ParentalConsent[]> {
    return this.prisma.parentalConsent.findMany({
      where: { childId },
      orderBy: { consentType: 'asc' },
    });
  }

  upsert(
    childId: string,
    consentType: ConsentTypeValue,
    granted: boolean,
    grantedByUserId: string,
  ): Promise<ParentalConsent> {
    const now = new Date();
    return this.prisma.parentalConsent.upsert({
      where: { childId_consentType: { childId, consentType } },
      create: {
        childId,
        consentType,
        granted,
        grantedByUserId,
        grantedAt: now,
        revokedAt: granted ? null : now,
      },
      update: {
        granted,
        grantedByUserId,
        grantedAt: granted ? now : undefined,
        revokedAt: granted ? null : now,
      },
    });
  }
}
