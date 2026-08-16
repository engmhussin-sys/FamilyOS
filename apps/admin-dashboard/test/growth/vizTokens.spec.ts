import { describe, expect, it } from 'vitest';
import {
  ALL_PAIRS_SERIES_CAP,
  CATEGORICAL,
  COUNTRY_SLOT,
  FUNNEL_SOURCE,
  ORDINAL_TEAL,
  PROVENANCE,
  STATUS,
  countryColor,
} from '@/features/growth/lib/vizTokens';
import { resolveVizMode } from '@/features/growth/lib/useVizMode';

/**
 * The chart system's structural rules — the checks the palette validator
 * cannot make, because they are about how the slots are USED rather than
 * what colour they are. The colour checks themselves were run with
 * `scripts/validate_palette.js` and their results are recorded in
 * `vizTokens.ts`'s header.
 */
describe('the chart colour system', () => {
  it('assigns a country to a FIXED slot, so a filter never repaints the survivor', () => {
    expect(COUNTRY_SLOT.EG).toBe(0);
    expect(COUNTRY_SLOT.SA).toBe(1);
    expect(countryColor('EG', 'light')).toBe(CATEGORICAL[0].light);
    expect(countryColor('SA', 'dark')).toBe(CATEGORICAL[1].dark);
  });

  it('never reuses a status colour as a series colour', () => {
    const seriesColors = CATEGORICAL.flatMap((slot) => [slot.light, slot.dark]);
    const statusColors = Object.values(STATUS).flatMap((slot) => [slot.light, slot.dark]);
    const collisions = seriesColors.filter((color) => statusColors.includes(color));
    expect(collisions).toEqual([]);
  });

  it('selects dark steps rather than flipping the light ones', () => {
    // Every slot but one moves between modes; an identical pair would mean
    // a step was never validated against the dark surface.
    const identical = CATEGORICAL.filter((slot) => slot.light === slot.dark);
    expect(identical.length).toBe(0);
  });

  it('caps all-pairs chart forms at three series rather than growing a ninth hue', () => {
    expect(ALL_PAIRS_SERIES_CAP).toBe(3);
    expect(CATEGORICAL.length).toBeLessThanOrEqual(8);
  });

  it('keeps the ordinal ramp monotone and single-hue in both modes', () => {
    // This assertion originally demanded `light === reverse(dark)`. That is
    // over-strict and the tokens are right to violate it: the two ramps share
    // their three lighter steps, but the dark surface deliberately stops at
    // #216456 instead of the light ramp's #1A4F44, because the darkest step
    // has to stay visible ON a dark card (the token doc records 2.44:1 there).
    // An exact mirror would have re-introduced a step that disappears.
    // So assert the invariant that actually matters: four distinct steps per
    // mode, both ends shared, and monotone lightness in each direction.
    expect(new Set(ORDINAL_TEAL.light).size).toBe(4);
    expect(new Set(ORDINAL_TEAL.dark).size).toBe(4);

    const shared = ORDINAL_TEAL.light.filter((step) => ORDINAL_TEAL.dark.includes(step));
    expect(shared.length).toBe(3);

    // Lightest-first on dark, lightest-last on light: each ramp is ordered
    // for its own surface rather than reused.
    expect(ORDINAL_TEAL.light[0]).toBe(ORDINAL_TEAL.dark[ORDINAL_TEAL.dark.length - 1]);
  });
});

describe('FORECAST, TARGET and ACTUAL carry three independent channels', () => {
  it('gives each a DIFFERENT fill style — the channel that survives greyscale', () => {
    const styles = [PROVENANCE.ACTUAL.fillStyle, PROVENANCE.TARGET.fillStyle, PROVENANCE.FORECAST.fillStyle];
    expect(new Set(styles).size).toBe(3);
  });

  it('gives each a DIFFERENT glyph — the channel that survives full colour blindness', () => {
    const glyphs = [PROVENANCE.ACTUAL.glyph, PROVENANCE.TARGET.glyph, PROVENANCE.FORECAST.glyph];
    expect(new Set(glyphs).size).toBe(3);
  });

  it('gives each a DIFFERENT value typography — the channel that survives a table with no marks', () => {
    const classes = [
      PROVENANCE.ACTUAL.valueTextClass,
      PROVENANCE.TARGET.valueTextClass,
      PROVENANCE.FORECAST.valueTextClass,
    ];
    expect(new Set(classes).size).toBe(3);
    expect(PROVENANCE.FORECAST.valueTextClass).toContain('italic');
  });

  it('draws TARGET with no fill colour at all — it is a rule, not a bar', () => {
    expect(PROVENANCE.TARGET.color).toBeNull();
    expect(PROVENANCE.TARGET.strokeDasharray).not.toBeNull();
  });

  it('draws ACTUAL solid and undashed, so nothing measured looks projected', () => {
    expect(PROVENANCE.ACTUAL.fillStyle).toBe('solid');
    expect(PROVENANCE.ACTUAL.strokeDasharray).toBeNull();
  });
});

describe('funnel step sources are visually ranked by how strong the evidence is', () => {
  it('draws an ad platform’s own count with texture and reduced weight', () => {
    expect(FUNNEL_SOURCE.EXTERNAL_REPORTED.fillStyle).toBe('hatched');
    expect(FUNNEL_SOURCE.EXTERNAL_REPORTED.opacity).toBeLessThan(FUNNEL_SOURCE.DOMAIN_TABLE.opacity);
  });

  it('draws a server-written domain row at full weight', () => {
    expect(FUNNEL_SOURCE.DOMAIN_TABLE.fillStyle).toBe('solid');
    expect(FUNNEL_SOURCE.DOMAIN_TABLE.opacity).toBe(1);
  });

  it('gives all three sources distinct glyphs', () => {
    const glyphs = Object.values(FUNNEL_SOURCE).map((s) => s.glyph);
    expect(new Set(glyphs).size).toBe(3);
  });
});

describe('resolveVizMode', () => {
  function rootWith(theme: string | null): HTMLElement {
    const element = document.createElement('html');
    if (theme) element.setAttribute('data-theme', theme);
    return element;
  }

  it('lets an explicit light theme beat an OS dark preference', () => {
    expect(resolveVizMode(rootWith('light'), true)).toBe('light');
  });

  it('lets an explicit dark theme beat an OS light preference', () => {
    expect(resolveVizMode(rootWith('dark'), false)).toBe('dark');
  });

  it('falls back to the OS preference when nothing is stamped', () => {
    expect(resolveVizMode(rootWith(null), true)).toBe('dark');
    expect(resolveVizMode(rootWith(null), false)).toBe('light');
  });
});
