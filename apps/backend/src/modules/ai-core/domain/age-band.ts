/**
 * B8 — THE AGE BANDS, AS DATA.
 *
 * `07-AI-Architecture.md §11.3` fixes four bands and, for each, a vocabulary
 * ceiling and a sentence-length ceiling. Before B8 the backend knew a child's
 * age only as a number (`calculateAge`) and nothing anywhere consumed it for
 * language shaping — the bands existed in the document and nowhere in the code.
 *
 * They are declared here, framework-free (no NestJS, no Prisma), for the same
 * reason `notification-source-key.ts` and `verification.ts` are: this is a
 * CONTRACT, and the templates, the safety filter and the tests all import the
 * same one rather than each restating the numbers.
 *
 * THE CEILINGS ARE ENFORCED, NOT DOCUMENTED. `ChildSafetyFilterService` rejects
 * any child-facing sentence longer than `maxWords` for the band it is being
 * sent to, whether that sentence came from a human-written template or from a
 * model. A model that ignores the instruction therefore cannot reach a child;
 * the template does instead (fail-closed, §11.2).
 */

export const AGE_BANDS = ['6-8', '9-11', '12-14', '15-17'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export interface AgeBandProfile {
  readonly band: AgeBand;
  /** §11.3's sentence ceiling, in words. */
  readonly maxWords: number;
  /** A hard character ceiling on any single child-facing message. §11.2 says
   * ≤ 90 characters for an encouragement line; longer-form answers (the closed
   * topic vocabulary) get more room, which is why this is a separate number. */
  readonly maxChars: number;
  /** Arabic label used in parent-facing copy. */
  readonly labelAr: string;
}

const PROFILES: Readonly<Record<AgeBand, AgeBandProfile>> = Object.freeze({
  '6-8': { band: '6-8', maxWords: 8, maxChars: 90, labelAr: 'من ٦ إلى ٨ سنوات' },
  '9-11': { band: '9-11', maxWords: 12, maxChars: 120, labelAr: 'من ٩ إلى ١١ سنة' },
  '12-14': { band: '12-14', maxWords: 15, maxChars: 150, labelAr: 'من ١٢ إلى ١٤ سنة' },
  '15-17': { band: '15-17', maxWords: 18, maxChars: 180, labelAr: 'من ١٥ إلى ١٧ سنة' },
});

/**
 * THE BAND AN UNKNOWN AGE FALLS INTO, and the direction the whole file leans.
 *
 * `6-8` carries the TIGHTEST ceilings (8 words, 90 characters), so choosing it
 * when the age cannot be established means a sentence is held to the strictest
 * rule this product has rather than the loosest. That is what "fail closed"
 * means for a length ceiling, and it is the only choice that cannot end with an
 * unbounded sentence in front of the youngest child in the database.
 */
export const SAFEST_AGE_BAND: AgeBand = '6-8';

/**
 * A child younger than 6 or older than 17 is not outside the product — they are
 * outside the BANDS, and the honest answer is the nearest band's ceiling, never
 * "no ceiling". Returning `null` here and letting a caller skip the limit is
 * how an unbounded sentence reaches a six-year-old.
 *
 * AND AN AGE THAT IS NOT A NUMBER FAILS TO THE SAFEST BAND, NOT THE LOOSEST.
 * This function used to be four bare comparisons, and every one of them is
 * FALSE for `NaN` — so `NaN` fell through all of them to the final `return
 * '15-17'`, which is the most permissive band in the file. A child whose
 * date of birth could not be resolved was therefore handed a SEVENTEEN-YEAR-
 * OLD's ceilings: an eighteen-word, 180-character sentence that
 * `ChildSafetyFilterService` correctly refuses for a six-year-old was returned
 * `isSafe: true`. The docstring above already promised "never no ceiling"; for
 * an unknown age the code delivered the weakest one, which is the same failure
 * wearing the opposite label.
 *
 * `undefined` and `Infinity` behaved identically. `null` and `''` did not —
 * they coerce to 0 and landed on `6-8` by accident rather than by rule — which
 * is exactly the kind of "it happens to be safe" that stops being true the
 * first time a caller changes what it passes. The guard below states the rule
 * once for every non-finite input instead.
 */
export function ageBandFor(ageYears: number): AgeBand {
  if (!Number.isFinite(ageYears)) return SAFEST_AGE_BAND;
  if (ageYears <= 8) return '6-8';
  if (ageYears <= 11) return '9-11';
  if (ageYears <= 14) return '12-14';
  return '15-17';
}

/**
 * FAIL CLOSED ON A BAND THAT IS NOT A BAND, for the same reason and with the
 * same direction as `ageBandFor`.
 *
 * This was `return PROFILES[band]`, which is `undefined` for any string outside
 * the four — and the caller is `ChildSafetyFilterService.validate`, whose very
 * next line reads `profile.maxChars`. So an unrecognised band did not produce a
 * strict verdict or a lenient one; it produced `TypeError: Cannot read
 * properties of undefined`, thrown from inside the child-safety filter. A
 * filter that throws has not returned "unsafe" — it has returned nothing, and
 * what happens next depends entirely on whether the caller wrapped it in a
 * `try`. That is not a safety property, it is a coin toss, and the band string
 * reaching this function comes from a database column (`notification_decisions
 * .age_band`) rather than from the TypeScript union that pretends to guarantee
 * it.
 *
 * The strictest band is returned instead, so an unknown band is held to the
 * tightest ceilings this product has and the filter still returns a verdict.
 */
export function ageBandProfile(band: AgeBand): AgeBandProfile {
  return PROFILES[band] ?? PROFILES[SAFEST_AGE_BAND];
}

export function profileForAge(ageYears: number): AgeBandProfile {
  return PROFILES[ageBandFor(ageYears)];
}

/** Words, counted the way the ceiling means it: whitespace-separated tokens. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
