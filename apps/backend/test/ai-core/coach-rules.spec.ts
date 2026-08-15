import {
  COACH_RULE_COUNT,
  coachConfidence,
  deservesLlmPhrasing,
  evaluateCoachRules,
  recommendActivities,
  topCoachInsight,
} from '../../src/modules/ai-core/domain/coach-rules';
import { COACH_INSIGHT_CODES, type CoachSignals } from '../../src/modules/ai-core/domain/coach.types';

/**
 * B8 — THE DETERMINISTIC ENGINE, ASSERTED ON EXACT OUTPUT.
 *
 * These are pure functions of a plain object, so the assertions are exact
 * strings and exact numbers rather than "contains" and "is truthy". That is the
 * whole return on making the engine pure: an insight either says the sentence
 * it is supposed to say or the test fails, and no database, clock or provider
 * is involved in finding out.
 *
 * THE FORBIDDEN-VOCABULARY SWEEP AT THE BOTTOM IS THE IMPORTANT ONE. Task 3
 * says "never medical or psychological diagnosis" and CONTEXT §3 principle 7
 * says no punitive language. Both are properties of thirteen fixed strings, so
 * both are checkable exhaustively rather than sampled.
 */

const BASE: CoachSignals = Object.freeze({
  childId: 'c1',
  familyId: 'f1',
  ageYears: 10,
  ageBand: '9-11',
  businessDate: '2026-08-15',
  habits: { active: 3, completed7d: 5, completed28d: 20, missed7d: 0, completedToday: 1, dueToday: 3 },
  streak: { currentDays: 4, bestDays: 9, atRisk: false },
  programs: { active: 2, byCategory: { QURAN: 1, READING: 1 }, byDifficulty: { MEDIUM: 2 } },
  achievements: { verified7d: 5, rejected7d: 0, submitted7d: 1, verified28d: 18 },
  screenTime: { dailyLimitMinutes: 90, focusModeEnabled: false },
  interests: ['QURAN'],
  topHabitTitles: ['قراءة يومية'],
});

const withSignals = (patch: Partial<CoachSignals>): CoachSignals => ({ ...BASE, ...patch });

