import type { ParentalConsent } from '@prisma/client';
import type { ConsentTypeValue } from '../../domain/compliance.types';

export const CONSENT_REPOSITORY = Symbol('CONSENT_REPOSITORY');

export interface IConsentRepository {
  findManyByChild(childId: string): Promise<ParentalConsent[]>;
  /** Upsert semantics: the schema has @@unique([childId, consentType]) —
   * granting a consent type that already has a row updates it in place
   * (new grantedAt/revokedAt), it does not create a duplicate row. */
  upsert(
    childId: string,
    consentType: ConsentTypeValue,
    granted: boolean,
    grantedByUserId: string,
  ): Promise<ParentalConsent>;
}
