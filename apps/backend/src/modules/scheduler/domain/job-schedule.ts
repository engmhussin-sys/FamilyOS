import {
  addBusinessDays,
  getBusinessDate,
  getBusinessTimeHHMM,
  type BusinessDate,
} from '../../../common/time/family-date';
import { SCHEDULER_DEFAULTS } from './job.types';

/**
 * PHASE C P4 — THE SCHEDULING DECISIONS, AS PURE FUNCTIONS.
 *
 * Every question the scheduler asks that has a right answer is answered here,
 * with no database, no clock read and no I/O. `now` is always a parameter.
 * That is what makes the DETERMINISM requirement provable rather than asserted:
 * `test/scheduler/job-schedule.spec.ts` feeds these fixed instants and asserts
 * fixed outputs, and it would fail the moment any of them reached for
 * `Date.now()` or for the container's timezone.
 *
 * THE ONE THAT MATTERS MOST is `closableBusinessDate`. It is the entire
 * timezone-correctness requirement in seven lines, and the property it encodes
 * is worth stating in words before the code:
 *
 *   A FAMILY'S DAY ENDS ON THE FAMILY'S CLOCK. At one single instant in UTC,
 *   two families in two zones are closing two DIFFERENT calendar days. This is
 *   not a rounding detail — marking a habit MISSED is a judgement about a day
 *   that is over, and making that judgement on the server's calendar declares
 *   a Cairo child's evening missed while the child is still living it.
 */

/** True when the registry says this job may run now. */
export function isDue(row: { enabled: boolean; nextRunAt: Date }, now: Date): boolean {
  return row.enabled && row.nextRunAt.getTime() <= now.getTime();
}

/** The next scheduled instant after a SUCCESSFUL run: plain cadence. */
export function nextRunAfterSuccess(now: Date, cadenceSeconds: number): Date {
  return new Date(now.getTime() + cadenceSeconds * 1000);
}

/**
 * RETRY WITH BACKOFF, and the reason it is capped at the cadence on one side
 * and at `retryMaxSeconds` on the other.
 *
 * Doubling from a 60s base means a job that fails because a dependency is
 * restarting retries at 60s, 120s, 240s... instead of hammering it every tick.
 * Capping at `retryMaxSeconds` (1h) means a job that has failed twelve times
 * still gets retried — a scheduler that gives up permanently is a scheduler
 * that requires a human to notice, and the whole point of the failure state is
 * that the human is told rather than depended on.
 *
 * `Math.max` against the cadence is NOT applied: a fast-cadence job (the
 * 5-minute dead-letter alert) that is failing should back off PAST its cadence,
 * not stay at it.
 */
export function nextRunAfterFailure(
  now: Date,
  consecutiveFailures: number,
  baseSeconds: number = SCHEDULER_DEFAULTS.retryBaseSeconds,
  maxSeconds: number = SCHEDULER_DEFAULTS.retryMaxSeconds,
): Date {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 20));
  const delay = Math.min(maxSeconds, baseSeconds * Math.pow(2, exponent));
  return new Date(now.getTime() + delay * 1000);
}

/**
 * THE MOST RECENT BUSINESS DAY THIS FAMILY HAS FINISHED AND MAY NOW CLOSE.
 *
 * The rule, in one sentence: a business date `D` becomes closable once the
 * family's local wall clock passes `localHour` on `D+1`.
 *
 * Worked through, for `localHour = 2`:
 *   local 2026-01-16 01:30  ->  closes 2026-01-14   (16th has not reached 02:00,
 *                                                    so the 15th is not yet
 *                                                    closable and the 14th is
 *                                                    the newest one that is)
 *   local 2026-01-16 02:30  ->  closes 2026-01-15
 *   local 2026-01-16 23:00  ->  closes 2026-01-15
 *
 * WHY IT ALWAYS RETURNS A DATE RATHER THAN `null` WHEN "NOT YET DUE". A
 * `null` would mean a rollover missed while the scheduler was down could never
 * be caught up — the sweep would come back, see "not due yet", and the day
 * would be silently skipped forever. Returning the newest closable date
 * instead gives one day of free catch-up, and the `job_runs` unique key makes
 * the catch-up idempotent: whichever date this returns, it is either already
 * SUCCEEDED (and skipped by the database) or it is not (and is run exactly
 * once).
 *
 * DST IS NOT SPECIAL-CASED and must not be. `getBusinessTimeHHMM` and
 * `getBusinessDate` both read tzdata at the instant in question, and
 * `addBusinessDays` walks the CALENDAR, so the 23-hour and 25-hour days fall
 * out correctly instead of being handled.
 */
export function closableBusinessDate(
  now: Date,
  timeZone: string,
  localHour: number,
): BusinessDate {
  const today = getBusinessDate(now, timeZone);
  const localHourNow = Number(getBusinessTimeHHMM(now, timeZone).slice(0, 2));
  // Before the boundary, YESTERDAY is not closable yet — so the newest closable
  // day is the one before it.
  return addBusinessDays(today, localHourNow >= localHour ? -1 : -2);
}

/**
 * THE PROOF HELPER. Given one instant and two zones, do the two families close
 * the same calendar day?
 *
 * Exported because the assertion it supports is a PRODUCT claim, not a test
 * detail: «a daily rollover for a Cairo family and a Riyadh family happen at
 * different instants». Anything that could make that stop being true — someone
 * replacing `getBusinessDate` with `toISOString().slice(0,10)`, someone
 * defaulting `timeZone` to the server's — flips this function's answer, and
 * `test/scheduler/family-rollover-timezone.e2e.spec.ts` fails.
 */
export function closesSameDay(
  now: Date,
  timeZoneA: string,
  timeZoneB: string,
  localHour: number,
): boolean {
  return (
    closableBusinessDate(now, timeZoneA, localHour) ===
    closableBusinessDate(now, timeZoneB, localHour)
  );
}
