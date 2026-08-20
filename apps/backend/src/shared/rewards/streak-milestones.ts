/**
 * ============================================================================
 * WHICH STREAK LENGTHS PAY — ONE LIST, FOR EVERY METRIC.
 * ============================================================================
 *
 * WHAT WENT WRONG, AND IT WAS NOT COSMETIC. This list existed FIVE times:
 *
 *   habit-engine.service.ts:16        [3, 7, 14, 30, 60, 100]
 *   learning-engine.service.ts:14     [3, 7, 14, 30, 60, 100]
 *   streak-detection.consumer.ts:21   [3, 7, 14, 30, 60, 100]
 *   health-engine.service.ts:218      [3, 7, 14, 30]        (inline, hydration)
 *   health-engine.service.ts:388      [3, 7, 14, 30]        (inline, activity)
 *
 * and they had already drifted. `STREAK_ACHIEVED` is a PAYING event —
 * `default:habit:streak` grants 15 COINS, and `default:health:streak` /
 * `default:learning:streak` pay on the same name — so a child who kept a
 * hydration streak for sixty days was told nothing and paid nothing, while
 * sixty days of habits paid coins. Same product, same word, two answers,
 * decided by which file the crossing happened to pass through.
 *
 * `streak-detection.consumer.ts` licensed its own copy in a comment: «If they
 * ever diverge the streak consumer simply celebrates different numbers than the
 * in-app path — no correctness consequence.» That comment was wrong when it was
 * written and is deleted with the copy it defended. IT GRANTS MONEY.
 *
 * WHY ONE LIST AND NOT ONE PER METRIC. A per-metric list would be the same
 * defect with a table of contents: nothing about hydration makes day 60 less of
 * a milestone than it is for habits, and the two health call sites were not a
 * decision — they were a shorter copy of the same array. If a metric ever needs
 * its own ladder, it gets a NAMED export here beside this one, so the divergence
 * is a reviewed line rather than a literal somebody re-typed.
 *
 * THE GUARD: `test/rewards/streak-milestones.spec.ts` scans `src/` and fails if
 * a second literal copy of this array reappears anywhere.
 */

/**
 * The streak lengths, in days, that fire `STREAK_ACHIEVED` and therefore pay.
 * Ascending, deduplicated, and read by every producer of that event.
 */
export const STREAK_MILESTONES: readonly number[] = [3, 7, 14, 30, 60, 100];

/** `true` when a streak of exactly this many days is a paying milestone. */
export function isStreakMilestone(streakDays: number): boolean {
  return STREAK_MILESTONES.includes(streakDays);
}

/**
 * The shortest streak this product treats as a streak at all. Named from the
 * list rather than re-typed, so «what counts as a streak» has one answer —
 * `family-daily-rollover.job.ts` says the same thing about its own threshold.
 */
export const SHORTEST_STREAK_MILESTONE = STREAK_MILESTONES[0];
