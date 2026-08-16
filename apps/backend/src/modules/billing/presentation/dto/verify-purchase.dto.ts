import { IsIn, IsString, Length } from 'class-validator';

import type { PaymentProviderValue } from '../../domain/billing.types';

/**
 * PHASE D — LOOK AT WHAT IS NOT IN THIS CLASS.
 *
 * No `amount`. No `currency`. No `planTier`. No `expiresAt`. No `status`. No
 * `familyId`. Not because they are validated away — because they have no field
 * to arrive in.
 *
 * «The client's claim of "payment successful" is never trusted» is not a check
 * somewhere downstream; it is the SHAPE of this DTO. A client can hand the
 * server an opaque provider token and name which provider issued it, and that
 * is the entire extent of its influence. Everything the system then believes
 * about the purchase comes back from Apple or Google over an authenticated
 * channel, or from our own price catalogue.
 *
 * `familyId` in particular is absent by rule, not by omission: CONTEXT.md
 * principle 3 forbids a client-supplied tenant, and `scripts/ci/
 * assert-tenant-scoping.ts` RULE 3 fails the build for any DTO that declares
 * one. The tenant is derived from the JWT — and then re-derived from the
 * provider's own account reference, which is what actually decides.
 */
export class VerifyPurchaseDto {
  @IsIn(['APPLE_IAP', 'GOOGLE_PLAY', 'PAYMOB', 'FAWRY', 'MOYASAR', 'MANUAL', 'STRIPE'])
  provider!: PaymentProviderValue;

  /**
   * The provider's opaque proof of purchase.
   *
   * Apple: the compact `JWSTransaction` from `Transaction.jwsRepresentation`,
   * or a bare `transactionId`. Google: the `purchaseToken` from the Play
   * Billing library. Gateway: the merchant reference WE issued at checkout.
   *
   * Bounded at 8 KB. A StoreKit JWS with its three-certificate `x5c` chain
   * runs to a few kilobytes; anything materially larger is not a receipt, and
   * an unbounded string reaching a cryptographic verifier is a denial-of-
   * service surface.
   */
  @IsString()
  @Length(1, 8192)
  providerToken!: string;
}