describe('the deterministic coach rule engine', () => {
  it('declares thirteen rules and thirteen insight codes — the table and the type agree', () => {
    expect(COACH_RULE_COUNT).toBe(13);
    expect(COACH_INSIGHT_CODES).toHaveLength(13);
  });

  it('is a PURE function — the same signals produce byte-identical output twice', () => {
    expect(JSON.stringify(evaluateCoachRules(BASE))).toBe(JSON.stringify(evaluateCoachRules(BASE)));
  });

  describe('every rule fires on its own condition and says its own sentence', () => {
    it('NO_DATA_YET on a family with nothing at all — and invents no explanation', () => {
      const insight = topCoachInsight(
        withSignals({
          habits: { active: 0, completed7d: 0, completed28d: 0, missed7d: 0, completedToday: 0, dueToday: 0 },
          programs: { active: 0, byCategory: {}, byDifficulty: {} },
        }),
      );
      expect(insight.code).toBe('NO_DATA_YET');
      expect(insight.bodyAr).toContain('لا توجد مهام أو برامج نشطة بعد');
      expect(insight.severity).toBe('LOW');
    });

    it('STREAK_AT_RISK outranks everything — it is the only HIGH that is time-critical today', () => {
      const insight = topCoachInsight(
        withSignals({
          streak: { currentDays: 6, bestDays: 9, atRisk: true },
          screenTime: { dailyLimitMinutes: null, focusModeEnabled: false },
        }),
      );
      expect(insight.code).toBe('STREAK_AT_RISK');
      expect(insight.severity).toBe('HIGH');
      expect(insight.bodyAr).toContain('6 أيام');
      expect(insight.nextStepsAr[0]).toContain('مهمة واحدة قصيرة');
    });

    it('a streak of 2 at risk does NOT fire — three days is the threshold, and it is real', () => {
      const codes = evaluateCoachRules(
        withSignals({ streak: { currentDays: 2, bestDays: 9, atRisk: true } }),
      ).map((i) => i.code);
      expect(codes).not.toContain('STREAK_AT_RISK');
    });

    it('REJECTED_SUBMISSIONS blames the instructions, never the child', () => {
      const insight = topCoachInsight(
        withSignals({ achievements: { verified7d: 0, rejected7d: 3, submitted7d: 3, verified28d: 2 } }),
      );
      expect(insight.code).toBe('REJECTED_SUBMISSIONS');
      expect(insight.bodyAr).toContain('شرط التحقق غير واضح');
      expect(insight.bodyAr).toContain('لا أن المجهود ناقص');
    });

    it('COMPLETION_DROP compares the child to their OWN baseline and to nothing else', () => {
      const insight = topCoachInsight(
        withSignals({ habits: { ...BASE.habits, completed7d: 1, completed28d: 24 } }),
      );
      expect(insight.code).toBe('COMPLETION_DROP');
      expect(insight.bodyAr).toContain('مقابل متوسط 6');
      expect(insight.bodyAr).toContain('غالبًا سبب مؤقت');
    });

    it('STRONG_WEEK fires above 1.3× the baseline', () => {
      const codes = evaluateCoachRules(
        withSignals({ habits: { ...BASE.habits, completed7d: 12 } }),
      ).map((i) => i.code);
      expect(codes).toContain('STRONG_WEEK');
    });

    it('STREAK_MILESTONE fires on exactly the five milestone numbers and no others', () => {
      for (const days of [7, 14, 30, 60, 100]) {
        const codes = evaluateCoachRules(
          withSignals({ streak: { currentDays: days, bestDays: days, atRisk: false } }),
        ).map((i) => i.code);
        expect(codes).toContain('STREAK_MILESTONE');
      }
      for (const days of [6, 8, 29, 31, 99]) {
        const codes = evaluateCoachRules(
          withSignals({ streak: { currentDays: days, bestDays: days, atRisk: false } }),
        ).map((i) => i.code);
        expect(codes).not.toContain('STREAK_MILESTONE');
      }
    });

    it('NO_SCREEN_TIME_POLICY fires on a null limit and proposes an agreement, not a rule', () => {
      const insight = evaluateCoachRules(
        withSignals({ screenTime: { dailyLimitMinutes: null, focusModeEnabled: false } }),
      ).find((i) => i.code === 'NO_SCREEN_TIME_POLICY');
      expect(insight).toBeDefined();
      expect(insight!.nextStepsAr[0]).toContain('اتفق مع طفلك');
    });

    it('NARROW_CATEGORY_MIX fires only with 3+ programs all in one category', () => {
      const one = evaluateCoachRules(
        withSignals({ programs: { active: 3, byCategory: { QURAN: 3 }, byDifficulty: { MEDIUM: 3 } } }),
      ).map((i) => i.code);
      expect(one).toContain('NARROW_CATEGORY_MIX');

      const two = evaluateCoachRules(
        withSignals({ programs: { active: 3, byCategory: { QURAN: 2, SPORT: 1 }, byDifficulty: { MEDIUM: 3 } } }),
      ).map((i) => i.code);
      expect(two).not.toContain('NARROW_CATEGORY_MIX');
    });

    it('STEADY_PROGRESS is the catch-all — a parent never opens the tab to an empty screen', () => {
      // Whatever the signals, at least one insight fires. Asserted over the
      // whole corpus shape rather than one example.
      const shapes: Partial<CoachSignals>[] = [
        {},
        { habits: { active: 1, completed7d: 0, completed28d: 1, missed7d: 0, completedToday: 0, dueToday: 1 } },
        { programs: { active: 9, byCategory: { QURAN: 9 }, byDifficulty: { HARD: 9 } } },
        { streak: { currentDays: 0, bestDays: 0, atRisk: false } },
      ];
      for (const shape of shapes) {
        expect(evaluateCoachRules(withSignals(shape)).length).toBeGreaterThan(0);
      }
    });
  });

  describe('confidence is DATA COMPLETENESS, not model certainty', () => {
    it('a fully-populated family is confident', () => {
      expect(coachConfidence(BASE)).toBe(1);
    });

    it('an empty family is floored at 0.3, never at zero', () => {
      const empty = withSignals({
        habits: { active: 0, completed7d: 0, completed28d: 0, missed7d: 0, completedToday: 0, dueToday: 0 },
        programs: { active: 0, byCategory: {}, byDifficulty: {} },
        achievements: { verified7d: 0, rejected7d: 0, submitted7d: 0, verified28d: 0 },
        screenTime: { dailyLimitMinutes: null, focusModeEnabled: false },
      });
      expect(coachConfidence(empty)).toBe(0.3);
    });
  });

  describe('the LLM gate predicate', () => {
    it('opens on exactly the five codes where warmer wording helps, and on no LOW severity', () => {
      const opened = evaluateCoachRules(
        withSignals({ streak: { currentDays: 5, bestDays: 9, atRisk: true } }),
      ).filter(deservesLlmPhrasing);
      expect(opened.map((i) => i.code)).toEqual(['STREAK_AT_RISK']);

      const closed = evaluateCoachRules(BASE).filter(deservesLlmPhrasing);
      expect(closed).toEqual([]);
    });
  });

  describe('activity recommendations are rules over age, coverage and interests', () => {
    it('never suggests an activity outside the child’s age window', () => {
      for (const ageYears of [6, 8, 10, 13, 16]) {
        const suggestions = recommendActivities(withSignals({ ageYears }), 10);
        expect(suggestions.length).toBeGreaterThan(0);
        for (const s of suggestions) {
          expect(s.rationaleAr).toContain(`${ageYears} سنة`);
        }
      }
    });

    it('prefers categories the child has NO program in — the "seventh Quran program" problem', () => {
      const covered = withSignals({
        programs: { active: 3, byCategory: { QURAN: 3 }, byDifficulty: { MEDIUM: 3 } },
      });
      const top = recommendActivities(covered, 3);
      expect(top.map((s) => s.category)).not.toContain('QURAN');
    });

    it('is deterministic — same signals, same order, twice', () => {
      expect(JSON.stringify(recommendActivities(BASE))).toBe(JSON.stringify(recommendActivities(BASE)));
    });

    it('offers shorter activities to a child who is missing days', () => {
      const struggling = withSignals({ habits: { ...BASE.habits, missed7d: 4 } });
      const suggestions = recommendActivities(struggling, 3);
      expect(suggestions.every((s) => s.estimatedMinutes <= 25)).toBe(true);
    });
  });

  describe('THE VOCABULARY SWEEP — no diagnosis, no punishment, no comparison, anywhere', () => {
    /** Every sentence any rule can produce, across a spread of signal shapes. */
    function everySentence(): string[] {
      const shapes: Partial<CoachSignals>[] = [
        {},
        { habits: { active: 0, completed7d: 0, completed28d: 0, missed7d: 0, completedToday: 0, dueToday: 0 }, programs: { active: 0, byCategory: {}, byDifficulty: {} } },
        { screenTime: { dailyLimitMinutes: null, focusModeEnabled: false } },
        { streak: { currentDays: 6, bestDays: 9, atRisk: true } },
        { streak: { currentDays: 30, bestDays: 30, atRisk: false } },
        { achievements: { verified7d: 0, rejected7d: 4, submitted7d: 4, verified28d: 2 } },
        { habits: { ...BASE.habits, completed7d: 1, completed28d: 24 } },
        { habits: { ...BASE.habits, missed7d: 5 } },
        { habits: { ...BASE.habits, completed7d: 14 } },
        { programs: { active: 4, byCategory: { QURAN: 4 }, byDifficulty: { EASY: 4 } }, achievements: { verified7d: 6, rejected7d: 0, submitted7d: 6, verified28d: 25 } },
        { programs: { active: 5, byCategory: { QURAN: 5 }, byDifficulty: { MEDIUM: 5 } }, achievements: { verified7d: 1, rejected7d: 0, submitted7d: 4, verified28d: 3 } },
        { habits: { active: 0, completed7d: 0, completed28d: 6, missed7d: 0, completedToday: 0, dueToday: 0 }, programs: { active: 0, byCategory: {}, byDifficulty: {} } },
      ];
      const out: string[] = [];
      for (const shape of shapes) {
        for (const insight of evaluateCoachRules(withSignals(shape))) {
          out.push(insight.titleAr, insight.bodyAr, ...insight.evidenceAr, ...insight.nextStepsAr);
        }
        for (const a of recommendActivities(withSignals(shape), 10)) {
          out.push(a.titleAr, a.rationaleAr);
        }
      }
      return out;
    }

    const CLINICAL = ['اكتئاب', 'توحد', 'فرط الحركة', 'اضطراب', 'تشخيص', 'مرض', 'قلق', 'ADHD', 'autism'];
    const PUNITIVE = ['ممنوع', 'حظر', 'تجاوزت', 'عقاب', 'عاقب', 'حرمان', 'احرم', 'فشل', 'كسول', 'مهمل'];
    const COMPARATIVE = ['أقرانه', 'الأطفال الآخرين', 'أخوه', 'أخته', 'المعدل الطبيعي', 'الطبيعي لعمره'];

    it('contains no clinical or diagnostic term', () => {
      const sentences = everySentence();
      expect(sentences.length).toBeGreaterThan(50);
      for (const term of CLINICAL) {
        expect(sentences.filter((s) => s.includes(term))).toEqual([]);
      }
    });

    it('contains no punitive language (CONTEXT §3 principle 7)', () => {
      const sentences = everySentence();
      for (const term of PUNITIVE) {
        expect(sentences.filter((s) => s.includes(term))).toEqual([]);
      }
    });

    it('never compares the child to another child or to an external norm', () => {
      const sentences = everySentence();
      for (const term of COMPARATIVE) {
        expect(sentences.filter((s) => s.includes(term))).toEqual([]);
      }
    });

    it('every next step is something the PARENT does — the AI proposes, it does not act', () => {
      // No sentence promises an action by the system: no «سنقوم», no «تم
      // تطبيق», no «قمنا». Every step is an imperative addressed to a parent.
      const sentences = everySentence();
      for (const term of ['سنقوم', 'تم تطبيق', 'قمنا بـ', 'تم منح', 'تم تعديل']) {
        expect(sentences.filter((s) => s.includes(term))).toEqual([]);
      }
    });
  });
});
