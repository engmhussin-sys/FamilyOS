import type { Provenance, FunnelSource, AlertSeverity, CountryCode } from '../api/types';

/**
 * The chart colour system — one system across every view.
 *
 * Derived from the ABNY design tokens in `abny/docs/03-UX-UI-Specification.md`
 * §3 (warm teal primary, sand neutrals, amber accent) and then **snapped to
 * passing** with the dataviz skill's validator rather than eyeballed. The
 * runs are reproducible:
 *
 *   categorical, light, surface #FFFFFF, adjacent  → ALL CHECKS PASS
 *     worst adjacent CVD ΔE 14.3 · normal-vision ΔE 25.6 · amber WARNs at
 *     2.68:1 contrast, which obligates the relief channel (see RELIEF below)
 *   categorical, dark,  surface #1F1C18, adjacent  → ALL CHECKS PASS
 *     worst adjacent CVD ΔE 13.7 · normal-vision ΔE 19.0 · all ≥ 3:1
 *   categorical, first 3 slots, --pairs all, both modes → ALL CHECKS PASS
 *   ordinal teal ramp, both modes, --ordinal        → ALL CHECKS PASS
 *
 * Two brand hexes moved, and only in lightness, holding the hue:
 *   - primary teal `#2C7F6D` → `#00846F` (light). The brand step measured
 *     OKLCH C 0.084, below the 0.10 chroma floor — it reads as gray in a
 *     thin mark. `#00846F` is the same hue at the same lightness with the
 *     chroma pushed onto the floor.
 *   - accent amber `#D98E12` → `#C4820F` (dark only). The brand step
 *     measured OKLCH L 0.706, outside the dark band's 0.48–0.67.
 * The brand hexes stay exactly as-is everywhere that is not a chart mark
 * (buttons, chips, text) — this substitution is scoped to data ink.
 */

export interface VizColorPair {
  light: string;
  dark: string;
}

/**
 * Categorical slots, in FIXED order. Never cycled, never reassigned by rank:
 * a filter that removes a series must not repaint the survivors.
 *
 * Slot 1 is teal and is permanently Egypt; slot 2 is amber and is
 * permanently Saudi Arabia (see COUNTRY_SLOT). Slots 3–4 carry channel and
 * campaign series.
 */
export const CATEGORICAL: readonly VizColorPair[] = [
  { light: '#00846F', dark: '#3FA893' }, // 1 · teal    (brand primary)
  { light: '#D98E12', dark: '#C4820F' }, // 2 · amber   (brand accent)
  { light: '#6C4CF0', dark: '#8C74F2' }, // 3 · violet  (brand child.violet)
  { light: '#1668B0', dark: '#6BAEE8' }, // 4 · blue    (brand info)
] as const;
// Slot 4 was brand child.coral (#C93D1F / #E06A4E) until `vizTokens.spec`
// caught that those are byte-identical to STATUS.serious. A campaign series
// would have been drawn in the exact colour that means "this is a serious
// problem" two cards away on the same screen. Coral stays reserved for
// status; the fourth series slot is brand info blue, which collides with no
// STATUS value in either mode.

/**
 * All-pairs forms (scatter, bubble, small multiples) validate to THREE
 * slots. Anything past that folds into "Other" or facets — never a
 * generated ninth hue.
 */
export const ALL_PAIRS_SERIES_CAP = 3;
export const ADJACENT_SERIES_CAP = CATEGORICAL.length;

/** The de-emphasis hue for "Other" and for context series under emphasis. */
export const DE_EMPHASIS: VizColorPair = { light: '#B3A695', dark: '#6B6154' };

/**
 * Colour follows the entity. Egypt is always slot 1, Saudi Arabia always
 * slot 2, on every chart in the product, whichever is filtered out.
 */
export const COUNTRY_SLOT: Record<CountryCode, number> = { EG: 0, SA: 1 };

export function countryColor(country: CountryCode, mode: 'light' | 'dark'): string {
  return CATEGORICAL[COUNTRY_SLOT[country]][mode];
}

/**
 * Ordinal teal ramp — for the retention grid, where the cell's job is
 * magnitude, not identity. Validated with `--ordinal`: monotone lightness,
 * every adjacent ΔL ≥ 0.06, and the light end clears 2:1 on its surface
 * (light 2.21:1 · dark 2.44:1), so no cell disappears into the card.
 */
export const ORDINAL_TEAL: Record<'light' | 'dark', readonly string[]> = {
  light: ['#74BCAA', '#479E89', '#2C7F6D', '#1A4F44'],
  dark: ['#216456', '#2C7F6D', '#479E89', '#74BCAA'],
};

/** Status palette — ABNY semantic tokens. Reserved: never reused as a
 * series colour, and always shipped with an icon and a label. */
export const STATUS: Record<'good' | 'warning' | 'serious' | 'critical', VizColorPair> = {
  good: { light: '#2E7D4F', dark: '#7ED4A0' },
  warning: { light: '#8A570A', dark: '#F5C05A' },
  serious: { light: '#C93D1F', dark: '#E06A4E' },
  critical: { light: '#B3261E', dark: '#F2B8B5' },
};

