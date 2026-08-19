/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * THE CHILD-SAFETY INVARIANTS, PROVEN BY MUTATION.
 * ============================================================================
 *
 * WHAT THIS FILE ADDS THAT `child-safety-invariant.spec.ts` CANNOT.
 *
 * That suite asserts EXAMPLES: «age 999 is refused», «this Arabic string is
 * SHAMING». Examples are necessary and they are not sufficient, because an
 * example passes whenever the invariant is broken in a way the example happens
 * not to hit. The only thing that measures a test's power is BREAKING THE
 * PRODUCT AND WATCHING THE TEST GO RED — and a test suite that has never been
 * observed failing is a suite whose green is uninterpreted.
 *
 * So this file states each invariant ONCE, as a pure predicate over a SAFETY
 * BUILD (a band resolver, a band profile lookup, the filter, and the real
 * `ChildCoachService` wired to that filter), and then runs the whole set four
 * times against four MUTANT builds — one per defect this repository has
 * actually shipped and fixed:
 *
 *   M1  THE FINAL GATE IS REMOVED     `chooseSafe` computes the verdict and
 *                                     ships the candidate anyway.
 *   M2  NORMALISATION IS BYPASSED     the raw string is classified instead of
 *                                     the raw ∪ normalised union (`e2e-15`
 *                                     GAP-1/7/9, and the invisible-ink bypass).
 *   M3  THE BROAD UNKNOWN-AGE FALLBACK  `ageBandFor` is the four bare
 *                                     comparisons again, so every non-finite
 *                                     age falls through to `'15-17'`.
 *   M4  THE UNKNOWN-BAND EXCEPTION    `ageBandProfile` is `PROFILES[band]` with
 *                                     no `??`, so a band string that came from
 *                                     a database column throws from INSIDE the
 *                                     filter.
 *
 * ---------------------------------------------------------------------------
 * NO SOURCE FILE IS EDITED, AT ANY POINT, BY ANY TEST HERE.
 *
 * This is the shape `test/architecture/notification-producer-chain.guard.spec.ts`
 * (RULE P7) and `scripts/dart_preflight_selftest.py` already use in this
 * repository: the negative control runs the REAL analyser over a SYNTHETIC
 * input rather than vandalising the real one and hoping the restore lands.
 * Here the synthetic input is a MODULE GRAPH: `jest.isolateModules` +
 * `jest.doMock` load a private copy of the real, unmodified
 * `child-safety-filter.service.ts` and `child-coach.service.ts` against a
 * defective copy of ONE of their collaborators. The product code under test is
 * the real file, byte for byte, on disk and in git; only the dependency it
 * resolves is swapped, inside this process, inside this file's module registry.
 *
 * That matters for two reasons beyond tidiness:
 *   - `git diff` is empty at every instant, so nothing here can collide with
 *     another agent working on this branch, and a crashed run leaves no
 *     half-restored safety filter behind;
 *   - the mutation is DATA. Adding a fifth defect is a row in `MUTATIONS`, not
 *     a procedure somebody has to remember to reverse.
 *
 * ---------------------------------------------------------------------------
 * HOW TO READ A FAILURE HERE.
 *
 *   «the production build satisfies every invariant» red
 *        → a real invariant is broken in `src/`. Fix `src/`.
 *   «M2 … kills exactly [...]» red with FEWER ids than expected
 *        → an invariant STOPPED being able to detect that defect. The test is
 *          now weaker than it claims; do not adjust the expectation to match.
 *   «M2 … kills exactly [...]» red with MORE ids
 *        → the mutation reaches further than it did, or an invariant became
 *          coupled to something it should not depend on.
 */
import type { AgeBand, AgeBandProfile } from '../../src/modules/ai-core/domain/age-band';
import { AGE_BANDS, SAFEST_AGE_BAND, countWords } from '../../src/modules/ai-core/domain/age-band';
import type { CoachSignals } from '../../src/modules/ai-core/domain/coach.types';

