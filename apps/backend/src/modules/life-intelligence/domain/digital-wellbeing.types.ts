/**
 * Digital Wellbeing Engine (Edge-First Intelligence Architecture).
 * CLOSES A REAL, PREVIOUSLY-DOCUMENTED GAP: `AppUsageLog` has existed
 * in the schema since an early sprint ("Aggregated daily usage per
 * app... to minimize data collected about the child" — the table's
 * own docstring), and `BehavioralIntelligenceEngineService`'s own
 * docstring explicitly named this as unbuilt: "needs the App Usage
 * Collection pipeline, which doesn't exist yet
 * (`docs/architecture/child-runtime-engine.md`'s `IBehaviorPatternDetector`
 * remains a declared-not-implemented contract for exactly this
 * reason)." This is that pipeline's backend half.
 *
 * Architecture 1.0 discipline maintained: lives in life-intelligence
 * (never modifies ai-core, which stays frozen), writes through
 * ILifeTimelineWriter like every other engine, never a second source
 * of truth for anything Digital Twin already owns.
 */

/** Matches the Child App's local aggregation exactly — the payload
 * shape a device uploads once per day (or on-demand), never raw
 * per-tap/per-second events.
 *
 * Sprint 14 additions are ALL optional — an app version that never
 * sends session/category data (older build, or a device where that
 * collection genuinely failed) must not break ingestion of what it
 * DOES have. Absence is honestly representable as undefined, never
 * defaulted to a fake 0 that would corrupt baseline math. */
export interface IDailyUsageSummaryInput {
  usageDate: string; // "YYYY-MM-DD", the device's own local calendar day
  totalScreenMinutes: number;
  appBreakdown: Array<{ packageName: string; minutes: number; category?: AppCategory }>;
  pickupCount: number;
  nightUsageMinutes: number;
  blockedAttemptCount: number;
  sessionCount?: number;
  averageSessionMinutes?: number;
  longestSessionMinutes?: number;
}

export interface IDailyUsageSummary extends IDailyUsageSummaryInput {
  id: string;
  childId: string;
  deviceId: string;
  createdAt: Date;
}

/** Sprint 14 — CLOSES A REAL GAP: no app category taxonomy existed
 * anywhere. Deliberately the small, product-relevant set the brief's
 * own worked examples reason about (education/gaming/social/
 * entertainment feed pattern detection directly) plus the broader
 * buckets needed for honest, complete classification of anything a
 * child might install. 'OTHER' is the deliberate fallback for any
 * package not in the local classifier's map — never silently
 * miscategorized as something specific. */
export type AppCategory =
  | 'EDUCATION'
  | 'COMMUNICATION'
  | 'SOCIAL'
  | 'GAMING'
  | 'VIDEO'
  | 'ENTERTAINMENT'
  | 'PRODUCTIVITY'
  | 'BROWSER'
  | 'UTILITIES'
  | 'OTHER';

/** The five near-real-time critical event types the product brief
 * asked for — a closed, deliberately small union (not an open
 * string) so a typo in the Child App can never silently create a
 * new, unrecognized alert type that never reaches a parent. */
export type CriticalWellbeingEventType =
  | 'PROTECTION_BYPASS_ATTEMPT'
  | 'ACCESSIBILITY_DISABLED'
  | 'SCREEN_TIME_EXCEEDED'
  | 'POLICY_VIOLATION'
  | 'CHILD_REQUEST';

export interface ICriticalWellbeingEventInput {
  eventType: CriticalWellbeingEventType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

/** Feeds Digital Twin's `behavior` slot as an ADDITIONAL input
 * alongside ai-core's own Risk/Trust trend (Sprint 25) — not a
 * replacement. See digital-twin.service.ts's own composition logic
 * for how the two are combined. */
export interface IBehavioralSnapshotSummary {
  windowDays: number;
  averageDailyScreenMinutes: number;
  averagePickups: number;
  averageNightUsageMinutes: number;
  totalBlockedAttempts: number;
  daysWithData: number;
}

/** Sprint 14 (Behavioral Intelligence Engine) — this child's OWN
 * rolling baseline, computed from THEIR OWN recent history, never a
 * fixed threshold shared across children. `daysOfHistory` is exposed
 * explicitly so callers can judge confidence — a baseline computed
 * from 2 days of history is real but weak; from 14 days, strong.
 * Never invented for a child with zero history (see
 * BaselineCalculatorService.compute's own null-return case). */
export interface IChildBaseline {
  childId: string;
  daysOfHistory: number;
  averageScreenMinutes: number;
  averageGamingMinutes: number;
  averageSocialMinutes: number;
  averageEducationMinutes: number;
  averageEntertainmentMinutes: number;
  averageNightUsageMinutes: number;
  averagePickups: number;
}

/** Sprint 14 — the closed set of pattern codes this engine can ever
 * emit. Closed (not an open string) so a caller can exhaustively
 * handle every case — same discipline as CriticalWellbeingEventType
 * above. WEEKEND_SHIFT is deliberately never treated as a risk
 * signal anywhere in this engine (see PatternDetectionService's own
 * docstring) — it exists so a parent-facing UI can explain a
 * deviation as normal, not alarming. */
export type BehaviorPatternCode =
  | 'EXCESSIVE_USAGE'
  | 'NIGHT_USAGE_INCREASE'
  | 'GAMING_SPIKE'
  | 'SOCIAL_SPIKE'
  | 'STUDY_DECLINE'
  | 'FRAGMENTED_ATTENTION'
  | 'LONG_SESSION'
  | 'WEEKEND_SHIFT'
  | 'HEALTHY_PATTERN';

/** Sprint 14 — one detected pattern, fully explainable per the
 * brief's own explicit requirement ("Night usage increased 180% for
 * 4 consecutive days... NOT 'AI says the child is behaving badly'").
 * `confidence` is a plain 0-1 statistical score (baseline + deviation
 * + duration + recurrence), never an LLM-derived number — see
 * AnomalyDetectionService's own docstring for the exact, inspectable
 * formula. */
export interface IDetectedPattern {
  code: BehaviorPatternCode;
  confidence: number;
  explanation: string;
  isPositive: boolean;
}

/** Sprint 14 — the parent-facing structured insight (brief's own
 * "Deterministic Behavioral Engine -> Structured Insight -> Optional
 * AI explanation" pipeline). `humanSummary` is built from a plain
 * template, NOT an LLM call — the brief is explicit that not every
 * insight should cost an AI request. `recommendation` is similarly
 * deterministic, drawn from a fixed map of pattern code to
 * suggestion text. */
export interface IWellbeingInsight {
  childId: string;
  date: string;
  humanSummary: string;
  baselineDeviationPercent: number | null;
  patterns: IDetectedPattern[];
  recommendation: string | null;
}
