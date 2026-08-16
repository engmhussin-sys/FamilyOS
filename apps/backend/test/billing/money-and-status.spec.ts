import {
  MoneyError,
  amountsMatch,
  assertCurrencyCode,
  formatMinor,
  splitVat,
} from '../../src/modules/billing/domain/money';
import {
  CANONICAL_SUBSCRIPTION_STATUSES,
  ENTITLEMENT_BEARING_STATUSES,
  isEntitlementBearing,
  toCanonicalStatus,
  toPersistedStatus,
  type PersistedSubscriptionStatus,
} from '../../src/modules/billing/domain/subscription-status';

/**
 * PHASE D — THE TWO SMALL FILES EVERYTHING ELSE DEPENDS ON.
 *
 * `money.ts` and `subscription-status.ts` are each under 130 lines and each is
 * a single point of failure for the whole module: a rounding error here is
 * wrong on every invoice, and a missing status mapping here is a runtime crash
 * on a webhook at 3am.
 */

describe('splitVat — VAT-INCLUSIVE pricing, the norm in both launch markets', () => {
  it('carves 14% out of an Egyptian price', () => {
    // 179.00 EGP inclusive of 14%: vat = 17900 * 1400 / 11400 = 2198.2 -> 2198.
    const money = splitVat({ amountMinor: 17_900, vatBasisPoints: 1_400, vatMode: 'INCLUSIVE', currency: 'EGP' });
    expect(money.grossMinor).toBe(17_900);
    expect(money.vatMinor).toBe(2_198);
    expect(money.netMinor).toBe(15_702);
  });

  it('carves 15% out of a Saudi price — the rate is per country, not a constant', () => {
    const money = splitVat({ amountMinor: 3_400, vatBasisPoints: 1_500, vatMode: 'INCLUSIVE', currency: 'SAR' });
    expect(money.grossMinor).toBe(3_400);
    expect(money.vatMinor).toBe(443);
    expect(money.netMinor).toBe(2_957);
  });

  it('EXCLUSIVE mode adds VAT on top instead', () => {
    const money = splitVat({ amountMinor: 10_000, vatBasisPoints: 1_400, vatMode: 'EXCLUSIVE', currency: 'EGP' });
    expect(money.netMinor).toBe(10_000);
    expect(money.vatMinor).toBe(1_400);
    expect(money.grossMinor).toBe(11_400);
  });

  it('net + vat === gross EXACTLY, for every amount from 0 to 20000, in both modes and both markets', () => {
    // THE PROPERTY THAT MATTERS. Computing net and vat independently and
    // hoping they add up leaves a residual minor unit on some inputs and none
    // on others — which is invisible in a spot check and is a reconciliation
    // failure at scale. Deriving net by SUBTRACTION makes it exact by
    // construction; this test is what proves the construction holds.
    for (const vatBasisPoints of [1_400, 1_500]) {
      for (const vatMode of ['INCLUSIVE', 'EXCLUSIVE'] as const) {
        for (let amountMinor = 0; amountMinor <= 20_000; amountMinor += 1) {
          const m = splitVat({ amountMinor, vatBasisPoints, vatMode, currency: 'EGP' });
          expect(m.netMinor + m.vatMinor).toBe(m.grossMinor);
          expect(m.vatMinor).toBeGreaterThanOrEqual(0);
          expect(m.netMinor).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('a zero-rated country produces zero VAT rather than a division artefact', () => {
    const money = splitVat({ amountMinor: 9_900, vatBasisPoints: 0, vatMode: 'INCLUSIVE', currency: 'EGP' });
    expect(money.vatMinor).toBe(0);
    expect(money.netMinor).toBe(9_900);
  });

  it('refuses a non-integer or negative amount — minor units are integers', () => {
    expect(() => splitVat({ amountMinor: 99.5, vatBasisPoints: 1_400, vatMode: 'INCLUSIVE', currency: 'EGP' })).toThrow(
      MoneyError,
    );
    expect(() => splitVat({ amountMinor: -1, vatBasisPoints: 1_400, vatMode: 'INCLUSIVE', currency: 'EGP' })).toThrow(
      MoneyError,
    );
  });

  it('refuses a VAT rate outside [0, 10000] basis points', () => {
    expect(() => splitVat({ amountMinor: 100, vatBasisPoints: -1, vatMode: 'INCLUSIVE', currency: 'EGP' })).toThrow(
      MoneyError,
    );
    expect(() => splitVat({ amountMinor: 100, vatBasisPoints: 10_001, vatMode: 'INCLUSIVE', currency: 'EGP' })).toThrow(
      MoneyError,
    );
  });
});

describe('assertCurrencyCode', () => {
  it('accepts ISO-4217 alpha-3 uppercase and nothing else', () => {
    expect(() => assertCurrencyCode('EGP')).not.toThrow();
    expect(() => assertCurrencyCode('SAR')).not.toThrow();
    // Each of these produces a silent currency mismatch three months later in
    // a reconciliation, which is why they are refused at the boundary AND by a
    // CHECK constraint in migration 0014.
    for (const bad of ['egp', 'EG', 'EGPP', 'EGP ', '', 'E1P']) {
      expect(() => assertCurrencyCode(bad)).toThrow(MoneyError);
    }
  });
});

describe('amountsMatch — the tamper check', () => {
  it('is exact by default', () => {
    expect(amountsMatch(17_900, 17_900)).toBe(true);
    expect(amountsMatch(17_900, 17_899)).toBe(false);
    expect(amountsMatch(17_900, 1)).toBe(false);
  });

  it('allows a caller-stated tolerance for store FX conversion, and no more', () => {
    expect(amountsMatch(17_900, 17_901, 1)).toBe(true);
    expect(amountsMatch(17_900, 17_902, 1)).toBe(false);
  });
});

describe('formatMinor', () => {
  it('renders minor units for display without ever being used for arithmetic', () => {
    expect(formatMinor(17_900, 2)).toBe('179.00');
    expect(formatMinor(99, 2)).toBe('0.99');
    expect(formatMinor(1_234, 3)).toBe('1.234');
    // JPY-style zero-exponent currencies. Hardcoding 100 would render this
    // as "12.34", which is the bug the `minorUnits` column exists to prevent.
    expect(formatMinor(1_234, 0)).toBe('1234');
    expect(formatMinor(-500, 2)).toBe('-5.00');
  });
});

describe('subscription-status — the ONE mapping site', () => {
  const persisted: PersistedSubscriptionStatus[] = [
    'PENDING',
    'ACTIVE',
    'PAST_DUE',
    'CANCELED',
    'EXPIRED',
    'REFUNDED',
    'TRIALING',
    'GRACE_PERIOD',
  ];

  it('the canonical vocabulary is exactly the eight statuses the brief names', () => {
    expect([...CANONICAL_SUBSCRIPTION_STATUSES].sort()).toEqual(
      ['ACTIVE', 'CANCELLED', 'EXPIRED', 'GRACE_PERIOD', 'PAST_DUE', 'PENDING', 'REFUNDED', 'TRIAL'].sort(),
    );
  });

  it('the two maps are TOTAL and MUTUALLY INVERSE — a ninth state on either side goes red here', () => {
    // This is the whole safety argument for keeping the database's `TRIALING`
    // and `CANCELED` spellings. A two-vocabulary system is only safe if the
    // translation is complete and lives in one place; this asserts both.
    for (const canonical of CANONICAL_SUBSCRIPTION_STATUSES) {
      expect(toCanonicalStatus(toPersistedStatus(canonical))).toBe(canonical);
    }
    for (const p of persisted) {
      expect(toPersistedStatus(toCanonicalStatus(p))).toBe(p);
    }
    expect(persisted).toHaveLength(CANONICAL_SUBSCRIPTION_STATUSES.length);
  });

  it('maps the two US spellings the database carries', () => {
    expect(toPersistedStatus('TRIAL')).toBe('TRIALING');
    expect(toPersistedStatus('CANCELLED')).toBe('CANCELED');
    expect(toCanonicalStatus('TRIALING')).toBe('TRIAL');
    expect(toCanonicalStatus('CANCELED')).toBe('CANCELLED');
  });

  it('GRACE_PERIOD is entitlement-bearing; PENDING and PAST_DUE are not', () => {
    // Q17 + CONTEXT.md §3.7: full permissions during the grace window with a
    // non-frightening notice. And Fawry's PENDING is an UNPAID reference —
    // granting on it gives the product away to anyone who taps subscribe.
    expect([...ENTITLEMENT_BEARING_STATUSES].sort()).toEqual(['ACTIVE', 'GRACE_PERIOD', 'TRIAL']);
    expect(isEntitlementBearing('GRACE_PERIOD')).toBe(true);
    expect(isEntitlementBearing('TRIAL')).toBe(true);
    expect(isEntitlementBearing('PENDING')).toBe(false);
    expect(isEntitlementBearing('PAST_DUE')).toBe(false);
    expect(isEntitlementBearing('EXPIRED')).toBe(false);
    expect(isEntitlementBearing('REFUNDED')).toBe(false);
  });

  it('CANCELLED is not entitlement-bearing — and that is NOT the same as "revoke now"', () => {
    // A cancelled subscription grants nothing NEW. The period already paid for
    // is governed by the entitlement's own `valid_until`, which is why
    // `PaymentWebhookService.applyStatus` takes an explicit `revoke` flag
    // instead of deriving one from this predicate.
    expect(isEntitlementBearing('CANCELLED')).toBe(false);
  });
});