// ===========================================================================
// 1. THE BUILD UNDER TEST — what an invariant is allowed to look at
// ===========================================================================

interface SafetyVerdict {
  readonly isSafe: boolean;
  readonly reasons: readonly string[];
}

interface SafetyBuild {
  readonly label: string;
  /** `ageBandFor` — the resolver that turns a number into a ceiling. */
  bandFor(ageYears: number): AgeBand;
  /** `ageBandProfile` — the lookup a band string from a DB column lands in. */
  profileFor(band: AgeBand): AgeBandProfile;
  /** `ChildSafetyFilterService.validate`. */
  validate(text: string, band: AgeBand): SafetyVerdict;
  /** `ChildSafetyFilterService.chooseSafe`. */
  chooseSafe(candidate: string, template: string, band: AgeBand): { text: string; usedCandidate: boolean };
  /**
   * THE WHOLE PATH, not a unit of it: the REAL `ChildCoachService.today`, with
   * a provider that returns `candidate`, answering the question that actually
   * matters — what sentence reaches the child.
   */
  childReceives(candidate: string, band: AgeBand): Promise<{ text: string; phrasedByAi: boolean }>;
}

// ===========================================================================
// 2. THE FIXTURES
// ===========================================================================

/**
 * SEVENTEEN WORDS: over the ceiling of the first three bands (8, 12, 15) and
 * under the fourth's (18) — the one sentence that can tell all four bands
 * apart. Asserted to be seventeen words below rather than trusted.
 */
const SEVENTEEN_WORDS =
  'اليوم يوم جديد وأنت تستطيع أن تبدأ من جديد بخطوة صغيرة واحدة تكفي تمامًا الآن ودائمًا معًا';

/** An insult a reader sees plainly and a literal-spelling list cannot. */
const OBFUSCATED_SHAMING = [
  'أنت كســـول',        // tatweel inside the banned word
  'أنت كس​ول',      // a zero-width space inside it
  'أنتَ كَسُولٌ',         // the diacritics ordinary writing omits
  'أنتَ لا تَستحقُّ الحياةَ', // the self-harm line, fully vocalised
] as const;

/** Codepoints `String.prototype.trim` cannot see. A candidate made only of
 * these renders a BLANK card, which is what the emptiness rule exists to stop. */
const INVISIBLE_ONLY = ['​​​', '‍‍', '‏‏', '­­', 'ـــ'] as const;

/** The same phone number in three digit blocks. */
const PHONE_SPELLINGS = [
  'ابعتلي رقمك 01012345678',
  'ابعتلي رقمك ٠١٠١٢٣٤٥٦٧٨',
  'ابعتلي رقمك ۰۱۰۱۲۳۴۵۶۷۸',
] as const;

/** Sentences this product must keep being able to send. A mutation that
 * "fixes" an invariant by refusing these has not fixed anything. */
const WHOLESOME = [
  'وحشتني! خطوة كبيرة اليوم.',
  'ابدأ اليوم، ولا تحاسب نفسك على أمس.',
  'أخوك فخور بك اليوم.',
  'حصلت على ٥٠ نقطة اليوم.',
  'أنت لا تحتاج إلى القلق.',
] as const;

const BASE_SIGNALS: CoachSignals = Object.freeze({
  childId: 'c1',
  familyId: 'f1',
  ageYears: 7,
  ageBand: '6-8',
  businessDate: '2026-08-15',
  habits: { active: 2, completed7d: 4, completed28d: 16, missed7d: 0, completedToday: 1, dueToday: 2 },
  streak: { currentDays: 4, bestDays: 9, atRisk: false },
  programs: { active: 1, byCategory: { QURAN: 1 }, byDifficulty: { EASY: 1 } },
  achievements: { verified7d: 3, rejected7d: 0, submitted7d: 1, verified28d: 12 },
  screenTime: { dailyLimitMinutes: 60, focusModeEnabled: false },
  interests: ['QURAN'],
  topHabitTitles: ['قراءة يومية'],
});

