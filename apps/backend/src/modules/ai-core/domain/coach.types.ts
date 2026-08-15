/**
 * B8 — THE COACH'S INPUT AND OUTPUT CONTRACTS.
 *
 * `CoachSignals` is what the deterministic engine reasons over, and it is
 * deliberately AGGREGATES ONLY (07-AI-Architecture.md §5.1): counts, rates,
 * bands and booleans. There is no raw event stream here, no message content, no
 * app name, no device label, and no free text a child wrote. That is not a
 * promise made in a comment — it is the shape of the type, and
 * `PrismaCoachSignalRepository` cannot return a field this interface does not
 * declare.
 *
 * ONE FIELD CARRIES USER-AUTHORED TEXT AND IT IS NAMED SO: `topHabitTitles`.
 * A habit title is written by a parent today and may be written by a child
 * tomorrow, and the coach genuinely wants it ("your child's reading habit is
 * the one at risk"). It is the reason `prompt-safety.ts` exists, and it is the
 * ONLY string in this type that is ever wrapped in `<untrusted_user_content>`.
 */

import type { AgeBand } from './age-band';

export const COACH_SIGNAL_PROVIDER = Symbol('COACH_SIGNAL_PROVIDER');

export interface CoachSignals {
  readonly childId: string;
  readonly familyId: string;
  readonly ageYears: number;
  readonly ageBand: AgeBand;
  /** The family's OWN business date (`FamilyDateService`), never a UTC day. */
  readonly businessDate: string;

  readonly habits: {
    readonly active: number;
    readonly completed7d: number;
    readonly completed28d: number;
    readonly missed7d: number;
    readonly completedToday: number;
    readonly dueToday: number;
  };

  readonly streak: {
    readonly currentDays: number;
    readonly bestDays: number;
    /** Deterministic: a live streak with nothing completed yet today. */
    readonly atRisk: boolean;
  };

  readonly programs: {
    readonly active: number;
    /** Category code -> count. Category codes are a closed server-side
     * taxonomy (`program-taxonomy.ts`), never user text. */
    readonly byCategory: Readonly<Record<string, number>>;
    /** EASY | MEDIUM | HARD -> count. Also a closed set. */
    readonly byDifficulty: Readonly<Record<string, number>>;
  };

  readonly achievements: {
    readonly verified7d: number;
    readonly rejected7d: number;
    readonly submitted7d: number;
    readonly verified28d: number;
  };

  readonly screenTime: {
    readonly dailyLimitMinutes: number | null;
    readonly focusModeEnabled: boolean;
  };

  /** Derived from the child's own verified achievements — category codes only,
   * most-engaged first. This is "interests" as the product can honestly know
   * them: what they actually finished, not a self-declared profile field. */
  readonly interests: readonly string[];

  /** User-authored. UNTRUSTED. Never placed in a prompt un-wrapped. */
  readonly topHabitTitles: readonly string[];
}

export const COACH_INSIGHT_CODES = [
  'NO_DATA_YET',
  'NO_PROGRAM_YET',
  'NO_SCREEN_TIME_POLICY',
  'STREAK_AT_RISK',
  'STREAK_MILESTONE',
  'STRONG_WEEK',
  'COMPLETION_DROP',
  'MISSED_DAYS_PATTERN',
  'GOAL_TOO_EASY',
  'GOAL_UNREALISTIC',
  'REJECTED_SUBMISSIONS',
  'NARROW_CATEGORY_MIX',
  'STEADY_PROGRESS',
] as const;

export type CoachInsightCode = (typeof COACH_INSIGHT_CODES)[number];

export type CoachSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface CoachInsight {
  readonly code: CoachInsightCode;
  readonly severity: CoachSeverity;
  readonly titleAr: string;
  readonly bodyAr: string;
  /** Why the rule fired, in the numbers it fired on. Rendered in the parent app
   * behind a «لماذا هذا؟» affordance — the transparency requirement of §12. */
  readonly evidenceAr: readonly string[];
  /** Advisory next steps. Every one of them is something the PARENT does; none
   * of them is something this service does. */
  readonly nextStepsAr: readonly string[];
  /** Deterministic confidence from data completeness, not model certainty. */
  readonly confidence: number;
}

export interface CoachActivitySuggestion {
  readonly category: string;
  readonly titleAr: string;
  readonly rationaleAr: string;
  readonly estimatedMinutes: number;
}

export type CoachGenerationSource = 'DETERMINISTIC' | 'LLM_PHRASED';

export interface CoachResponseMeta {
  /** Which path produced the prose. `LLM_PHRASED` means a provider rewrote an
   * already-decided sentence; it never means a provider decided anything. */
  readonly source: CoachGenerationSource;
  /** True when the monthly family budget stopped the provider call. The parent
   * sees a complete deterministic card and no error (§9.3). */
  readonly degraded: boolean;
  readonly businessDate: string;
}

export interface ICoachSignalProvider {
  build(childId: string, familyId: string, now?: Date): Promise<CoachSignals>;
}
