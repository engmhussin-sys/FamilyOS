/**
 * Sprint 15 (Health & Daily Habits Engine) — CLOSES A REAL GAP: no
 * streak-counting logic existed anywhere in this codebase. A prior
 * comment in habit-engine.service.ts referenced "a real Reward Rule
 * like '7-day streak'" as if it existed — it did not; this is that
 * missing calculation, built ONCE as a pure, reusable function so
 * Hydration, Habits, and Faith Practices (all of which need the same
 * "how many consecutive days has this happened" computation) share
 * ONE implementation rather than three duplicated ones.
 *
 * Pure — zero I/O, zero dependency, same discipline as ai-core's
 * RuleEngineService.evaluate() and health-rules.ts's own
 * computeHydrationTargetMl.
 *
 * B2: still pure, and still takes `YYYY-MM-DD` strings — the difference is that
 * those strings are now FAMILY business dates rather than UTC dates, and the
 * day-stepping below is calendar arithmetic rather than millisecond arithmetic.
 */
import { addBusinessDays } from '../../../../common/time/family-date';

/** Given a list of dates (as "YYYY-MM-DD" strings, any order,
 * duplicates allowed) on which a qualifying event occurred (a habit
 * completed, a hydration target reached, a practice logged), returns
 * the current streak: how many consecutive days UP TO AND INCLUDING
 * asOfDateStr have a qualifying date. A gap of even one day breaks
 * the streak back to 0 for any day after the gap. */
export function computeCurrentStreak(qualifyingDateStrs: string[], asOfDateStr: string): number {
  const qualifyingSet = new Set(qualifyingDateStrs);

  let streak = 0;
  let cursor = asOfDateStr;

  // B2 (PA-B-001). The step back used to be `cursor.setUTCDate(getUTCDate()-1)`
  // on a `Date`. It worked, and it worked for the wrong reason: it assumed
  // every day is exactly 86,400,000 ms long. On a DST boundary that is false —
  // this runtime's tzdata puts Africa/Cairo's 2026 spring day at 23 hours and
  // its autumn day at 25 — and now that the caller hands us dates computed on a
  // real timezone, the assumption became reachable rather than theoretical.
  // `addBusinessDays` walks the CALENDAR, which has no such notion, so a streak
  // spanning either transition stays intact.
  //
  // The bound is not cosmetic: an unbounded loop over caller-supplied data on a
  // hot reward path is an availability risk. 3,650 days is ten consecutive
  // years, which is longer than the product will exist before this is revisited.
  const MAX_STREAK_DAYS = 3650;
  while (qualifyingSet.has(cursor) && streak < MAX_STREAK_DAYS) {
    streak++;
    cursor = addBusinessDays(cursor, -1);
  }

  return streak;
}