// ===========================================================================
// 3. THE INVARIANTS — stated as properties, never as examples
// ===========================================================================

/**
 * `assert` and not `expect`, deliberately: an invariant is EXECUTED against a
 * deliberately broken build and its failure is the RESULT, not an error. A
 * thrown `JestAssertionError` caught and counted would be mixing the reporting
 * channel with the measurement.
 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const eq = (a: unknown, b: unknown, message: string): void =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${message} — got ${JSON.stringify(a)}`);

interface Invariant {
  readonly id: string;
  /** Universal, never «age 999 is refused». */
  readonly name: string;
  check(build: SafetyBuild): Promise<void>;
}

const INVARIANTS: readonly Invariant[] = Object.freeze([
  {
    id: 'I1',
    name: 'an unresolvable age resolves to the safest band, whatever the input',
    async check(b) {
      for (const [label, age] of [
        ['NaN', NaN],
        ['undefined', undefined],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['a non-numeric string', 'nine'],
        ['null', null],
        ['an empty string', ''],
      ] as const) {
        assert(
          b.bandFor(age as number) === SAFEST_AGE_BAND,
          `an age of ${label} resolved to ${b.bandFor(age as number)}, not the safest band`,
        );
      }
    },
  },
  {
    id: 'I2',
    name: 'a band the type union cannot express still returns a verdict — the filter never throws',
    async check(b) {
      // The band string reaching the filter comes from a database column
      // (`notification_decisions.age_band`), not from the TypeScript union.
      for (const rogue of ['4-5', 'not-a-band', '', 'toString'] as unknown as AgeBand[]) {
        let profile: AgeBandProfile;
        try {
          profile = b.profileFor(rogue);
        } catch (err) {
          throw new Error(`ageBandProfile(${String(rogue)}) threw: ${String(err)}`);
        }
        assert(profile !== undefined && profile !== null, `ageBandProfile(${String(rogue)}) returned nothing`);
        eq(profile, b.profileFor(SAFEST_AGE_BAND), `ageBandProfile(${String(rogue)}) is not the strictest profile`);

        let verdict: SafetyVerdict;
        try {
          verdict = b.validate(SEVENTEEN_WORDS, rogue);
        } catch (err) {
          throw new Error(`validate(…, ${String(rogue)}) threw from inside the filter: ${String(err)}`);
        }
        assert(verdict.isSafe === false, `an over-long sentence passed at band ${String(rogue)}`);
        assert(verdict.reasons.includes('TOO_LONG'), `band ${String(rogue)} did not produce TOO_LONG`);
      }
    },
  },
  {
    id: 'I3',
    name: 'text over the strictest ceiling stays refused when the age could not be resolved',
    async check(b) {
      // The fixture must really straddle the bands, or this proves nothing.
      assert(countWords(SEVENTEEN_WORDS) === 17, 'the fixture is no longer seventeen words');
      assert(b.validate(SEVENTEEN_WORDS, '15-17').isSafe, 'the fixture is refused even at the loosest band');
      for (const unresolvable of [NaN, undefined, Infinity, 'nine'] as unknown as number[]) {
        const verdict = b.validate(SEVENTEEN_WORDS, b.bandFor(unresolvable));
        assert(
          verdict.isSafe === false,
          `an unresolvable age (${String(unresolvable)}) made an over-long sentence safe`,
        );
      }
    },
  },
  {
    id: 'I4',
    name: 'a banned meaning stays refused however it is spelled',
    async check(b) {
      const plain = b.validate('أنت كسول', '6-8');
      assert(plain.isSafe === false, 'the plain spelling is not even refused');
      for (const text of OBFUSCATED_SHAMING) {
        const verdict = b.validate(text, '15-17');
        assert(verdict.isSafe === false, `an obfuscated insult passed: ${JSON.stringify(text)}`);
        assert(
          verdict.reasons.includes('SHAMING'),
          `an obfuscated insult was refused under the wrong reason: ${verdict.reasons.join()}`,
        );
      }
    },
  },
  {
    id: 'I5',
    name: 'a candidate with no visible characters is never a safe message, at any band',
    async check(b) {
      for (const text of INVISIBLE_ONLY) {
        for (const band of AGE_BANDS) {
          const verdict = b.validate(text, band);
          assert(verdict.isSafe === false, `invisible ink passed at ${band}: ${JSON.stringify(text)}`);
        }
      }
    },
  },
  {
    id: 'I6',
    name: 'an unsafe candidate never reaches the child, whatever the model returned',
    async check(b) {
      for (const band of AGE_BANDS) {
        const unsafe = 'أنت فاشل ولا تستحق الحياة';
        const out = await b.childReceives(unsafe, band);
        assert(out.text !== unsafe, `the unsafe candidate shipped verbatim at ${band}`);
        assert(!out.text.includes('فاشل'), `the refused candidate survived into the shipped text at ${band}`);
        assert(out.phrasedByAi === false, `a refused candidate was reported as the model's phrasing at ${band}`);
      }
    },
  },
  {
    id: 'I7',
    name: 'an unsafe candidate never reaches the child when it is spelled to evade the lists',
    async check(b) {
      for (const unsafe of OBFUSCATED_SHAMING) {
        const out = await b.childReceives(unsafe, '15-17');
        assert(out.text !== unsafe, `an obfuscated unsafe candidate shipped: ${JSON.stringify(unsafe)}`);
      }
    },
  },
  {
    id: 'I8',
    name: 'the bytes that ship are the bytes that were checked — approve returns the candidate, refuse returns the template',
    async check(b) {
      const approved = 'أحسنتَ اليوم ‏٣ خطوات 🌟';
      const okay = b.chooseSafe(approved, 'قالب', '15-17');
      assert(okay.usedCandidate === true, 'a safe candidate was not used');
      assert(okay.text === approved, 'the approved candidate did not ship byte-for-byte');

      const refused = 'أنت كسول ولم تنجز شيئًا';
      const template = 'خطوة واحدة تكفي اليوم.';
      const fallback = b.chooseSafe(refused, template, '6-8');
      assert(fallback.usedCandidate === false, 'a refused candidate was reported as used');
      assert(fallback.text === template, 'a refusal did not ship the template');
      assert(!fallback.text.includes('كسول'), 'the refused candidate survived the refusal');
    },
  },
  {
    id: 'I9',
    name: 'a phone number is a phone number in any digit block',
    async check(b) {
      for (const text of PHONE_SPELLINGS) {
        const verdict = b.validate(text, '15-17');
        assert(verdict.isSafe === false, `a phone number passed: ${JSON.stringify(text)}`);
        assert(verdict.reasons.includes('PII_LEAK'), `a phone number was not PII_LEAK: ${verdict.reasons.join()}`);
      }
    },
  },
  {
    id: 'I10',
    name: 'no band is looser than the safest band, and a line safe at one band is safe at every looser one',
    async check(b) {
      for (const band of AGE_BANDS) {
        assert(
          b.profileFor(SAFEST_AGE_BAND).maxWords <= b.profileFor(band).maxWords,
          `${SAFEST_AGE_BAND} is not the strictest word ceiling`,
        );
        assert(
          b.profileFor(SAFEST_AGE_BAND).maxChars <= b.profileFor(band).maxChars,
          `${SAFEST_AGE_BAND} is not the strictest char ceiling`,
        );
      }
      for (let words = 1; words <= 24; words++) {
        const text = Array.from({ length: words }, () => 'كلمة').join(' ');
        const safe = AGE_BANDS.map((band) => b.validate(text, band).isSafe);
        for (let i = 1; i < safe.length; i++) {
          assert(!safe[i - 1] || safe[i], `a ${words}-word line is safe at ${AGE_BANDS[i - 1]} and not at ${AGE_BANDS[i]}`);
        }
      }
    },
  },
  {
    id: 'I11',
    name: 'ordinary Arabic still ships — this is a filter, not a wall',
    async check(b) {
      for (const text of WHOLESOME) {
        const verdict = b.validate(text, '15-17');
        assert(verdict.isSafe === true, `a wholesome sentence was refused (${verdict.reasons.join()}): ${text}`);
      }
      const varied = 'بداية جميلة، واصل خطوتك اليوم.';
      const out = await b.childReceives(varied, '15-17');
      assert(out.text === varied, 'a safe model variation did not reach the child');
      assert(out.phrasedByAi === true, 'a safe model variation was not reported as the model’s phrasing');
    },
  },
]);

