import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsIn, IsInt, IsString, Length, Max, MaxLength, Min } from 'class-validator';

import { ENTITLEMENT_KEYS, type EntitlementKey, type SubscriptionPlanTier } from '../../domain/billing.types';
import { OperatorGrantService } from '../../application/services/operator-grant.service';

/**
 * THE TIERS AN OPERATOR MAY COMP. `FREE` is deliberately absent: granting the
 * free tier is not a grant, it is what a household already has, and offering it
 * as an option only invites someone to "downgrade" with a tool that cannot
 * downgrade — the way to end a comp is to revoke it.
 */
const GRANTABLE_TIERS: readonly SubscriptionPlanTier[] = ['BASIC', 'PREMIUM', 'FAMILY', 'ENTERPRISE'];

export class OperatorGrantDto {
  /**
   * NOT a `familyId`, and that is a rule rather than a preference: CI RULE 3
   * (`scripts/ci/assert-tenant-scoping.ts`) fails the build for any request DTO
   * that carries one. The household is resolved from this email server-side.
   */
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsIn(GRANTABLE_TIERS as string[], {
    message: `planTier must be one of: ${GRANTABLE_TIERS.join(', ')}.`,
  })
  planTier!: SubscriptionPlanTier;

  /**
   * REQUIRED, AND BOUNDED. `EntitlementService.grantManual` accepts an
   * open-ended grant (`validUntil: null`); this surface will not offer one. A
   * comp with no end date is a household that quietly stops being a customer
   * and is noticed by nobody.
   */
  @IsInt()
  @Min(1)
  @Max(OperatorGrantService.MAX_DAYS)
  days!: number;

  /**
   * REQUIRED, because the audit row is the point. "Why does this household have
   * PREMIUM without a payment" has to be answerable months later, and a nullable
   * reason is a reason nobody writes.
   */
  @IsString()
  @Length(3, 200)
  reason!: string;
}

export class OperatorRevokeDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Length(3, 200)
  reason!: string;
}

/**
 * GRANT EXPLICIT FEATURES — for the case `OperatorGrantDto` cannot serve: a
 * database whose `plan_definitions` table is empty, which is every database
 * built from this repository's migrations, because nothing seeds it.
 *
 * The keys are validated against `ENTITLEMENT_KEYS`, the same closed
 * vocabulary the type is derived from, so a typo is a 400 naming the six valid
 * keys rather than a grant of a feature nothing will ever read.
 */
export class OperatorGrantFeaturesDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ENTITLEMENT_KEYS.length)
  @IsIn(ENTITLEMENT_KEYS as unknown as string[], {
    each: true,
    message: `Each feature must be one of: ${ENTITLEMENT_KEYS.join(', ')}.`,
  })
  features!: EntitlementKey[];

  /**
   * Recorded on every row because `entitlements.plan_tier` is not nullable and
   * a grant should say which tier it stood in for. It decides nothing:
   * `hasFeature` reads the feature rows, not this.
   */
  @IsIn(GRANTABLE_TIERS as string[], {
    message: `planTier must be one of: ${GRANTABLE_TIERS.join(', ')}.`,
  })
  planTier!: SubscriptionPlanTier;

  @IsInt()
  @Min(1)
  @Max(OperatorGrantService.MAX_DAYS)
  days!: number;

  @IsString()
  @Length(3, 200)
  reason!: string;
}