export const SEVERITY_STATUS: Record<AlertSeverity, keyof typeof STATUS> = {
  INFO: 'good',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

/** Chart chrome. Hairline, solid, one step off the surface — never dashed
 * (a dashed grid reads as "projection", which on THIS dashboard is a word
 * with a specific meaning we reserve for FORECAST). */
export const CHROME = {
  surface: { light: '#FFFFFF', dark: '#1F1C18' },
  plane: { light: '#FBF9F6', dark: '#14120F' },
  inkPrimary: { light: '#1C1916', dark: '#F4F0E9' },
  inkSecondary: { light: '#4E463C', dark: '#C9C0B3' },
  inkMuted: { light: '#6B6154', dark: '#A79C8D' },
  grid: { light: '#E7E0D5', dark: '#3A342D' },
  axis: { light: '#D5CABA', dark: '#4E463C' },
} as const;

/**
 * The relief channel the validator's contrast WARN obligates: amber at
 * 2.68:1 on white is legal ONLY because every chart carrying it also ships
 * visible direct labels and a table view. This constant exists so the
 * obligation is greppable, not remembered.
 */
export const RELIEF_REQUIRED_SLOTS = [1] as const;

/**
 * ── FORECAST vs TARGET vs ACTUAL ───────────────────────────────────────
 *
 * Three separate visual channels, so the distinction survives greyscale
 * printing, colour-vision deficiency, and a reader who never looks at the
 * legend:
 *
 *   ACTUAL    solid fill · no stroke · solid value text · no badge
 *   TARGET    NO fill · 2px dashed outline in ink · a notched reference
 *             rule laid across the plot · badge "هدف"
 *   FORECAST  45° diagonal hatch fill (SVG pattern) · dashed outline ·
 *             amber · italic value text · badge "توقّع" with an icon
 *
 * Colour is the LAST of the three. Fill *texture* (solid / empty / hatched)
 * is the primary channel and it is the one that survives everything.
 */
export type ProvenanceFillStyle = 'solid' | 'outline-solid' | 'hatched';

export interface ProvenanceTreatment {
  fillStyle: ProvenanceFillStyle;
  /** `null` for TARGET: a target is drawn as a rule, not as a filled mark. */
  color: VizColorPair | null;
  strokeDasharray: string | null;
  /** i18n key for the badge chip. */
  labelKey: string;
  /** Tailwind classes applied to the *value* text, so provenance is legible
   * even in a table row that has no chart mark at all. */
  valueTextClass: string;
  badgeClass: string;
  /** A short glyph carried beside the badge — identity is never colour-alone. */
  glyph: string;
}

export const PROVENANCE: Record<Provenance, ProvenanceTreatment> = {
  ACTUAL: {
    fillStyle: 'solid',
    color: CATEGORICAL[0],
    strokeDasharray: null,
    labelKey: 'growth.provenance.actual',
    valueTextClass: 'text-ink',
    badgeClass: 'bg-sage-100 text-guardian-900',
    glyph: '●',
  },
  TARGET: {
    fillStyle: 'outline-solid',
    color: null,
    strokeDasharray: '6 3',
    labelKey: 'growth.provenance.target',
    valueTextClass: 'text-ink-soft',
    badgeClass: 'border border-dashed border-ink-soft text-ink-soft',
    glyph: '◇',
  },
  FORECAST: {
    fillStyle: 'hatched',
    color: CATEGORICAL[1],
    strokeDasharray: '4 3',
    labelKey: 'growth.provenance.forecast',
    valueTextClass: 'italic text-amber-700',
    badgeClass: 'bg-amber-100 text-amber-700',
    glyph: '◔',
  },
};

/**
 * Funnel step provenance. The contract calls this "visually binding":
 * `EXTERNAL_REPORTED` is an ad platform counting itself, and drawing it at
 * the weight of a `payment_transactions` row is lying by formatting.
 *
 * Same mechanism as PROVENANCE — texture first, colour second.
 */
export interface SourceTreatment {
  fillStyle: ProvenanceFillStyle;
  opacity: number;
  labelKey: string;
  glyph: string;
}

export const FUNNEL_SOURCE: Record<FunnelSource, SourceTreatment> = {
  DOMAIN_TABLE: { fillStyle: 'solid', opacity: 1, labelKey: 'growth.source.domainTable', glyph: '●' },
  ANALYTICS_EVENT: { fillStyle: 'solid', opacity: 0.72, labelKey: 'growth.source.analyticsEvent', glyph: '◐' },
  EXTERNAL_REPORTED: {
    fillStyle: 'hatched',
    opacity: 0.6,
    labelKey: 'growth.source.externalReported',
    glyph: '◌',
  },
};

/** Mark specs from the dataviz skill, in one place so every chart obeys them. */
export const MARK = {
  /** Bars are capped, never filling their band — the leftover is air. */
  maxBarThickness: 24,
  barRadius: 4,
  lineWidth: 2,
  markerRadius: 4,
  /** White doing the separating: a 2px surface gap, never a stroke. */
  surfaceGap: 2,
  areaFillOpacity: 0.1,
  gridWidth: 1,
} as const;
