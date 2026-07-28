import { Inject, Injectable } from '@nestjs/common';
import type { ParentalConsent } from '@prisma/client';

import { ChildrenService } from '../../../children/application/services/children.service';
import type { ConsentTypeValue } from '../../domain/compliance.types';
import {
  CONSENT_REPOSITORY,
  type IConsentRepository,
} from '../ports/consent.repository.port';

@Injectable()
export class ConsentService {
  constructor(
    private readonly childrenService: ChildrenService,
    @Inject(CONSENT_REPOSITORY) private readonly consentRepository: IConsentRepository,
  ) {}

  async listConsents(childId: string, familyId: string): Promise<ParentalConsent[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.consentRepository.findManyByChild(childId);
  }

  async setConsent(
    childId: string,
    familyId: string,
    grantedByUserId: string,
    consentType: ConsentTypeValue,
    granted: boolean,
  ): Promise<ParentalConsent> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.consentRepository.upsert(childId, consentType, granted, grantedByUserId);
  }
}
