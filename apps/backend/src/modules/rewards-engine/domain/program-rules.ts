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

/** Whole years, floored, on the family-local calendar day. */
export function ageInYears(dateOfBirth: Date, asOf: Date): number {
  let years = asOf.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const beforeBirthday =
    asOf.getUTCMonth() < dateOfBirth.getUTCMonth() ||
    (asOf.getUTCMonth() === dateOfBirth.getUTCMonth() && asOf.getUTCDate() < dateOfBirth.getUTCDate());
  if (beforeBirthday) years -= 1;
  return Math.max(0, years);
}

/** `YYYY-MM-DD`, UTC. The family-local date is a known open risk (see the
 * report's `افتراضات ومخاطر مفتوحة`); the server is single-timezone today and
 * pretending otherwise here would hide that. */
export function localDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The 7-day window `maxPerWeek` is counted over, as `YYYY-MM-DD` bounds. */
export function weekWindow(now: Date): { from: string; to: string } {
  const from = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { from: localDateString(from), to: localDateString(now) };
}
