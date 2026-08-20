/**
 * STREAKS, MULTIPLIERS, AND WHY REPLAY CANNOT RE-APPLY A BONUS.
 *
 * REUSE, stated first because the brief asked for it explicitly: there is NO
 * `Streak` TABLE in this repository and never was. What exists is
 * `streak-calculator.ts`'s pure `computeCurrentStreak(dates, asOf)`, which
 * `HabitEngineService`, `HealthEngineService` and `FaithEngineService` already
 * share, plus F3's `StreakDetectionConsumer`, which RECOMPUTES from completion
 * rows instead of incrementing a counter. This file extends that model — a
 * streak is DERIVED, never stored — to per-category streaks. A counter table
 * would have been the parallel model the brief forbids, and would also have
 * been wrong under at-least-once delivery (F3 §5: "a counter is wrong the first
 * time a message is redelivered").
 *
 * THE MULTIPLIER LADDER. Deterministic, table-driven, server-side only.
 * Basis points (10000 = 1.00x) so the arithmetic stays in integers and a
 * reward amount is never a float that rounds differently on two machines.
 */

export interface MultiplierTier {
  readonly minDays: number;
  readonly multiplierBps: number;
  /** The brief's threshold bonuses: 3 days +20, 7 days +100, 30 days special. */
  readonly thresholdBonusPoints: number;
  readonly labelAr: string;
}

export const STREAK_MULTIPLIER_LADDER: readonly MultiplierTier[] = [
  { minDays: 30, multiplierBps: 30000, thresholdBonusPoints: 500, labelAr: 'إنجاز شهر كامل' },
  { minDays: 7, multiplierBps: 20000, thresholdBonusPoints: 100, labelAr: 'أسبوع متواصل' },
  { minDays: 3, multiplierBps: 12000, thresholdBonusPoints: 20, labelAr: 'ثلاثة أيام متواصلة' },
  { minDays: 0, multiplierBps: 10000, thresholdBonusPoints: 0, labelAr: '' },
];

export const BASE_MULTIPLIER_BPS = 10000;

/** The threshold days at which a one-off bonus is granted (and only those). */
export const STREAK_BONUS_THRESHOLDS: readonly number[] = [3, 7, 30];

export function tierForStreak(streakDays: number): MultiplierTier {
  for (const tier of STREAK_MULTIPLIER_LADDER) {
    if (streakDays >= tier.minDays) return tier;
  }
  return STREAK_MULTIPLIER_LADDER[STREAK_MULTIPLIER_LADDER.length - 1];
}

export function multiplierBpsForStreak(streakDays: number): number {
  return tierForStreak(streakDays).multiplierBps;
}

/**
 * The bonus for CROSSING a threshold — 0 on every other day. Crossing is a
 * property of the number itself (`streakDays === 3`), not of "did we grant this
 * before?", which is what keeps it recomputable: replaying the cause produces
 * the same streak length, therefore the same bonus, therefore the same
 * idempotency key, therefore no second row.
 */
export function thresholdBonusForStreak(streakDays: number): number {
  if (!STREAK_BONUS_THRESHOLDS.includes(streakDays)) return 0;
  return tierForStreak(streakDays).thresholdBonusPoints;
}

/**
 * `amount * multiplierBps / 10000`, rounded HALF-UP, in integers.
 *
 * `Math.round` on the integer product rather than float multiplication:
 * `30 * 1.2` is `35.99999999999999` in IEEE-754 and would floor to 35.
 */
export function applyMultiplier(baseAmount: number, multiplierBps: number): number {
  return Math.round((baseAmount * multiplierBps) / BASE_MULTIPLIER_BPS);
}

/**
 * THE KEY COMPOSITION RULE THE BRIEF REQUIRES.
 *
 * The multiplier is part of the idempotency key. That is only replay-safe
 * because the multiplier is FROZEN onto the achievement row at verification
 * time (`achievement_requests.applied_multiplier_bps`) and read back from there
 * on every subsequent grant attempt — it is never recomputed from "the streak
 * as of now". If it were recomputed, a redelivery on a later day could produce
 * a different key and therefore a SECOND grant. Frozen + in the key = the
 * database's unique constraint absorbs the replay, which is CONTEXT §3
 * principle 6 (the constraint is the primitive, not a code check).
 *
 * THE SHARED PREFIX. `RewardsEngineService` composes every ledger key as
 * `${eventKey}:${rewardType}:${source}`. The `ACHIEVEMENT_VERIFIED` envelope key
 * is therefore the exact common prefix of all the ledger rows one verified
 * achievement produced, which is how `RewardSideEffectConsumer` finds them
 * without the event having to carry them. This function reproduces that key
 * character for character — it is deliberately the SAME composition
 * `composeIdempotencyKey('ACHIEVEMENT_VERIFIED', ...)` performs, and
 * `test/rewards/streak-multiplier.spec.ts` asserts the two agree so they cannot
 * drift apart silently.
 */
export function achievementGrantKeyPrefix(
  childId: string,
  achievementId: string,
  multiplierBps: number,
): string {
  const short = (id: string): string => id.replace(/-/g, '').slice(0, 12);
  return `child:${short(childId)}:achv:${short(achievementId)}:x${multiplierBps}`;
}
