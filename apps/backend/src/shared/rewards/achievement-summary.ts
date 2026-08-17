/**
 * THE ONE READER OF «WHAT WAS ACTUALLY ACHIEVED», IN ARABIC, DERIVED ONCE.
 *
 * `RewardProgram.targetSummaryAr` is written at program creation by
 * `describeTargetSpec` («الآيات 1–5 من سورة الملك») precisely so that the three
 * clients and every server-side surface read ONE derived sentence instead of
 * each re-assembling Arabic out of a surah number and two ayah indices. This
 * module is how that sentence travels from the achievement that carried it to
 * the two places that must state it — the parent's reward notification and the
 * child's life timeline — WITHOUT either of them learning what a Quran surah is.
 *
 * IT IS A READER, NOT A BUILDER. There is deliberately no code here that
 * composes Arabic from numbers: doing that in a notification layer or in a
 * timeline writer is exactly the duplication `describeTargetSpec` exists to
 * prevent, and a second derivation is a second thing to be wrong.
 *
 * THE ENUM GUARD IS THE POINT OF THE FUNCTION RATHER THAN A DETAIL.
 * `describeTargetSpec`'s last line returns the raw ACTIVITY CODE
 * (`QURAN_MEMORIZE_AYAH_RANGE`) for a spec it cannot describe, and that value is
 * persisted on the program like any other. It is a perfectly good machine
 * fallback and it is exactly what «no raw enum may reach a user-visible string»
 * forbids, so a summary shaped like an enum is treated here as ABSENT — the
 * callers then fall back to their own generic Arabic sentence, which is honest,
 * rather than shouting a database value at a parent.
 */

/** `ALL_CAPS_SNAKE`, the shape every activity and category code in this product
 * has. Matched whole-string: a legitimate Arabic summary can never be one. */
const ENUM_SHAPED = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Guards the notification payload against a summary long enough to be a
 * paragraph. `describeTargetSpec`'s real outputs are a few words. */
const MAX_SUMMARY_CHARS = 120;

/**
 * The Arabic target summary carried on a completion's `metadata`, or `null` when
 * this completion has none (a habit, a hydration goal, a streak — none of which
 * are a parent-authored program) or when the stored value is not fit to be read
 * by a human.
 *
 * Takes `unknown` on purpose: both call sites hold a payload that has crossed
 * the outbox as JSON, so the shape is a claim rather than a type.
 */
export function achievementSummaryArOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const metadata = (payload as { metadata?: unknown }).metadata;
  if (metadata === null || typeof metadata !== 'object') return null;
  const raw = (metadata as { targetSummaryAr?: unknown }).targetSummaryAr;
  if (typeof raw !== 'string') return null;

  const summary = raw.trim();
  if (summary.length === 0 || summary.length > MAX_SUMMARY_CHARS) return null;
  if (ENUM_SHAPED.test(summary)) return null;
  return summary;
}