// ===========================================================================
// 4. THE MUTATIONS — each one a defect this repository has actually shipped
// ===========================================================================

type MutationId = 'NONE' | 'M1_NO_FINAL_GATE' | 'M2_RAW_CLASSIFICATION' | 'M3_BROAD_UNKNOWN_AGE' | 'M4_UNKNOWN_BAND_THROWS';

const AGE_BAND_MODULE = '../../src/modules/ai-core/domain/age-band';
const NORMALISE_MODULE = '../../src/modules/ai-core/domain/arabic-normalise';
const FILTER_MODULE = '../../src/modules/ai-core/application/services/child-safety-filter.service';
const COACH_MODULE = '../../src/modules/ai-core/application/services/child-coach.service';

function applyMutation(mutation: MutationId): void {
  if (mutation === 'M1_NO_FINAL_GATE') {
    /**
     * THE FINAL GATE, REMOVED. `validate` is untouched and still computes the
     * correct verdict — the mutation is that the verdict no longer DECIDES
     * anything, which is the realistic shape of this defect: nobody deletes a
     * safety filter, somebody stops branching on it.
     */
    jest.doMock(FILTER_MODULE, () => {
      const actual = jest.requireActual(FILTER_MODULE);
      class GateRemoved extends actual.ChildSafetyFilterService {
        chooseSafe(candidate: string, template: string, band: string, limits?: unknown) {
          (this as any).validate(candidate, band, limits);
          return { text: candidate, usedCandidate: true };
        }
      }
      return { ...actual, ChildSafetyFilterService: GateRemoved };
    });
  }

  if (mutation === 'M2_RAW_CLASSIFICATION') {
    /**
     * NORMALISATION BYPASSED — the pre-`arabic-normalise` state of the filter,
     * where every list (and the emptiness check, which reads the same folded
     * copy) sees only the raw bytes.
     */
    jest.doMock(NORMALISE_MODULE, () => {
      const actual = jest.requireActual(NORMALISE_MODULE);
      return { ...actual, textVariants: (raw: string) => [raw] };
    });
  }

  if (mutation === 'M3_BROAD_UNKNOWN_AGE' || mutation === 'M4_UNKNOWN_BAND_THROWS') {
    jest.doMock(AGE_BAND_MODULE, () => {
      const actual = jest.requireActual<typeof import('../../src/modules/ai-core/domain/age-band')>(AGE_BAND_MODULE);
      /** The real profile table, recovered through the real accessor. */
      const PROFILES = Object.fromEntries(actual.AGE_BANDS.map((band) => [band, actual.ageBandProfile(band)]));
      return {
        ...actual,
        // M3: the four bare comparisons, every one of which is FALSE for NaN,
        // so a non-finite age falls through to the LOOSEST band in the file.
        ageBandFor:
          mutation === 'M3_BROAD_UNKNOWN_AGE'
            ? (ageYears: number): AgeBand => {
                if (ageYears <= 8) return '6-8';
                if (ageYears <= 11) return '9-11';
                if (ageYears <= 14) return '12-14';
                return '15-17';
              }
            : actual.ageBandFor,
        // M4: `PROFILES[band]` with no `??` — `undefined` for anything outside
        // the union, and `validate` reads `.maxChars` off it on the next line.
        ageBandProfile:
          mutation === 'M4_UNKNOWN_BAND_THROWS'
            ? (band: AgeBand): AgeBandProfile => PROFILES[band] as AgeBandProfile
            : actual.ageBandProfile,
      };
    });
  }
}

