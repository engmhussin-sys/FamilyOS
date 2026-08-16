import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  PAYMENT_REPOSITORY,
  type ICountryConfig,
  type IPaymentRepository,
  type ISubscriptionPriceRecord,
} from '../ports/payment.repository.port';
import type { BillingPeriodValue } from '../ports/payment-provider.port';
import type { PaymentProviderValue, SubscriptionPlanTier } from '../../domain/billing.types';
import { amountsMatch, splitVat, type IMoneyBreakdown } from '../../domain/money';

/**
 * PHASE D — THE SINGLE SOURCE OF PRICE.
 *
 * «Prices are centrally configured, never hardcoded across the app.» This
 * service is what makes that structurally true rather than aspirational:
 *
 *  - the only readers of `subscription_prices` and `countries` are here;
 *  - `test/billing/price-centralisation.spec.ts` greps `src/` for currency
 *    literals and price-shaped numbers outside this module and fails on a hit;
 *  - a checkout amount is NEVER accepted from a request. `createCheckout`
 *    takes a `planTier` and a `billingPeriod`, and the amount is computed
 *    HERE, from the catalogue.
 *
 * ====================== COUNTRY / CURRENCY SEPARATION ======================
 *
 * A price is keyed on (tier, country, period), and the currency comes from the
 * COUNTRY, not from the request. An Egyptian family cannot be charged in SAR
 * by asking for it, and a Saudi family cannot be charged the Egyptian price by
 * sending `currency: "EGP"` — there is no field to send it in.
 *
 * ============================ VAT ============================
 *
 * The rate is a column on `countries` (14% EG / 15% SA, Q16), read here and
 * FROZEN onto the invoice and the payment transaction at the moment of
 * charging. A rate change alters future documents and never past ones.
 */
@Injectable()
export class PricingService {
  constructor(@Inject(PAYMENT_REPOSITORY) private readonly repository: IPaymentRepository) {}

  /** The countries this deployment sells in. Seeded by migration 0014. */
  listMarkets(): Promise<ICountryConfig[]> {
    return this.repository.listActiveCountries();
  }

  async getCountry(countryCode: string): Promise<ICountryConfig> {
    const country = await this.repository.findCountry(normaliseCountry(countryCode));
    if (!country) {
      throw new NotFoundException(`Country "${countryCode}" is not a configured market.`);
    }
    if (!country.isActive) {
      throw new BadRequestException(`Country "${countryCode}" is not currently open for sale.`);
    }
    return country;
  }

  /**
   * THE price lookup. Throws rather than falling back to a default: a missing
   * price row means the commercial decision has not been made for this market
   * (see `HUMAN DECISION REQUIRED #1`), and charging a guessed amount would be
   * strictly worse than refusing.
   */
  async resolvePrice(params: {
    planTier: SubscriptionPlanTier;
    countryCode: string;
    billingPeriod: BillingPeriodValue;
  }): Promise<{ price: ISubscriptionPriceRecord; country: ICountryConfig; money: IMoneyBreakdown }> {
    const country = await this.getCountry(params.countryCode);
    const price = await this.repository.findPrice({
      planTier: params.planTier,
      countryCode: country.code,
      billingPeriod: params.billingPeriod,
    });
    if (!price) {
      throw new NotFoundException(
        `No active price is configured for ${params.planTier} / ${country.code} / ${params.billingPeriod}. ` +
          'Prices are configuration, not code — see HUMAN DECISION REQUIRED #1 in PHASE-D-Payments-Report.md.',
      );
    }
    return { price, country, money: this.priceToMoney(price, country) };
  }

  /** The catalogue as a customer in one market would see it. */
  async listCatalogue(countryCode: string): Promise<
    Array<{ price: ISubscriptionPriceRecord; money: IMoneyBreakdown }>
  > {
    const country = await this.getCountry(countryCode);
    const prices = await this.repository.listPricesForCountry(country.code);
    return prices.map((price) => ({ price, money: this.priceToMoney(price, country) }));
  }

  /**
   * Maps a STORE product id back to our own catalogue.
   *
   * Needed because Apple and Google report what the customer bought as THEIR
   * product identifier (`com.abny.premium.monthly` / a base plan id), and the
   * entitlement must be derived from OUR tier — never from parsing the store's
   * string, which would make a renamed product a silent free upgrade.
   */
  async resolveByStoreProduct(storeProductId: string): Promise<{
    price: ISubscriptionPriceRecord;
    country: ICountryConfig;
    money: IMoneyBreakdown;
  } | null> {
    const price = await this.repository.findPriceByStoreProductId(storeProductId);
    if (!price) return null;
    const country = await this.repository.findCountry(price.countryCode);
    if (!country) return null;
    return { price, country, money: this.priceToMoney(price, country) };
  }

  /**
   * THE TAMPER CHECK, in one place so every provider gets the same one.
   *
   * Called with the amount and currency the PROVIDER reported, against the
   * price OUR catalogue holds. A mismatch in either is a rejection — not a
   * warning, not a log line, not a "take the smaller of the two".
   *
   * `toleranceMinor` exists for stores only, and the caller must pass it
   * explicitly: Apple and Google convert a price we set into the customer's
   * storefront currency and can land a minor unit away, while a gateway
   * charging an amount we computed ourselves cannot and gets 0.
   */
  assertAmountMatches(params: {
    expected: IMoneyBreakdown;
    reportedGrossMinor: number;
    reportedCurrency: string;
    toleranceMinor: number;
  }): void {
    const reportedCurrency = params.reportedCurrency.toUpperCase();
    if (reportedCurrency !== params.expected.currency) {
      throw new BadRequestException(
        `Currency mismatch: the catalogue prices this in ${params.expected.currency}, the payment reports ${reportedCurrency}.`,
      );
    }
    if (!amountsMatch(params.expected.grossMinor, params.reportedGrossMinor, params.toleranceMinor)) {
      throw new BadRequestException(
        `Amount mismatch: the catalogue prices this at ${params.expected.grossMinor} minor units, the payment reports ${params.reportedGrossMinor}.`,
      );
    }
  }

  /** Which provider a market defaults to. Data (a `countries` column), not code. */
  async defaultProviderFor(countryCode: string): Promise<PaymentProviderValue> {
    return (await this.getCountry(countryCode)).defaultProvider;
  }

  private priceToMoney(price: ISubscriptionPriceRecord, country: ICountryConfig): IMoneyBreakdown {
    return splitVat({
      amountMinor: price.amountMinor,
      // The rate comes from the COUNTRY, and the mode from the PRICE ROW —
      // which may legitimately differ from its country's default for a
      // zero-rated or specially-treated product.
      vatBasisPoints: country.vatBasisPoints,
      vatMode: price.vatMode,
      currency: price.currencyCode,
    });
  }
}

function normaliseCountry(countryCode: string): string {
  return countryCode.trim().toUpperCase();
}
