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
 * A child younger than 6 or older than 17 is not outside the product — they are
 * outside the BANDS, and the honest answer is the nearest band's ceiling, never
 * "no ceiling". Returning `null` here and letting a caller skip the limit is
 * how an unbounded sentence reaches a six-year-old.
 */
export function ageBandFor(ageYears: number): AgeBand {
  if (ageYears <= 8) return '6-8';
  if (ageYears <= 11) return '9-11';
  if (ageYears <= 14) return '12-14';
  return '15-17';
}

export function ageBandProfile(band: AgeBand): AgeBandProfile {
  return PROFILES[band];
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
