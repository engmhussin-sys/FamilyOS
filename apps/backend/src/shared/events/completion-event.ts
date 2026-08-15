/**
 * `CompletionEvent` — THE SHARED PAYLOAD CONTRACT.
 *
 * docs/05-Database-Architecture.md §3.3 states the architectural decision this
 * file implements, and states it as a decision rather than a suggestion:
 *
 *   > `CompletionEvent` is NOT a table and NOT a standalone model. It is the
 *   > SHAPE of `DomainEvent.payload` when `eventType` is one of the completion
 *   > types. The discriminator is `completionKind`.
 *
 * WHY IT MATTERS (CONTEXT §3 principle 1, REUSE FIRST): without this contract,
 * "Habits grants points", "Tasks grants points", "Health grants points" and
 * "Education grants points" become four engines that each re-derive
 * idempotency, each decide their own point values, and each drift apart. With
 * it, `Rewards` consumes ONE payload shape and does not know — cannot know —
 * which module produced it. That is gate G5's exit criterion in
 * `09-Project-Plan.md §6.2`, expressed in the type system.
 *
 * The practical test of whether this is real: adding "Tasks" tomorrow must
 * require ZERO changes to the Rewards Engine. With a discriminated union on
 * `completionKind`, it does.
 */

export type CompletionKind =
  | 'HABIT'
  | 'TASK'
  | 'HEALTH_GOAL'
  | 'LEARNING_SESSION'
  | 'FAITH_SESSION'
  | 'STREAK'
  // F4: a verified achievement against a parent-authored RewardProgram. It is
  // a completion of a different granularity, exactly like STREAK, and routing
  // it through this same contract is what let the Rewards Engine pay for a
  // program without a single line changing inside it.
  | 'ACHIEVEMENT';

export type CompletionSourceType =
  | 'HabitOccurrence'
  | 'TaskOccurrence'
  | 'HealthMetric'
  | 'HydrationLog'
  | 'ActivityLog'
  | 'LearningSession'
  | 'MemorizationProgress'
  | 'StreakMilestone'
  | 'AchievementRequest';

export type CompletionVerifiedBy = 'SELF' | 'PARENT' | 'SENSOR' | 'SYSTEM';

/**
 * The contract itself. Field-for-field the shape published in
 * `05-Database-Architecture.md §3.3`, with two deliberate differences, both
 * stated here rather than hidden:
 *
 *   1. `childId` is NOT part of the wire payload a device sends. The device
 *      cannot name a child — that is CONTEXT §3 principle 3. It is filled
 *      server-side from the device's paired child before the payload is
 *      persisted, so the STORED payload matches the published contract exactly
 *      while the ACCEPTED payload cannot be used to attribute a completion to
 *      another child. `WireCompletionEvent` below is the accepted subset.
 *   2. `completionKind` gains `'STREAK'`. A streak milestone is a completion of
 *      a different granularity, and routing it through the same contract is
 *      what keeps `STREAK_ACHIEVED` from needing its own reward path.
 */
export interface CompletionEvent {
  readonly schemaVersion: 1;
  /** The discriminator. Rewards branches on nothing else. */
  readonly completionKind: CompletionKind;
  /** Server-derived from the device token. Never client-supplied. */
  readonly childId: string;
  /** Server-derived. `null` when the completion came from the parent app. */
  readonly deviceId: string | null;
  readonly sourceType: CompletionSourceType;
  /** The aggregate this completion is about (habitId, sessionId, ...). */
  readonly sourceId: string;
  /** YYYY-MM-DD in the family's local date. The daily de-duplication key. */
  readonly localDate: string;
  /** ISO-8601, as reported by the device. */
  readonly occurredAt: string;
  /** Deterministic. Equal to the enclosing envelope's `idempotencyKey`. */
  readonly idempotencyKey: string;
  /** A HINT ONLY. The Rewards Engine decides the real value from Reward Rules. */
  readonly pointsHint: number | null;
  readonly verifiedBy: CompletionVerifiedBy;
  /** ≤ 2 KB, no PII. */
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

/**
 * What a device is actually allowed to put on the wire: the contract minus
 * every field the server owns. `childId`, `deviceId` and `idempotencyKey` are
 * derived server-side; a device that sends them has them ignored, and a device
 * that sends a `childId` belonging to a different child gains nothing, because
 * the value is never read.
 */
export type WireCompletionEvent = Omit<
  CompletionEvent,
  'childId' | 'deviceId' | 'idempotencyKey' | 'schemaVersion'
> & { readonly schemaVersion?: 1 };

export function isCompletionEventPayload(payload: unknown): payload is CompletionEvent {
  if (payload === null || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.completionKind === 'string' &&
    typeof p.childId === 'string' &&
    typeof p.sourceId === 'string' &&
    typeof p.localDate === 'string' &&
    typeof p.idempotencyKey === 'string'
  );
}

/**
 * The one place a `completionKind` is mapped to the Reward Rules "engine" name
 * the existing `RewardRule.triggerEngine` column already uses. Adding a fifth
 * producer is one line HERE, and nothing anywhere else.
 *
 * The values are the engine names already present in this codebase
 * (`habit-builder`, `health`, `learning`, `faith`) — this map exists to reuse
 * them, not to invent a parallel vocabulary.
 */
export const COMPLETION_KIND_TO_REWARD_ENGINE: Readonly<Record<CompletionKind, string>> = {
  HABIT: 'habit-builder',
  TASK: 'smart-tasks',
  HEALTH_GOAL: 'health',
  LEARNING_SESSION: 'learning',
  FAITH_SESSION: 'faith',
  STREAK: 'habit-builder',
  // F4 — THE ONE LINE. F3's own docstring promised "adding a fifth producer is
  // one line in COMPLETION_KIND_TO_REWARD_ENGINE and zero lines in the
  // consumer". This is that line, and that promise held: `reward-program` is
  // the `triggerEngine` value the materialised companion RewardRule rows carry,
  // so `evaluateRewardRules` matches them with no change either.
  ACHIEVEMENT: 'reward-program',
};
