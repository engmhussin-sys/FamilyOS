/**
 * F1 — HOW A HOUSEHOLD IS ATTRIBUTED TO A MARKET, AS A SPECIFICATION.
 *
 * The predicate in `analytics/domain/country-attribution.ts` is a plain object,
 * so its SHAPE can be asserted without a database — and its shape is where the
 * two properties that matter actually live:
 *
 *   1. the server's own `families.country_code` decides when it is present, and
 *   2. the marketing label is consulted ONLY when it is NULL, which is what
 *      makes the markets disjoint.
 *
 * The predicate is then executed against real PostgreSQL in
 * `test/settings/family-country.e2e.spec.ts` §4, where a family with a country,
 * a family whose label disagrees with its country, and a family with no country
 * anywhere are counted and the numbers are checked. Both halves are needed: this
 * one says what the rule IS, that one says Postgres agrees.
 */
import {
  PLATFORM_SCOPE,
  familyCountryWhere,
} from '../../src/modules/analytics/domain/country-attribution';
import { normaliseCountryCode } from '../../src/modules/settings/domain/country';

describe('F1 — familyCountryWhere', () => {
  it('platform scope filters NOTHING, so an unattributable household is still a household', () => {
    // The decision, stated as a test: a family with no country anywhere is
    // excluded from EG and from SA, but it is NOT dropped from the platform
    // total. Returning a predicate here would silently understate the platform.
    expect(familyCountryWhere(PLATFORM_SCOPE)).toEqual({});
  });

  it("the family's OWN country is the first branch — the server's record decides", () => {
    const where = familyCountryWhere('SA') as { OR: Array<Record<string, unknown>> };
    expect(where.OR[0]).toEqual({ countryCode: 'SA' });
  });

  it('THE LOAD-BEARING CONDITION: the marketing label applies only to families with a NULL country', () => {
    const where = familyCountryWhere('SA') as { OR: Array<Record<string, unknown>> };
    const fallback = where.OR[1] as { countryCode: null; OR: unknown[] };

    // Without `countryCode: null` here, a family the server records as EG whose
    // ad label says SA would be counted in BOTH markets: the per-country numbers
    // would sum to more than the platform number, and every rate derived from
    // them would be wrong with no way to see why.
    expect(fallback.countryCode).toBeNull();
    expect(fallback.OR).toEqual([
      { acquisitionAttribution: { countryCode: 'SA' } },
      { subscription: { countryCode: 'SA' } },
    ]);
  });

  it('a country predicate has exactly two branches — nothing else can attribute a family', () => {
    const where = familyCountryWhere('EG') as { OR: unknown[] };
    expect(where.OR).toHaveLength(2);
  });

  it('EG and SA produce structurally identical predicates — no market is special-cased', () => {
    const eg = JSON.stringify(familyCountryWhere('EG')).replace(/EG/g, '<CC>');
    const sa = JSON.stringify(familyCountryWhere('SA')).replace(/SA/g, '<CC>');
    expect(eg).toBe(sa);
  });
});

describe('F1 — normaliseCountryCode', () => {
  it('upper-cases and trims, so keyboard case is not a refusal', () => {
    expect(normaliseCountryCode('eg')).toBe('EG');
    expect(normaliseCountryCode(' sa ')).toBe('SA');
    expect(normaliseCountryCode('Eg')).toBe('EG');
  });

  it('rejects anything that is not two letters, BEFORE any database round trip', () => {
    for (const bad of ['E', 'EGY', '12', 'E1', '', '  ', 'مص']) {
      expect(normaliseCountryCode(bad)).toBeNull();
    }
  });

  it('rejects non-strings rather than coercing them', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      expect(normaliseCountryCode(bad)).toBeNull();
    }
  });

  it('a well-formed but unsupported code passes the SHAPE check — the catalogue refuses it, not the regex', () => {
    // This is the split the design depends on: `ZZ` and `US` are perfectly
    // well-formed ISO-3166 alpha-2 shapes. Whether they are markets we serve is
    // a question about the `countries` TABLE, so it cannot be answered here —
    // and hardcoding ['EG','SA'] here would turn opening a market from an INSERT
    // into a deploy.
    expect(normaliseCountryCode('zz')).toBe('ZZ');
    expect(normaliseCountryCode('us')).toBe('US');
  });
});
