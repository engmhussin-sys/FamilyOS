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
 */

/** Given a list of dates (as "YYYY-MM-DD" strings, any order,
 * duplicates allowed) on which a qualifying event occurred (a habit
 * completed, a hydration target reached, a practice logged), returns
 * the current streak: how many consecutive days UP TO AND INCLUDING
 * asOfDateStr have a qualifying date. A gap of even one day breaks
 * the streak back to 0 for any day after the gap. */
export function computeCurrentStreak(qualifyingDateStrs: string[], asOfDateStr: string): number {
  const qualifyingSet = new Set(qualifyingDateStrs);

  let streak = 0;
  const cursor = new Date(`${asOfDateStr}T00:00:00.000Z`);

  while (qualifyingSet.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return streak;
}
