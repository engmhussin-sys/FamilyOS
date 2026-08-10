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

  /** Sprint 1 (Consent Enforcement, Option C \u2014 implicit-grant-at-
   * registration + explicit opt-out). CLOSES A REAL GAP: 6 consent
   * types have existed since an early sprint, and this service could
   * always read/write them \u2014 but zero engine anywhere ever CALLED
   * this before writing sensitive data. This is that missing check.
   *
   * Deliberately NOT family-scoped (no assertChildBelongsToFamily
   * call) \u2014 this is meant to be called from deep inside an engine
   * that already resolved childId through its OWN legitimate path
   * (e.g. a device's own resolved childId), not from a
   * parent-facing endpoint where ownership still needs checking.
   * Fail-closed: a child with NO row for this consentType at all
   * (never explicitly set) is treated as NOT consented \u2014 the
   * default-grant migration (Sprint 1) is what ensures every real
   * child actually has an explicit row, not this method assuming one. */
  async hasConsent(childId: string, consentType: ConsentTypeValue): Promise<boolean> {
    const consents = await this.consentRepository.findManyByChild(childId);
    const record = consents.find((c) => c.consentType === consentType);
    return record?.granted === true;
  }

  /** Sprint 1 (Consent Enforcement, Option C) — the "implicit grant at
   * registration" half. Called once, right after a child profile is
   * created (see the Parent App's AddChildScreen), granting the
   * baseline set of consent types explicitly rather than leaving
   * them unset. This is NOT silent/hidden consent — the registration
   * screen's own copy states plainly what continuing means, and
   * every type granted here remains individually revocable via
   * setConsent() at any time (the Manage Consents screen). Excludes
   * HEALTH_DATA and KEYBOARD_BEHAVIOR_ANALYSIS deliberately \u2014 health
   * data and (the still-unimplemented, contracts-only) keyboard
   * monitoring are sensitive enough to warrant their own explicit,
   * separate opt-in later rather than bundling into the baseline set. */
  async grantDefaults(childId: string, familyId: string, grantedByUserId: string): Promise<void> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const baselineTypes: ConsentTypeValue[] = ['DATA_COLLECTION', 'LOCATION_TRACKING', 'APP_USAGE_MONITORING', 'AI_BEHAVIOR_ANALYSIS'];
    await Promise.all(baselineTypes.map((type) => this.consentRepository.upsert(childId, type, true, grantedByUserId)));
  }
}