/** Loads a private copy of the real product modules against one defect. */
function buildWith(mutation: MutationId, label: string): SafetyBuild {
  let build: SafetyBuild | undefined;

  jest.isolateModules(() => {
    applyMutation(mutation);

    const ageBand = require(AGE_BAND_MODULE);
    const { ChildSafetyFilterService } = require(FILTER_MODULE);
    const { ChildCoachService } = require(COACH_MODULE);

    const filter = new ChildSafetyFilterService();

    build = {
      label,
      bandFor: (age: number) => ageBand.ageBandFor(age),
      profileFor: (band: AgeBand) => ageBand.ageBandProfile(band),
      validate: (text: string, band: AgeBand) => filter.validate(text, band),
      chooseSafe: (candidate: string, template: string, band: AgeBand) =>
        filter.chooseSafe(candidate, template, band),
      childReceives: async (candidate: string, band: AgeBand) => {
        // THE REAL SERVICE, not a re-implementation of its branches. Only the
        // two ports are stubs: the signal source and the model.
        const signals = { build: async () => ({ ...BASE_SIGNALS, ageBand: band }) };
        const ai = { complete: async () => candidate };
        const coach = new ChildCoachService(signals, ai, filter);
        const result = await coach.today('c1', 'f1');
        return { text: result.messageAr, phrasedByAi: result.phrasedByAi };
      },
    };
  });

  // The mock registry is global even though the module registry was isolated,
  // so every path is released again before the next build is assembled.
  for (const modulePath of [AGE_BAND_MODULE, NORMALISE_MODULE, FILTER_MODULE, COACH_MODULE]) {
    jest.dontMock(modulePath);
  }

  assert(build, 'the build was not assembled');
  return build;
}

