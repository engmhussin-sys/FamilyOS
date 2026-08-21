import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { ENTITLEMENT_KEYS, type EntitlementKey, type SubscriptionPlanTier } from '../../domain/billing.types';

/** Every tier the schema's enum knows, including FREE — which IS editable here. */
const TIERS: readonly SubscriptionPlanTier[] = ['FREE', 'BASIC', 'PREMIUM', 'FAMILY', 'ENTERPRISE'];

export class UpsertPlanDto {
  /**
   * FREE is offerable here and nowhere else in this codebase's operator
   * surfaces. Defining what the free tier includes is a real product decision —
   * it is the list every household gets without paying, and leaving it
   * undefined is what makes `hasFeature` answer false for everyone.
   */
  @IsIn(TIERS as string[], { message: `tier must be one of: ${TIERS.join(', ')}.` })
  tier!: SubscriptionPlanTier;

  @IsString()
  @Length(1, 80)
  name!: string;

  /**
   * IN THE SMALLEST UNIT OF THE CURRENCY, and named so. A field called `price`
   * holding 4999 is read as forty-nine ninety-nine by half the people who see
   * it and as 4,999 by the other half; `priceCents` cannot be.
   *
   * Zero is allowed — that is what FREE costs — and the ceiling is a typo
   * guard, not a pricing policy.
   */
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  priceCents!: number;

  /** ISO-4217, uppercase. EGP and SAR are this product's two markets. */
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a three-letter ISO-4217 code, e.g. EGP or SAR.' })
  currency!: string;

  @IsInt()
  @Min(1)
  @Max(36)
  billingIntervalMonths!: number;

  /**
   * The entitlement keys this tier grants — validated against the same closed
   * vocabulary `EntitlementService` reads. An empty array is permitted and
   * meaningful: a tier that grants nothing extra.
   */
  @IsArray()
  @ArrayMaxSize(ENTITLEMENT_KEYS.length)
  @IsIn(ENTITLEMENT_KEYS as unknown as string[], {
    each: true,
    message: `Each feature must be one of: ${ENTITLEMENT_KEYS.join(', ')}.`,
  })
  @Type(() => String)
  features!: EntitlementKey[];

  /**
   * An inactive tier stays in the catalogue and disappears from the customer
   * pricing list. It is how a plan is retired without deleting the row that
   * every existing subscription still points at — which is why there is no
   * delete on this surface at all.
   */
  @IsBoolean()
  isActive!: boolean;
}
