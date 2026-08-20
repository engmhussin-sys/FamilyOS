/**
 * PHASE F (`F6-002`) — THE TONE ENGINE.
 *
 * WHAT WAS THERE. Two hardcoded English strings per candidate, written into
 * `smart-notification-decision-engine.ts` at the point of decision — «Water
 * break?», «You've been on your device a while». One tone, one language, one
 * age. A six-year-old and a sixteen-year-old received the identical sentence,
 * in English, in an Arabic-first product.
 *
 * WHY THE BANDS HERE ARE 5-7 / 8-10 / 11-13 / 14-17 AND `age-band.ts`'s ARE
 * 6-8 / 9-11 / 12-14 / 15-17, AND WHY THAT IS NOT A DUPLICATE.
 *
 * They answer different questions and they are both enforced.
 *
 *   `age-band.ts` (AI Architecture §11.3) is the SAFETY ceiling: how many words
 *   and characters may reach a child of this age. It is enforced by
 *   `ChildSafetyFilterService`, which rejects anything over the ceiling
 *   regardless of who wrote it. That band system is UNCHANGED and still binding.
 *
 *   This file is the VOICE: which words, which register, whether a streak is
 *   «سلسلتك الحلوة» or «سلسلتك». The product's reading-level boundaries do not
 *   sit where the safety ceilings sit — a ten-year-old and an eleven-year-old
 *   read very differently and share a safety ceiling.
 *
 * The composition is deliberate and it is the strict one: copy is CHOSEN by the
 * tone band and then VALIDATED against the safety band's ceiling. Where the two
 * disagree — an eight-year-old is tone band `8-10` and safety band `6-8` — the
 * SAFETY band wins, because it is the fail-closed side. Every template in
 * `notification-copy.ts` is asserted to fit the tightest safety ceiling of any
 * age that maps into its tone band, so the two systems can never quietly
 * disagree in production.
 *
 * FRAMEWORK-FREE. Data, and one total function.
 */

import { ageBandFor, type AgeBand } from '../../../ai-core/domain/age-band';

export const TONE_BANDS = ['5-7', '8-10', '11-13', '14-17'] as const;
export type ToneBand = (typeof TONE_BANDS)[number];

/**
 * The parent is not an age band. Copy for a parent is one register — respectful,
 * clear, non-alarming, actionable — and giving it a pseudo-band would invite
 * someone to write a «tone for young parents».
 */
export type ToneAudience = 'PARENT' | 'CHILD';

export interface ToneProfile {
  readonly band: ToneBand;
  /** The tightest safety band any age in this tone band maps to. Copy for this
   * tone band must fit THIS band's ceiling, not the loosest one. */
  readonly strictestSafetyBand: AgeBand;
  /** Arabic label, used in the admin analytics filter and in the report. */
  readonly labelAr: string;
  /** The register, in one English word each, for operators reading a decision
   * row. Never user-facing. */
  readonly register: string;
  /** Whether an emoji is appropriate for this band. Data, so the copy
   * catalogue's own test can assert it rather than a human remembering. */
  readonly emoji: boolean;
  /** Second person singular form used in Arabic copy for this band. Data
   * because Arabic address changes with age and a template that hardcodes it
   * cannot be reused. */
  readonly addressAr: string;
}

const TONE_PROFILES: Readonly<Record<ToneBand, ToneProfile>> = Object.freeze({
  // 5, 6, 7 -> `ageBandFor` gives '6-8' for all three. maxWords 8.
  '5-7': {
    band: '5-7',
    strictestSafetyBand: '6-8',
    labelAr: 'من ٥ إلى ٧ سنوات',
    register: 'playful-concrete',
    emoji: true,
    addressAr: 'يا بطل',
  },
  // 8, 9, 10 -> '6-8' and '9-11'. The STRICTEST is '6-8' (maxWords 8), which is
  // why an 8-10 template is held to eight words and not twelve. This is the
  // exact place the two band systems overlap, and it is resolved in favour of
  // the younger child.
  '8-10': {
    band: '8-10',
    strictestSafetyBand: '6-8',
    labelAr: 'من ٨ إلى ١٠ سنوات',
    register: 'encouraging-simple',
    emoji: true,
    addressAr: 'يا بطل',
  },
  // 11, 12, 13 -> '9-11' and '12-14'. Strictest is '9-11' (maxWords 12).
  '11-13': {
    band: '11-13',
    strictestSafetyBand: '9-11',
    labelAr: 'من ١١ إلى ١٣ سنة',
    register: 'peer-respectful',
    emoji: false,
    addressAr: '',
  },
  // 14..17 -> '12-14' and '15-17'. Strictest is '12-14' (maxWords 15).
  '14-17': {
    band: '14-17',
    strictestSafetyBand: '12-14',
    labelAr: 'من ١٤ إلى ١٧ سنة',
    register: 'adult-brief',
    emoji: false,
    addressAr: '',
  },
});

/**
 * TOTAL, like `ageBandFor` and for the same reason: a child outside 5..17 is not
 * outside the product, and returning `null` here is how an unbounded sentence
 * reaches a five-year-old. `null` age — a family-level notification with no
 * child — resolves to the YOUNGEST band, which is the conservative direction.
 */
export function toneBandFor(ageYears: number | null): ToneBand {
  if (ageYears === null || ageYears <= 7) return '5-7';
  if (ageYears <= 10) return '8-10';
  if (ageYears <= 13) return '11-13';
  return '14-17';
}

export function toneProfile(band: ToneBand): ToneProfile {
  return TONE_PROFILES[band];
}

/**
 * The safety band a piece of copy must be validated against.
 *
 * For a real child it is that child's OWN `ageBandFor` band — the exact ceiling
 * §11.3 assigns them. The tone band's `strictestSafetyBand` is used only when
 * there is no age (family-level copy), and it is used because the alternative is
 * choosing no ceiling at all.
 */
export function safetyBandFor(ageYears: number | null, tone: ToneBand): AgeBand {
  return ageYears === null ? TONE_PROFILES[tone].strictestSafetyBand : ageBandFor(ageYears);
}
