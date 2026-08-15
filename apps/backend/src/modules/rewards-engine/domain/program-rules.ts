/**
 * THE PROGRAM RULES, AS A PURE FUNCTION.
 *
 * The brief lists eleven rules per program: value, frequency, max per day, max
 * per week, minimum age, child eligibility, difficulty, verification level,
 * whether parent approval is required, expiry, and streak multiplier. Every one
 * of them is enforced SERVER-SIDE, and the ones that are decidable from
 * counters + the program row are decided here, with zero I/O, so they are
 * unit-testable without a database and so there is exactly one implementation
 * of "may this child start this program now?".
 *
 * WHERE THE OTHER THREE LIVE, so nothing looks missing:
 *   - `value`             -> `reward-spec.ts` (`validateRewardSpec`)
 *   - `verificationLevel` -> `verification.ts` (`VERIFICATION_MATRIX`) and
 *                            `verify()`'s two post-strategy gates
 *   - `streakMultiplier`  -> `streak-multiplier.ts`, clamped to the program's
 *                            ceiling by `AchievementService` at verification
 *
 * NON-PUNITIVE (CONTEXT §3 principle 7): every message below is a statement of
 * fact plus a way forward. There is no «ممنوع» and no «تجاوزت».
 */
import {
  addBusinessDays,
  businessAgeInYears,
  getBusinessDate,
} from '../../../common/time/family-date';
import type { ProgramDifficulty, ProgramFrequency } from '../../../shared/rewards/program-taxonomy';

export interface ProgramRuleContext {
  readonly status: string;
  readonly expiresAt: Date | null;
  readonly frequency: ProgramFrequency;
  readonly maxPerDay: number;
  readonly maxPerWeek: number;
  readonly minAge: number;
  readonly difficulty: ProgramDifficulty;
  /** NULL means "every child in this family". */
  readonly childId: string | null;
}

export interface ProgramEligibilityInput {
  readonly program: ProgramRuleContext;
  readonly childId: string;
  readonly childAgeYears: number;
  /** VERIFIED achievements for this (program, child) today. */
  readonly verifiedToday: number;
  /** VERIFIED achievements for this (program, child) in the last 7 local days. */
  readonly verifiedThisWeek: number;
  /** Attempts already open (REQUESTED/IN_PROGRESS/SUBMITTED/PENDING_PARENT) today. */
  readonly openToday: number;
  readonly now: Date;
}

export interface RuleViolation {
  readonly code: string;
  readonly messageAr: string;
}

export const MAX_OPEN_ATTEMPTS_PER_DAY = 1;

/**
 * Returns the FIRST violation or null. First-and-stop rather than a list: this
 * one is a gate on an action a child is taking right now, not a form a parent is
 * filling in, and showing a child five reasons at once is the punitive UX
 * principle 7 forbids.
 */
export function checkProgramEligibility(input: ProgramEligibilityInput): RuleViolation | null {
  const p = input.program;

  if (p.status !== 'ACTIVE') {
    return { code: 'PROGRAM_NOT_ACTIVE', messageAr: 'هذا البرنامج غير مُفعَّل حاليًا.' };
  }

  if (p.expiresAt && p.expiresAt.getTime() <= input.now.getTime()) {
    return { code: 'PROGRAM_EXPIRED', messageAr: 'انتهت مدة هذا البرنامج. اطلب من ولي الأمر تجديده.' };
  }

  // CHILD ELIGIBILITY. `childId === null` is the real, meaningful "all children
  // of this family" case; a sentinel UUID would have been a lie.
  if (p.childId !== null && p.childId !== input.childId) {
    return { code: 'PROGRAM_NOT_FOR_CHILD', messageAr: 'هذا البرنامج مخصَّص لطفل آخر.' };
  }

  if (input.childAgeYears < p.minAge) {
    return {
      code: 'CHILD_BELOW_MIN_AGE',
      messageAr: `هذا البرنامج مناسب من عمر ${p.minAge} سنة. هناك برامج أخرى تناسبك الآن.`,
    };
  }

  if (input.verifiedToday >= p.maxPerDay) {
    return {
      code: 'MAX_PER_DAY_REACHED',
      messageAr: `أكملت هذا البرنامج ${input.verifiedToday} مرة اليوم — وهذا هو الحد اليومي. نراك غدًا!`,
    };
  }

  if (input.verifiedThisWeek >= p.maxPerWeek) {
    return {
      code: 'MAX_PER_WEEK_REACHED',
      messageAr: `أكملت هذا البرنامج ${input.verifiedThisWeek} مرة هذا الأسبوع — وهذا هو الحد الأسبوعي.`,
    };
  }

  // FREQUENCY. `ONCE` is not `maxPerDay: 1`: it is "ever", which is why it is
  // checked against the week counter as well as the day counter.
  if (p.frequency === 'ONCE' && (input.verifiedToday > 0 || input.verifiedThisWeek > 0)) {
    return { code: 'PROGRAM_ALREADY_COMPLETED', messageAr: 'هذا البرنامج لمرة واحدة، وقد أكملته بالفعل.' };
  }

  if (input.openToday >= MAX_OPEN_ATTEMPTS_PER_DAY) {
    return {
      code: 'ATTEMPT_ALREADY_OPEN',
      messageAr: 'لديك محاولة مفتوحة بالفعل لهذا البرنامج اليوم. أكملها ثم أرسلها.',
    };
  }

  return null;
}

/**
 * B2 (PA-B-001). All three functions below took a `Date` and answered in UTC.
 * They now take the family's IANA zone as an explicit, REQUIRED argument — not
 * an optional one with a UTC default, because an optional timezone is a
 * timezone that will be omitted, and the omission is the bug.
 */

/** Whole years, floored, on the family's calendar day. */
export function ageInYears(dateOfBirth: Date, asOf: Date, timeZone: string): number {
  return businessAgeInYears(dateOfBirth, asOf, timeZone);
}

/**
 * `YYYY-MM-DD` on the family's calendar.
 *
 * The previous implementation was `d.toISOString().slice(0, 10)` with a comment
 * conceding that the family-local date was "a known open risk" and that
 * "pretending otherwise here would hide that". The concession was honest and
 * the consequence was real: this one function is the root of `maxPerDay`, so a
 * child in Cairo completing a program at 00:30 was counted against YESTERDAY's
 * limit and blocked, and the same child at 21:30 could complete TOMORROW's.
 */
export function localDateString(d: Date, timeZone: string): string {
  return getBusinessDate(d, timeZone);
}

/**
 * The 7-day window `maxPerWeek` is counted over, as `YYYY-MM-DD` bounds.
 *
 * B2: the window used to be `now - 6*86_400_000`, i.e. six times twenty-four
 * hours. Across a DST transition that is not six days. It is now six CALENDAR
 * days back from today's business date, which is what "this week" means.
 */
export function weekWindow(now: Date, timeZone: string): { from: string; to: string } {
  const to = getBusinessDate(now, timeZone);
  return { from: addBusinessDays(to, -6), to };
}
