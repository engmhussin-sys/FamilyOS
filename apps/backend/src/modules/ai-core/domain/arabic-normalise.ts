/**
 * ARABIC NORMALISATION — FOR MATCHING ONLY, NEVER FOR STORAGE OR DELIVERY.
 *
 * WHY THIS FILE EXISTS. Two independent filters stand between a model and a
 * child — `prompt-safety.ts` (the injection tripwire) and
 * `ChildSafetyFilterService` (the banned-content lists) — and `e2e-15` measured
 * that they DISAGREED about what the same sentence says:
 *
 *   GAP-1  `سيّئ` was on the SHAMING list WITH a shadda, so the ordinary
 *          spelling `سيئ` walked past it.
 *   GAP-7  the child filter's phone shape was ASCII `[0-9]`, while
 *          `prompt-safety.ts` already handled `٠-٩` — so «ابعتلي رقمك
 *          ٠١٠١٢٣٤٥٦٧٨» was PII to one filter and ordinary prose to the other.
 *   GAP-9  `الغاء` was listed without its hamza, so `إلغاء` — the spelling a
 *          model actually produces — missed.
 *
 * All three are the SAME defect: a list of literal spellings cannot enumerate
 * Arabic orthography. Adding three more literals would have closed these three
 * strings and left the next three open. So the fix is structural: every filter
 * matches its patterns against BOTH the original text and a normalised copy.
 *
 * WHAT «BOTH» BUYS, AND WHY IT IS NOT «INSTEAD OF». Matching raw ∪ normalised
 * is purely ADDITIVE: no pattern that matched before can stop matching, so no
 * existing refusal can be lost by an edit to this file. Rewriting every legacy
 * pattern into normalised form would have been the alternative, and it would
 * have put ~40 hand-transcribed Arabic literals — each one a chance to silently
 * delete a rule — on the critical path of a child-safety filter.
 *
 * WHAT IS DELIBERATELY *NOT* NORMALISED. Hamza carriers `ؤ` and `ئ` keep their
 * seat: folding `ئ → ي` would turn `سيئ` into `سيي` and force every list entry
 * into a spelling no reviewer can read back. Diacritic stripping already closes
 * the shadda bypass those folds were meant to cover.
 *
 * THE OUTPUT OF THIS FUNCTION IS NEVER STORED, NEVER DELIVERED, NEVER LOGGED
 * AND NEVER PLACED IN A PROMPT. `e2e-15` ACT I and ACT IV assert that the bytes
 * in `child_messages` are byte-identical to the bytes the gate approved; a
 * normaliser that leaked into the write path would break exactly those two
 * tests, which is the correct place for that mistake to be caught.
 */

/** Arabic-Indic (٠-٩ = U+0660..0669) and Extended Arabic-Indic
 * (۰-۹ = U+06F0..06F9). `& 0xF` maps either block onto its ASCII digit. */
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

/** Harakat, tanween, shadda, sukun, superscript alef, and Quranic annotation
 * marks. Stripping these is what turns `سيّئ` into `سيئ` and `أنت سيئٌ` into
 * `انت سيئ`. */
/* THE RANGE STOPS AT U+065F ON PURPOSE. U+0660..0669 is the Arabic-Indic
 * DIGIT block, and a class written `\u064B-\u0670` would delete the digits of
 * GAP-7's phone number BEFORE the digit fold below ever saw them, turning the
 * PII rule into a no-op for exactly the string it was widened for. */
const ARABIC_DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;

/** Tatweel/kashida — a purely typographic stretch that also stretches straight
 * past a substring match: `كســول` is `كسول` to a reader and not to a regex. */
const TATWEEL = /\u0640/g;

/** Zero-width and bidi characters. `sanitiseUntrusted` already strips these
 * from PROMPT input; the OUTPUT filters did not, so `كس​ول` was a working
 * one-character bypass of the entire SHAMING list. */
const INVISIBLES = /[\u00AD\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Every space-like character collapses to U+0020 so that a pattern written
 * with `\s+` behaves the same on a non-breaking space as on a plain one. */
const EXOTIC_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Fold the spellings of one word onto one form. Matching-only; see the header.
 *
 * Cheap enough to run on every validated sentence: four `replace` calls over a
 * string bounded at 180 characters by the age-band ceiling.
 */
export function normaliseArabic(raw: string): string {
  return raw
    .replace(INVISIBLES, '')
    .replace(TATWEEL, '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(EXOTIC_SPACES, ' ')
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.codePointAt(0)! & 0xf))
    // ٱ إ أ آ ٲ ٳ -> ا  (the single most common Arabic spelling divergence)
    .replace(/[\u0622\u0623\u0625\u0671\u0672\u0673]/g, 'ا')
    // ى -> ي  (`على` / `علي`, `مصطفى` / `مصطفي`)
    .replace(/\u0649/g, 'ي')
    // ة -> ه  (`الحياة` / `الحياه`)
    .replace(/\u0629/g, 'ه');
}

/**
 * The forms a matcher must try: the original bytes first, then the normalised
 * copy — and only when normalisation actually changed something, so the common
 * case (pure ASCII, or already-normalised Arabic) costs one `test` and not two.
 */
export function textVariants(raw: string): readonly string[] {
  const normalised = normaliseArabic(raw);
  return normalised === raw ? [raw] : [raw, normalised];
}

/**
 * NO `g` FLAG ON ANY PATTERN PASSED HERE. A global regex carries `lastIndex`
 * between calls, so the second variant would be tested from wherever the first
 * one stopped and a rule would match every other time. Every list this function
 * serves is declared without `/g`; `PII_RULES` in `prompt-safety.ts` DOES use
 * `/g`, and it deliberately does not come through here — it rewrites the
 * original string rather than deciding about it.
 */
export function matchesAnyVariant(pattern: RegExp, variants: readonly string[]): boolean {
  return variants.some((v) => pattern.test(v));
}
