/**
 * ============================================================================
 * ONE MILESTONE LIST — AND A CHECK THAT FAILS WHEN A SECOND COPY APPEARS.
 * ============================================================================
 *
 * WHAT WENT WRONG, AND WHY A UNIT TEST OF THE ARRAY WOULD NOT HAVE CAUGHT IT.
 * The list was correct in every one of the five places it lived. The defect was
 * that there were five, and two of them had been typed shorter:
 *
 *   habit-engine.service.ts        [3, 7, 14, 30, 60, 100]
 *   learning-engine.service.ts     [3, 7, 14, 30, 60, 100]
 *   streak-detection.consumer.ts   [3, 7, 14, 30, 60, 100]
 *   health-engine.service.ts x2    [3, 7, 14, 30]
 *
 * `STREAK_ACHIEVED` PAYS — `default:habit:streak` grants 15 COINS and the
 * health and learning streak rules pay on the same event name — so a child who
 * kept a hydration or activity streak for sixty or a hundred days was told
 * nothing and paid nothing, while the same length in habits paid. Nothing about
 * the arrays looked wrong; the DUPLICATION was the defect.
 *
 * So the assertion cannot be about values. It is about COPIES, and it reads
 * `src/` to make it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  SHORTEST_STREAK_MILESTONE,
  STREAK_MILESTONES,
  isStreakMilestone,
} from '../../src/shared/rewards/streak-milestones';

const SRC = join(__dirname, '..', '..', 'src');
const HOME = join(SRC, 'shared', 'rewards', 'streak-milestones.ts');

function everyTsFile(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) everyTsFile(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('streak milestones live in exactly one place', () => {
  // ==========================================================================
  // 1. THE LIST ITSELF
  // ==========================================================================

  it('1.1 is the full ladder, ascending and deduplicated', () => {
    expect([...STREAK_MILESTONES]).toEqual([3, 7, 14, 30, 60, 100]);
    expect([...STREAK_MILESTONES].sort((a, b) => a - b)).toEqual([...STREAK_MILESTONES]);
    expect(new Set(STREAK_MILESTONES).size).toBe(STREAK_MILESTONES.length);
  });

  /**
   * THE TWO LENGTHS THE HEALTH ENGINE USED TO IGNORE, NAMED. These are the days
   * a hydration or activity streak reached and was paid nothing for, and they
   * are asserted by value so re-shortening the ladder trips here with the reason
   * attached rather than as an anonymous array mismatch.
   */
  it('1.2 sixty and a hundred days are paying milestones for every metric', () => {
    expect(isStreakMilestone(60)).toBe(true);
    expect(isStreakMilestone(100)).toBe(true);
  });

  it('1.3 a non-milestone length pays nothing', () => {
    for (const notAMilestone of [0, 1, 2, 4, 6, 8, 29, 31, 59, 61, 99, 101]) {
      expect(isStreakMilestone(notAMilestone)).toBe(false);
    }
  });

  it('1.4 the shortest milestone is derived from the list, not re-typed', () => {
    expect(SHORTEST_STREAK_MILESTONE).toBe(STREAK_MILESTONES[0]);
  });

  // ==========================================================================
  // 2. NO SECOND COPY — THE ASSERTION THIS FILE EXISTS FOR
  // ==========================================================================

  /**
   * A LITERAL COPY OF THE LADDER ANYWHERE IN `src/` FAILS THIS, and the failure
   * prints the file and line, because the person who just typed it is the only
   * person who can cheaply not type it.
   *
   * The pattern is «an array literal beginning `3, 7, 14, 30`» — which catches
   * both the full ladder and the truncated health-engine form that actually
   * shipped. The home file is excluded, and so is a match inside a `*` comment
   * line: the docstrings that record what went wrong quote the array on purpose
   * and deleting that history to satisfy a regex would be the wrong trade.
   */
  it('2.1 no file in src/ contains a second literal copy of the ladder', () => {
    const offenders: string[] = [];
    for (const file of everyTsFile(SRC)) {
      if (file === HOME) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*\*/.test(line)) return; // a doc comment quoting the history
          if (/\[\s*3\s*,\s*7\s*,\s*14\s*,\s*30\b/.test(line)) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * AND THE PRODUCERS ACTUALLY IMPORT IT. §2.1 alone could be satisfied by a
   * file that computes the same numbers some other way, which would be the same
   * defect wearing a different hat. These four are every producer of
   * `STREAK_ACHIEVED` in the codebase; each must reach the list through the one
   * home.
   */
  it.each([
    'modules/life-intelligence/application/services/habit-engine.service.ts',
    'modules/life-intelligence/application/services/health-engine.service.ts',
    'modules/life-intelligence/application/services/learning-engine.service.ts',
    'modules/events/application/consumers/streak-detection.consumer.ts',
  ])('2.2 %s imports the shared list', (relative) => {
    const source = readFileSync(join(SRC, relative), 'utf8');
    expect(source).toContain("shared/rewards/streak-milestones'");
    expect(source).toContain('isStreakMilestone');
  });

  /**
   * THE COMMENT THAT LICENSED THE COPY IS GONE. `streak-detection.consumer.ts`
   * carried «If they ever diverge the streak consumer simply celebrates
   * different numbers than the in-app path — no correctness consequence.» It
   * grants money. A future reader must not find that sentence and believe it.
   */
  it('2.3 the "no correctness consequence" licence for duplication is deleted', () => {
    const consumer = readFileSync(
      join(SRC, 'modules/events/application/consumers/streak-detection.consumer.ts'),
      'utf8',
    );
    expect(consumer).not.toContain('no correctness consequence');
  });
});