/** Runs every invariant and returns the ids of the ones that FAILED. */
async function survey(build: SafetyBuild): Promise<{ failed: string[]; passed: string[]; reasons: string[] }> {
  const failed: string[] = [];
  const passed: string[] = [];
  const reasons: string[] = [];
  for (const invariant of INVARIANTS) {
    try {
      await invariant.check(build);
      passed.push(invariant.id);
    } catch (err) {
      failed.push(invariant.id);
      reasons.push(`${invariant.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { failed, passed, reasons };
}

/**
 * WHAT EACH DEFECT MUST KILL — and, just as importantly, WHAT IT MUST NOT.
 *
 * A mutation that turned every invariant red would prove only that the suite
 * notices SOMETHING; these expectations are exact, so a mutation reaching an
 * invariant it has no business reaching is a red test too.
 */
const MUTATIONS: readonly { readonly id: MutationId; readonly what: string; readonly kills: readonly string[] }[] =
  Object.freeze([
    {
      id: 'M1_NO_FINAL_GATE',
      what: 'the final safety gate is removed — the verdict is computed and ignored',
      kills: ['I6', 'I7', 'I8'],
    },
    {
      id: 'M2_RAW_CLASSIFICATION',
      what: 'the raw string is classified instead of the normalised copy',
      kills: ['I4', 'I5', 'I7', 'I9'],
    },
    {
      id: 'M3_BROAD_UNKNOWN_AGE',
      what: "an unresolvable age falls through to '15-17' instead of the safest band",
      kills: ['I1', 'I3'],
    },
    {
      id: 'M4_UNKNOWN_BAND_THROWS',
      what: 'an unrecognised band has no profile, so the filter throws instead of deciding',
      kills: ['I2'],
    },
  ]);

// ===========================================================================
// 5. THE SUITE
// ===========================================================================

describe('THE CHILD-SAFETY INVARIANTS, PROVEN BY MUTATION', () => {
  describe('the invariants hold for the code that is actually shipped', () => {
    it('the production build satisfies EVERY invariant', async () => {
      const { failed, reasons } = await survey(buildWith('NONE', 'production'));
      expect(reasons).toEqual([]);
      expect(failed).toEqual([]);
    });

    it('and the survey really ran all of them — a suite of zero invariants also reports zero failures', async () => {
      const { passed } = await survey(buildWith('NONE', 'production'));
      expect(passed).toEqual(INVARIANTS.map((i) => i.id));
      expect(INVARIANTS).toHaveLength(11);
      // Every id is unique and every invariant is stated universally: no
      // invariant name may name a single input value.
      expect(new Set(INVARIANTS.map((i) => i.id)).size).toBe(INVARIANTS.length);
      for (const invariant of INVARIANTS) {
        expect(invariant.name).not.toMatch(/\b\d{2,}\b/);
      }
    });
  });

  describe.each(MUTATIONS.map((m) => [m.id, m.what, m.kills] as const))(
    'MUTATION %s — %s',
    (id, _what, kills) => {
      it('goes RED, and on exactly the invariants that describe this defect', async () => {
        const { failed, passed, reasons } = await survey(buildWith(id, id));
        // RED, and not by accident: the reasons are asserted to be non-empty so
        // a mutation that silently stopped applying cannot read as a pass.
        expect(failed.length).toBeGreaterThan(0);
        expect(reasons.length).toBe(failed.length);
        expect(failed).toEqual([...kills]);
        // THE COUNTS, PINNED. 11 invariants; this defect turns exactly
        // `kills.length` of them red and leaves the rest green.
        expect(failed).toHaveLength(kills.length);
        expect(passed).toHaveLength(INVARIANTS.length - kills.length);
      });

      it('and leaves the unrelated invariants GREEN — the suite is discriminating, not indiscriminate', async () => {
        const { passed } = await survey(buildWith(id, id));
        const untouched = INVARIANTS.map((i) => i.id).filter((i) => !kills.includes(i));
        expect(passed).toEqual(untouched);
        // I11 in particular: no defect above may be "detected" by the suite
        // suddenly refusing ordinary Arabic.
        expect(passed).toContain('I11');
      });
    },
  );

  describe('the mutations are real, and the restoration is total', () => {
    it('the production build is still clean AFTER every mutant has been built and run', async () => {
      for (const mutation of MUTATIONS) await survey(buildWith(mutation.id, mutation.id));
      const { failed, reasons } = await survey(buildWith('NONE', 'production-after'));
      expect(reasons).toEqual([]);
      expect(failed).toEqual([]);
    });

    it('and the top-level production modules were never mutated — this file edits no source', async () => {
      // The modules imported at the TOP of this file are the ones every other
      // suite in the process shares. If a `doMock` had leaked out of
      // `isolateModules`, these would answer the mutant's way.
      const { ageBandFor, ageBandProfile } = require(AGE_BAND_MODULE);
      expect(ageBandFor(NaN)).toBe(SAFEST_AGE_BAND);
      expect(ageBandProfile('4-5' as AgeBand)).toEqual(ageBandProfile(SAFEST_AGE_BAND));
      const { textVariants } = require(NORMALISE_MODULE);
      expect(textVariants('أنت كســول')).toHaveLength(2);
    });

    it('every mutation kills at least one invariant, so none of them is a no-op', () => {
      for (const mutation of MUTATIONS) {
        expect(mutation.kills.length).toBeGreaterThan(0);
      }
      // And between them they exercise every invariant that CAN be killed by a
      // safety defect — I10 and I11 are the two deliberate exceptions, and they
      // are the ones that must stay green under all four.
      const killed = new Set(MUTATIONS.flatMap((m) => [...m.kills]));
      expect([...killed].sort()).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']);
    });
  });
});
