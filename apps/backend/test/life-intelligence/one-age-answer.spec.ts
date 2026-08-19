/**
 * ============================================================================
 * A CHILD'S AGE HAS ONE ANSWER, AND IT DOES NOT DEPEND ON WHICH SERVER REPLIED.
 * ============================================================================
 *
 * WHAT WENT WRONG. «How old is this child?» had three implementations:
 *
 *   businessAgeInYears           common/time/family-date.ts   calendar, family tz
 *   HealthEngineService.ageYears health-engine.service.ts     ÷ 365.25
 *   calculateAge                 common/utils/age.ts          the HOST's clock
 *
 * The first two BOTH fed `computeHydrationTargetMl`, so on a child's ninth
 * birthday the health engine set a 1700 ml target while `ChildSignalService`
 * set 2100: the progress screen said «goal reached», the nudge kept nudging,
 * and `HYDRATION_GOAL_COMPLETED` and its reward fired 400 ml early. Measured
 * end to end in `hydration-target-one-age.e2e.spec.ts`.
 *
 * `ageYears` IS DELETED. `businessAgeInYears` is the one answer, and §1 below is
 * the check that keeps a fourth from appearing: it scans `src/` for the two
 * arithmetic shapes an ad-hoc age is written in, rather than trusting review.
 *
 * §2 IS A SELF-DELETING EXCEPTION, not an endorsement. `calculateAge` is still
 * on disk because its ONLY caller lives in a module this change was not
 * permitted to touch. The test names the caller so the handoff is unambiguous,
 * and asserts it is still the only one — the moment `ai-context-manager` moves
 * to `businessAgeInYears`, BOTH `src/common/utils/age.ts` and this section are
 * deleted together.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { businessAgeInYears } from '../../src/common/time/family-date';

const SRC = join(__dirname, '..', '..', 'src');

/** The one home. */
const AGE_HOME = join(SRC, 'common', 'time', 'family-date.ts');

/**
 * The one file still holding a second implementation, and the ONE caller
 * keeping it alive. Both are named so that removing one without the other
 * fails here.
 */
const PENDING_HANDOFF = {
  file: join(SRC, 'common', 'utils', 'age.ts'),
  soleCaller: join(SRC, 'modules', 'ai-core', 'application', 'services', 'ai-context-manager.service.ts'),
};

function everyTsFile(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) everyTsFile(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every line of a file that is not a comment. The docstrings recording what
 *  the retired forms did must survive every check below, so prose is stripped
 *  once, here, rather than in four regexes. */
function codeLines(file: string): { line: string; number: number }[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ line, number: i + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\/|\/\*)/.test(line));
}

/** Lines that COMPUTE an age. */
function ageArithmeticIn(file: string): number[] {
  const lines: number[] = [];
  for (const { line, number } of codeLines(file)) {
    // `÷ 365.25` (or `÷ 365`) — the milliseconds-to-years form.
    if (/365(\.25)?\s*\*\s*24/.test(line)) lines.push(number);
    // `now.getFullYear() - dob.getFullYear()` — the calendar-by-hand form.
    if (/getFullYear\(\)\s*-/.test(line)) lines.push(number);
  }
  return lines;
}

describe('a child’s age has one answer', () => {
  // ==========================================================================
  // 1. NO FOURTH IMPLEMENTATION
  // ==========================================================================

  it('1.1 only the one home and the one pending-handoff file compute an age', () => {
    const offenders: string[] = [];
    for (const file of everyTsFile(SRC)) {
      if (file === AGE_HOME || file === PENDING_HANDOFF.file) continue;
      for (const line of ageArithmeticIn(file)) offenders.push(`${file}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * THE RETIRED FORM, NAMED. `HealthEngineService` is where the divergence cost
   * money, so it is asserted by file rather than left to §1.1's general sweep.
   */
  it('1.2 HealthEngineService no longer answers the question itself', () => {
    const file = join(SRC, 'modules/life-intelligence/application/services/health-engine.service.ts');
    const declarations = codeLines(file).filter(({ line }) => /private\s+ageYears\s*\(/.test(line));
    expect(declarations).toEqual([]);
    expect(readFileSync(file, 'utf8')).toContain('businessAgeInYears');
  });

  /**
   * AND THE OTHER READER OF THE SAME TARGET USES THE SAME FUNCTION. These two
   * files disagreeing IS the defect; naming both is the only way this test says
   * so.
   */
  it('1.3 both readers of computeHydrationTargetMl ask businessAgeInYears', () => {
    for (const relative of [
      'modules/life-intelligence/application/services/health-engine.service.ts',
      'modules/life-intelligence/application/services/child-signal.service.ts',
    ]) {
      const source = readFileSync(join(SRC, relative), 'utf8');
      expect(source).toContain('computeHydrationTargetMl');
      expect(source).toContain('businessAgeInYears');
    }
  });

  /**
   * THE ANSWER IS A CALENDAR ANSWER, on the birthday itself and on the day
   * before it. The ÷365.25 form got this wrong for nine years spanning two leap
   * days, which is what made a ninth birthday the case worth naming.
   */
  it('1.4 a ninth birthday is nine, and the day before it is eight', () => {
    expect(businessAgeInYears('2017-08-18', '2026-08-18', 'Africa/Cairo')).toBe(9);
    expect(businessAgeInYears('2017-08-18', '2026-08-17', 'Africa/Cairo')).toBe(8);
    // And the same instant read in two zones can be two different days, so the
    // zone is an input rather than an assumption. January, because Cairo and
    // Riyadh are both UTC+3 in August.
    const newYearInstant = new Date('2026-01-01T00:30:00.000Z');
    expect(businessAgeInYears('2017-01-01', newYearInstant, 'Asia/Riyadh')).toBe(9);
    expect(businessAgeInYears('2017-01-01', newYearInstant, 'Etc/GMT+5')).toBe(8);
  });

  // ==========================================================================
  // 2. THE PENDING HANDOFF — delete this whole section with the file
  // ==========================================================================

  it('2.1 calculateAge has exactly one caller, and it is the one named for handoff', () => {
    const callers = everyTsFile(SRC).filter(
      (file) =>
        file !== PENDING_HANDOFF.file &&
        codeLines(file).some(({ line }) => /\bcalculateAge\b/.test(line)),
    );
    expect(callers).toEqual([PENDING_HANDOFF.soleCaller]);
  });
});
