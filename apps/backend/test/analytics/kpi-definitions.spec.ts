/**
 * PHASE D (GROWTH) — EVERY KPI AGAINST A HAND-COMPUTED EXPECTED VALUE.
 *
 * Each `it` below states the arithmetic in its own title, so a reader can check
 * the expectation without running anything. That is the point: a KPI test that
 * asserts `expect(arpu(x, y)).toBe(f(x, y))` proves the code is
 * self-consistent and nothing else.
 *
 * The numbers are the launch markets' real ones wherever a real one exists —
 * `docs/12-Cost-Estimate.md` §10 puts Egyptian ARPU at $2.82 and Saudi at
 * $7.58, Egyptian churn at 6.0% and Saudi at 4.5%, and CAC at $3.50 / $12.00.
 * Using them means a change that breaks the unit-economics model breaks a test.
 */
import {
  KPI_DEFINITIONS,
  KPI_IDS,
  activationRate,
  arpu,
  arppu,
  arr,
  cac,
  churnRate,
  conversionRate,
  kpiValue,
  ltv,
  ltvToCac,
  medianHours,
  mrr,
  paybackMonths,
  rate,
  retention,
  stickiness,
  trialConversionRate,
} from '../../src/modules/analytics/domain/kpi-definitions';

describe('PHASE D (GROWTH) — the KPI definitions module', () => {
  describe('the catalogue itself', () => {
    it('defines every KPI the brief names, and each definition is complete', () => {
      const required = [
        'DAU', 'WAU', 'MAU',
        'ACTIVATION_RATE',
        'RETENTION_D1', 'RETENTION_D7', 'RETENTION_D30', 'RETENTION_D90',
        'CHURN_RATE', 'CONVERSION_RATE', 'TRIAL_CONVERSION_RATE',
        'ARPU', 'ARPPU', 'MRR', 'ARR', 'CAC', 'LTV',
      ];
      for (const id of required) expect(KPI_IDS).toContain(id);

      for (const id of KPI_IDS) {
        const d = KPI_DEFINITIONS[id];
        expect(d.id).toBe(id);
        expect(d.formula.length).toBeGreaterThan(10);
        expect(d.numerator.length).toBeGreaterThan(5);
        expect(d.source.length).toBeGreaterThan(5);
        // Every definition states the trap it avoids. A definition without one
        // is a definition nobody thought about.
        expect(d.note.length).toBeGreaterThan(40);
      }
    });

    it('gives every COUNT kpi a null denominator — a count divided by one is a lie', () => {
      for (const id of KPI_IDS) {
        const d = KPI_DEFINITIONS[id];
        if (d.kind === 'COUNT') expect(d.denominator).toBeNull();
        else if (d.kind === 'RATE' || d.kind === 'RATIO') expect(d.denominator).not.toBeNull();
      }
    });
  });

  describe('rate() — the one division every ratio goes through', () => {
    it('42 of 200 = 0.21', () => {
      expect(rate(42, 200)).toBe(0.21);
    });

    it('returns NULL for a zero denominator — "no data" is not "0%"', () => {
      expect(rate(0, 0)).toBeNull();
      expect(rate(5, 0)).toBeNull();
    });

    it('rounds to four places: 1 of 3 = 0.3333', () => {
      expect(rate(1, 3)).toBe(0.3333);
    });

    it('THROWS on a negative count rather than returning a plausible number', () => {
      expect(() => rate(-1, 10)).toThrow(RangeError);
      expect(() => rate(10, -1)).toThrow(RangeError);
    });
  });

  describe('DAU / WAU / MAU / stickiness', () => {
    it('DAU 1,200 over MAU 9,000 = 0.1333 stickiness', () => {
      expect(stickiness({ dau: 1_200, wau: 4_000, mau: 9_000 })).toBe(0.1333);
    });

    it('a product with no monthly actives has NULL stickiness, not 0', () => {
      expect(stickiness({ dau: 0, wau: 0, mau: 0 })).toBeNull();
    });
  });

  describe('activation and time-to-value', () => {
    it('310 activated of a 1,000-family cohort = 0.31', () => {
      expect(activationRate(310, 1_000)).toBe(0.31);
    });

    it('median of [30, 90, 120, 2880, 4320] minutes = 120 min = 2 hours', () => {
      expect(medianHours([30, 90, 120, 2_880, 4_320])).toBe(2);
    });

    it('median of an EVEN list averages the middle two: [60, 120, 180, 240] -> 150min = 2.5h', () => {
      expect(medianHours([60, 120, 180, 240])).toBe(2.5);
    });

    it('an unsorted input is sorted first — [4320, 30, 120] median is 120min = 2h', () => {
      expect(medianHours([4_320, 30, 120])).toBe(2);
    });

    it('no activations yet = NULL, not 0 hours', () => {
      expect(medianHours([])).toBeNull();
    });

    it('MEDIAN, NOT MEAN: one 90-day outlier does not move it', () => {
      const withOutlier = medianHours([30, 90, 120, 2_880, 129_600]);
      expect(withOutlier).toBe(2); // the mean would be ~442 hours
    });
  });

  describe('retention — one function, four horizons', () => {
    it('D1: 640 of a 1,000 cohort = 0.64', () => {
      expect(retention(640, 1_000)).toBe(0.64);
    });

    it('D7: 310 of 1,000 = 0.31', () => {
      expect(retention(310, 1_000)).toBe(0.31);
    });

    it('a cohort TOO YOUNG for the horizon returns NULL, not 0%', () => {
      // The query layer passes `null` when the cohort has not reached day N.
      // Returning 0 would render a two-week-old product as 0% D90 retention.
      expect(retention(null, 1_000)).toBeNull();
    });

    it('an empty cohort returns NULL', () => {
      expect(retention(0, 0)).toBeNull();
    });
  });

  describe('churn — and the denominator that makes it honest', () => {
    it('Egypt: 60 of a 1,000 start-of-month base = 0.06 (docs/12 §10.3)', () => {
      expect(churnRate(60, 1_000)).toBe(0.06);
    });

    it('Saudi: 45 of 1,000 = 0.045 (docs/12 §10.3)', () => {
      expect(churnRate(45, 1_000)).toBe(0.045);
    });

    it('THE DENOMINATOR IS THE START-OF-PERIOD BASE. 60 churned against a base of 1,000 is 6%; ' +
       'diluting it with 500 mid-period acquisitions would report 4% and hide a bad month', () => {
      const honest = churnRate(60, 1_000);
      const diluted = churnRate(60, 1_500);
      expect(honest).toBe(0.06);
      expect(diluted).toBe(0.04);
      // The function takes the base as a parameter, so the caller decides —
      // and `KpiService` passes subscriptions created BEFORE the period start.
      expect(honest).not.toBe(diluted);
    });
  });

  describe('conversion', () => {
    it('registration -> paid: 100 of 1,000 = 0.10, the rate docs/12 plans on', () => {
      expect(conversionRate(100, 1_000)).toBe(0.1);
    });

    it('trial -> paid counts RESOLVED trials only: 45 converted of 150 ended = 0.30', () => {
      expect(trialConversionRate(45, 150)).toBe(0.3);
    });

    it('trials still running are not failures — a denominator of 0 resolved is NULL', () => {
      expect(trialConversionRate(0, 0)).toBeNull();
    });
  });

  describe('ARPU and ARPPU — net revenue, one currency', () => {
    it('EGP 1,350,000 minor over 10,000 active families = 135 EGP minor ARPU', () => {
      expect(arpu(1_350_000, 10_000, 'EGP')).toEqual({ amountMinor: 135, currencyCode: 'EGP' });
    });

    it('the SAME revenue over 1,000 PAYING families is ARPPU 1,350 minor — ten times ARPU at 10% conversion', () => {
      expect(arppu(1_350_000, 1_000, 'EGP')).toEqual({ amountMinor: 1_350, currencyCode: 'EGP' });
    });

    it('ARPPU >= ARPU always, because paying families are a subset of active ones', () => {
      const a = arpu(1_350_000, 10_000, 'EGP');
      const p = arppu(1_350_000, 1_000, 'EGP');
      expect(p?.amountMinor).toBeGreaterThanOrEqual(a?.amountMinor ?? 0);
    });

    it('no active families = NULL, not 0 revenue per user', () => {
      expect(arpu(0, 0, 'EGP')).toBeNull();
    });

    it('REFUSES a currency that is not ISO-4217 alpha-3', () => {
      expect(() => arpu(100, 1, 'egp')).toThrow(RangeError);
      expect(() => arpu(100, 1, 'EGYPT')).toThrow(RangeError);
    });
  });

  describe('MRR — and the annual plan that must not be booked as one month', () => {
    it('300 monthly Premium subs at 17,900 EGP minor = 5,370,000 minor MRR', () => {
      const components = Array.from({ length: 300 }, () => ({
        netAmountMinor: 17_900,
        billingIntervalMonths: 1,
      }));
      expect(mrr(components, 'EGP')).toEqual({ amountMinor: 5_370_000, currencyCode: 'EGP' });
    });

    it('AN ANNUAL PLAN CONTRIBUTES price/12. One annual sub at 171,840 minor is 14,320/month, not 171,840', () => {
      expect(mrr([{ netAmountMinor: 171_840, billingIntervalMonths: 12 }], 'EGP')).toEqual({
        amountMinor: 14_320,
        currencyCode: 'EGP',
      });
    });

    it('a QUARTERLY plan contributes price/3', () => {
      expect(mrr([{ netAmountMinor: 30_000, billingIntervalMonths: 3 }], 'SAR')).toEqual({
        amountMinor: 10_000,
        currencyCode: 'SAR',
      });
    });

    it('rounds PER SUBSCRIPTION, not on the sum — 3 annuals at 100 minor = 3 x 8 = 24, not 25', () => {
      const components = Array.from({ length: 3 }, () => ({ netAmountMinor: 100, billingIntervalMonths: 12 }));
      // 100/12 = 8.33 -> 8 each. Rounding the SUM (300/12 = 25) would drift
      // against the invoices that back it.
      expect(mrr(components, 'EGP').amountMinor).toBe(24);
    });

    it('rejects a zero or fractional billing interval', () => {
      expect(() => mrr([{ netAmountMinor: 100, billingIntervalMonths: 0 }], 'EGP')).toThrow(RangeError);
      expect(() => mrr([{ netAmountMinor: 100, billingIntervalMonths: 1.5 }], 'EGP')).toThrow(RangeError);
    });

    it('ARR is exactly 12 x MRR, derived and never summed independently', () => {
      const monthly = mrr([{ netAmountMinor: 5_370_000, billingIntervalMonths: 1 }], 'EGP');
      expect(arr(monthly)).toEqual({ amountMinor: 64_440_000, currencyCode: 'EGP' });
    });
  });

  describe('CAC — and the denominator that is NOT registrations', () => {
    it('350,000 EGP minor spend over 1,000 new PAID customers = 350 minor CAC', () => {
      expect(cac(350_000, 1_000, 'EGP')).toEqual({ amountMinor: 350, currencyCode: 'EGP' });
    });

    it('DIVIDING BY REGISTRATIONS INSTEAD UNDERSTATES CAC BY 1/conversion. At 10%, ' +
       'the same spend over 10,000 registrations reports 35 — a tenth of the truth', () => {
      const trueCac = cac(350_000, 1_000, 'EGP');
      const costPerRegistration = cac(350_000, 10_000, 'EGP');
      expect(trueCac?.amountMinor).toBe(350);
      expect(costPerRegistration?.amountMinor).toBe(35);
    });

    it('spend with no acquisitions yet = NULL, not an infinite CAC', () => {
      expect(cac(350_000, 0, 'EGP')).toBeNull();
    });
  });

  describe('LTV — margin-based, and always a FORECAST', () => {
    it('Egypt: ARPPU 282 minor x 59.6% margin x (1/0.06) lifetime = 2,801 minor', () => {
      // 282 * 0.596 = 168.07; 168.07 * 16.667 = 2801.2 -> 2801
      const result = ltv({ amountMinor: 282, currencyCode: 'USD' }, 0.596, 0.06);
      expect(result).toEqual({ amountMinor: 2_801, currencyCode: 'USD' });
    });

    it('Saudi: ARPPU 758 minor x 76.5% x (1/0.045) = 12,886 minor', () => {
      // 758 * 0.765 = 579.87; / 0.045 = 12886.0
      const result = ltv({ amountMinor: 758, currencyCode: 'USD' }, 0.765, 0.045);
      expect(result).toEqual({ amountMinor: 12_886, currencyCode: 'USD' });
    });

    it('A REVENUE LTV WOULD OVERSTATE EGYPT BY 1/0.596 — the margin is not optional', () => {
      const marginBased = ltv({ amountMinor: 282, currencyCode: 'USD' }, 0.596, 0.06);
      const revenueBased = ltv({ amountMinor: 282, currencyCode: 'USD' }, 1, 0.06);
      expect(revenueBased!.amountMinor / marginBased!.amountMinor).toBeCloseTo(1 / 0.596, 2);
    });

    it('ZERO CHURN HAS NO FINITE LIFETIME — returns NULL rather than Infinity', () => {
      // An infinite LTV is always an artefact of a cohort too young to churn.
      expect(ltv({ amountMinor: 282, currencyCode: 'USD' }, 0.596, 0)).toBeNull();
    });

    it('rejects a margin outside (0, 1]', () => {
      expect(() => ltv({ amountMinor: 282, currencyCode: 'USD' }, 0, 0.06)).toThrow(RangeError);
      expect(() => ltv({ amountMinor: 282, currencyCode: 'USD' }, 1.2, 0.06)).toThrow(RangeError);
    });
  });

  describe('CURRENCY SEPARATION — the most expensive lie an analytics layer can tell', () => {
    it('LTV/CAC across two currencies THROWS rather than returning a plausible number', () => {
      expect(() =>
        ltvToCac({ amountMinor: 12_886, currencyCode: 'SAR' }, { amountMinor: 350, currencyCode: 'EGP' }),
      ).toThrow(/SAR .* EGP|EGP/);
    });

    it('same currency: LTV 2,801 over CAC 350 = 8.0x (docs/12 §10.3 Egypt)', () => {
      expect(
        ltvToCac({ amountMinor: 2_801, currencyCode: 'EGP' }, { amountMinor: 350, currencyCode: 'EGP' }),
      ).toBe(8);
    });

    it('a zero CAC gives NULL, not an infinite ratio', () => {
      expect(
        ltvToCac({ amountMinor: 2_801, currencyCode: 'EGP' }, { amountMinor: 0, currencyCode: 'EGP' }),
      ).toBeNull();
    });

    it('payback: CAC 350 over (ARPPU 282 x 59.6% margin) = 2.08 months (docs/12 says 2.1)', () => {
      const months = paybackMonths(
        { amountMinor: 350, currencyCode: 'EGP' },
        { amountMinor: 282, currencyCode: 'EGP' },
        0.596,
      );
      expect(months).toBeCloseTo(2.08, 2);
    });

    it('payback across currencies THROWS', () => {
      expect(() =>
        paybackMonths(
          { amountMinor: 1_200, currencyCode: 'SAR' },
          { amountMinor: 282, currencyCode: 'EGP' },
          0.596,
        ),
      ).toThrow();
    });
  });

  describe('kpiValue() — provenance is a required field, not a convention', () => {
    it('carries the currency for money and null for a rate', () => {
      expect(kpiValue('ARPU', 'ACTUAL', { amountMinor: 135, currencyCode: 'EGP' })).toEqual({
        kpi: 'ARPU',
        provenance: 'ACTUAL',
        value: 135,
        currencyCode: 'EGP',
        kind: 'MONEY_MINOR',
      });
      expect(kpiValue('CHURN_RATE', 'ACTUAL', 0.06)).toEqual({
        kpi: 'CHURN_RATE',
        provenance: 'ACTUAL',
        value: 0.06,
        currencyCode: null,
        kind: 'RATE',
      });
    });

    it('a null value keeps its provenance — "we do not know yet" is still an ACTUAL claim', () => {
      expect(kpiValue('RETENTION_D90', 'ACTUAL', null)).toEqual({
        kpi: 'RETENTION_D90',
        provenance: 'ACTUAL',
        value: null,
        currencyCode: null,
        kind: 'RATE',
      });
    });
  });
});
