import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { EntitlementService } from '../../application/services/entitlement.service';
import { PricingService } from '../../application/services/pricing.service';
import { PaymentVerificationService } from '../../application/services/payment-verification.service';
import { VerifyPurchaseDto } from '../dto/verify-purchase.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { OwnerOnly, ParentSurface } from '../../../../common/authz/roles.decorator';

/**
 * PHASE D — THE COMMERCIAL SURFACE.
 *
 * Three endpoints, and the interesting thing about all three is what they do
 * NOT accept:
 *
 *  - `GET /billing/catalogue/:countryCode` returns prices. It does not take a
 *    price. The client cannot propose what something costs.
 *  - `POST /billing/purchases/verify` takes an opaque provider token and
 *    NOTHING ELSE. No amount, no currency, no plan tier, no `familyId`. There
 *    is literally no field in `VerifyPurchaseDto` through which a client could
 *    assert what it paid or on whose behalf.
 *  - `GET /billing/entitlements` is the server's answer to «what am I allowed
 *    to do», which Q17 makes the single source of truth. The app asks; it
 *    never decides.
 *
 * `familyId` comes from the verified JWT via `@CurrentUser`, per CONTEXT.md
 * principle 3 — and even that is only a CANDIDATE: `PaymentVerificationService`
 * resolves the real owner from the provider's own account reference and
 * rejects a mismatch.
 */
@Controller('billing')
@UseGuards(JwtAuthGuard)
export class SubscriptionController {
  constructor(
    private readonly pricing: PricingService,
    private readonly entitlements: EntitlementService,
    private readonly verification: PaymentVerificationService,
  ) {}

  /** The markets this deployment sells in, with their VAT rates. */
  @Get('markets')
  @ParentSurface()
  listMarkets() {
    return this.pricing.listMarkets();
  }

  /**
   * The price list for one country, with VAT already broken out.
   *
   * COUNTRY/CURRENCY SEPARATION: the currency is not a parameter. It follows
   * from the country, out of the `countries` table. A caller cannot ask for
   * Egyptian prices denominated in SAR, because there is no way to express it.
   */
  @Get('catalogue/:countryCode')
  @ParentSurface()
  async catalogue(@Param('countryCode') countryCode: string) {
    const entries = await this.pricing.listCatalogue(countryCode);
    return entries.map(({ price, money }) => ({
      planTier: price.planTier,
      billingPeriod: price.billingPeriod,
      countryCode: price.countryCode,
      currency: money.currency,
      grossMinor: money.grossMinor,
      vatMinor: money.vatMinor,
      netMinor: money.netMinor,
      vatBasisPoints: money.vatBasisPoints,
      storeProductId: price.storeProductId,
    }));
  }

  /**
   * THE SINGLE SOURCE OF TRUTH FOR FEATURE ACCESS.
   *
   * Q17 specifies the shape: `{plan, status, features[], validUntil, source}`.
   * `source` names the purchase channel for the client's own copy and for
   * support; NO server-side access decision reads it.
   */
  @Get('entitlements')
  @ParentSurface()
  async entitlementsFor(@CurrentUser() user: IJwtPayload) {
    const described = await this.entitlements.describe(user.familyId!);
    return {
      planTier: described.planTier,
      features: described.features,
      validUntil: described.validUntil,
      source: described.source,
      // A short client-side cache TTL, as Q17 allows for offline use — with
      // the explicit rule that any sensitive operation re-checks. The number
      // is served BY the server so it can be shortened without an app release.
      cacheTtlSeconds: 300,
    };
  }

  /**
   * PHASE G — THE OPAQUE HOUSEHOLD REFERENCE THE CLIENT HANDS TO THE STORE.
   *
   * WHY THIS ENDPOINT HAD TO EXIST. `PaymentVerificationService.resolveTenant`
   * resolves the household from the reference the STORE echoes back — Play's
   * `obfuscatedExternalAccountId`, Apple's `appAccountToken` — and NOT from the
   * session. That is the cross-tenant defence. But it only works if the client
   * actually sets that field when it starts the purchase, and the client had no
   * way to obtain a value to set. Without it, `resolveTenant` falls back to the
   * session with a logged warning: a materially weaker binding, on every
   * purchase, silently.
   *
   * WHY IT IS THE FAMILY ID AND NOT AN HMAC. An HMAC of the family id under a
   * server secret would keep the internal identifier off the store — genuinely
   * nicer — and it would be a trap: rotating that secret orphans EVERY existing
   * store link, so every subsequent renewal arrives with a reference we no
   * longer recognise and resolves to nobody. The family id is a v4 UUID: not
   * guessable, not enumerable, stable for the lifetime of the household, and it
   * is exactly the shape Apple documents `appAccountToken` for. It is also not a
   * secret from THIS client, which is the only party that receives it.
   *
   * The value is returned to the caller's OWN family, derived from the verified
   * JWT. There is no parameter.
   */
  @Get('store-account-ref')
  @OwnerOnly()
  storeAccountRef(@CurrentUser() user: IJwtPayload) {
    return {
      accountRef: user.familyId!,
      // Play caps obfuscatedExternalAccountId at 64 characters; a UUID is 36.
      // Stated so a future change to this value is measured against the limit
      // rather than discovered by Play rejecting the purchase.
      maxLength: 64,
    };
  }

  /**
   * Verifies a store purchase the app has just completed.
   *
   * THE CLIENT'S CLAIM OF "PAYMENT SUCCESSFUL" IS NOT AN INPUT HERE. The body
   * carries a provider token; everything else is obtained from Apple or Google
   * over an authenticated channel. A 200 from this endpoint means the STORE
   * confirmed the purchase, not that the app said so.
   */
  @Post('purchases/verify')
  // Same reasoning as the Sprint 8 `subscribe` endpoint: money and entitlement
  // belong to the billing owner. A co-parent may read the catalogue and the
  // entitlements; committing the household to a purchase is the OWNER's.
  @OwnerOnly()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async verifyPurchase(@Body() dto: VerifyPurchaseDto, @CurrentUser() user: IJwtPayload) {
    const result = await this.verification.verifyAndApply({
      provider: dto.provider,
      providerToken: dto.providerToken,
      sessionFamilyId: user.familyId!,
      // Stores convert a price we set into the customer's storefront currency
      // and can land a minor unit away. Passed EXPLICITLY at the call site, as
      // `PricingService.assertAmountMatches` requires, rather than hidden in a
      // default that would silently also apply to gateways.
      amountToleranceMinor: 1,
    });
    return {
      verified: true,
      wasDuplicate: result.wasDuplicate,
      entitlementGranted: result.entitlementGranted,
      status: result.verified.status,
      validUntil: result.verified.expiresAt,
    };
  }
}
