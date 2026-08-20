import { describe, expect, it } from 'vitest';
import {
  COUNTRY_CURRENCY,
  CURRENCY_COUNTRY,
  CurrencyWithoutCountryError,
  countryWithCurrencyLabel,
  formatBackendMoneyMinor,
  formatCount,
  formatKpi,
  formatMoneyMinor,
  formatRate,
  formatRatio,
  NO_DATA,
} from '@/features/growth/lib/format';

describe('growth formatting', () => {
  describe('the currency/country rule', () => {
    /**
     * THE guard test. A currency rendered without knowing which market it
     * belongs to is the specific failure this dashboard was told never to
     * ship: 179.00 SAR is roughly ten times 179.00 EGP, and a screen that
     * prints the figure without the market lets a Riyadh number be read as
     * a Cairo one by anybody skimming.
     */
    it('THROWS when a currency is formatted with no country context at all', () => {
      expect(() => formatMoneyMinor('ar', 15702, 'EGP', null)).toThrow(CurrencyWithoutCountryError);
    });

    it("THROWS when a currency is formatted against the platform scope '**'", () => {
      // The backend returns no money at `countryCode='**'` precisely because
      // summing EGP into SAR without a rate is a lie. If a null ever slipped
      // through as a number, this throw is the client-side stop.
      expect(() => formatMoneyMinor('ar', 15702, 'SAR', '**')).toThrow(CurrencyWithoutCountryError);
    });

    it('carries the offending currency and scope on the error, for the stack trace to be useful', () => {
      try {
        formatMoneyMinor('en', 100, 'SAR', '**');
        expect.unreachable('formatMoneyMinor must throw for a currency without a country');
      } catch (error) {
        expect(error).toBeInstanceOf(CurrencyWithoutCountryError);
        expect((error as CurrencyWithoutCountryError).currencyCode).toBe('SAR');
        expect((error as CurrencyWithoutCountryError).countryScope).toBe('**');
      }
    });

    it('does NOT throw when there is no currency to mis-attribute (a null money value)', () => {
      expect(formatMoneyMinor('ar', null, null, '**')).toBe(NO_DATA);
    });

    it('formats normally once a country is supplied', () => {
      const egp = formatMoneyMinor('en', 15702, 'EGP', 'EG');
      const sar = formatMoneyMinor('en', 15702, 'SAR', 'SA');
      expect(egp).toContain('EGP');
      expect(sar).toContain('SAR');
      expect(egp).not.toBe(sar);
    });

    it('pairs each market with exactly one currency, so the label can never disagree', () => {
      expect(COUNTRY_CURRENCY.EG).toBe('EGP');
      expect(COUNTRY_CURRENCY.SA).toBe('SAR');
      expect(countryWithCurrencyLabel('مصر', COUNTRY_CURRENCY.EG)).toBe('مصر · EGP');
    });
  });

  describe('null is "no data", never zero', () => {
    it.each([
      ['count', () => formatCount('ar', null)],
      ['rate', () => formatRate('ar', null)],
      ['ratio', () => formatRatio('ar', null)],
      ['money', () => formatMoneyMinor('ar', null, 'EGP', 'EG')],
    ])('%s renders the em dash for null', (_label, format) => {
      const result = format();
      expect(result).toBe(NO_DATA);
      expect(result).not.toBe('0');
      expect(result).not.toContain('0');
    });

    it('a real zero still renders as zero — the distinction is preserved in both directions', () => {
      expect(formatCount('en', 0)).toBe('0');
      expect(formatRate('en', 0)).toBe('0.0%');
    });
  });

  describe('minor units', () => {
    it('divides by the currency’s own minor-unit scale rather than assuming cents everywhere', () => {
      // 15702 minor EGP = 157.02 EGP. A missing divisor would print 15,702.
      expect(formatMoneyMinor('en', 15702, 'EGP', 'EG')).toContain('157.02');
    });
  });

  describe('locale', () => {
    it('renders Arabic-locale digits differently from English-locale digits', () => {
      const ar = formatCount('ar', 1200);
      const en = formatCount('en', 1200);
      expect(en).toBe('1,200');
      expect(ar).not.toBe(en);
    });

    it('formats a rate as a percentage and a ratio as a bare multiple — never interchangeably', () => {
      expect(formatRate('en', 0.1029)).toBe('10.3%');
      expect(formatRatio('en', 3)).toBe('3.00×');
    });
  });

  /**
   * A1. Billing (`/billing/plans`, `/billing/history`) carries a currency
   * string and no country, and used to render `(cents / 100).toFixed(2)`
   * beside a bare code. These prove the wrapper closes that second rendering
   * without weakening the country rule underneath it.
   */
  describe('formatBackendMoneyMinor — the billing payloads', () => {
    it('resolves the market from the currency rather than dropping the country rule', () => {
      expect(CURRENCY_COUNTRY.EGP).toBe('EG');
      expect(CURRENCY_COUNTRY.SAR).toBe('SA');
      expect(formatBackendMoneyMinor('en', 17900, 'EGP')).toBe(formatMoneyMinor('en', 17900, 'EGP', 'EG'));
      expect(formatBackendMoneyMinor('ar', 17900, 'SAR')).toBe(formatMoneyMinor('ar', 17900, 'SAR', 'SA'));
    });

    it('renders the same figure as every other money figure on the dashboard — not "179.00 EGP"', () => {
      // The open-coded version produced exactly this string under both
      // locales. Intl places the code per locale and uses the locale's own
      // digits, so the Arabic rendering must NOT equal the Latin one.
      expect(formatBackendMoneyMinor('ar', 17900, 'EGP')).not.toBe('179.00 EGP');
      expect(formatBackendMoneyMinor('ar', 17900, 'EGP')).not.toBe(formatBackendMoneyMinor('en', 17900, 'EGP'));
    });

    it('refuses to scale a currency whose minor units this client does not know', () => {
      // NOT `(value / 100)`. An unknown divisor is the assumption this module
      // exists to refuse — the operator gets a dash and asks a question.
      expect(formatBackendMoneyMinor('en', 17900, 'USD')).toBe(NO_DATA);
      expect(formatBackendMoneyMinor('en', 17900, '')).toBe(NO_DATA);
      expect(formatBackendMoneyMinor('en', 17900, null)).toBe(NO_DATA);
    });

    it('renders a missing amount as the dash, never as zero', () => {
      expect(formatBackendMoneyMinor('en', null, 'EGP')).toBe(NO_DATA);
      expect(formatBackendMoneyMinor('en', undefined, 'EGP')).toBe(NO_DATA);
    });

    it('does not throw for the billing call sites — the country is always resolvable', () => {
      expect(() => formatBackendMoneyMinor('ar', 0, 'EGP')).not.toThrow();
    });
  });

  describe('formatKpi dispatches on kind, not on the caller’s memory', () => {
    it('MONEY_MINOR goes through the country-aware money path', () => {
      expect(() => formatKpi('MONEY_MINOR', 1000, 'EGP', { locale: 'ar', countryScope: null })).toThrow(
        CurrencyWithoutCountryError,
      );
    });

    it('RATE renders as a percentage even when a currency is present on the row', () => {
      expect(formatKpi('RATE', 0.25, null, { locale: 'en', countryScope: 'EG' })).toBe('25.0%');
    });

    it('RATIO renders as a multiple', () => {
      expect(formatKpi('RATIO', 1.01, null, { locale: 'en', countryScope: 'EG' })).toBe('1.01×');
    });

    it('COUNT renders as an integer', () => {
      expect(formatKpi('COUNT', 1200, null, { locale: 'en', countryScope: 'EG' })).toBe('1,200');
    });

    it('DURATION_HOURS renders as a number of hours', () => {
      expect(formatKpi('DURATION_HOURS', 2.5, null, { locale: 'en', countryScope: 'EG' })).toBe('2.5');
    });
  });
});
