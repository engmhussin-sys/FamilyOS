/**
 * IDEMPOTENCY KEY COMPOSITION — CONTEXT §3 principle 6, docs/04 §5.3.
 *
 * Two rules, both load-bearing:
 *
 *   1. DETERMINISTIC, NEVER RANDOM. The device regenerates the same key after a
 *      reboot, so a queued-but-unacknowledged event replayed tomorrow collides
 *      with yesterday's row instead of granting a second reward.
 *   2. THE DEFENCE IS THE DATABASE, NOT THIS FILE. These functions only compose
 *      the string; `domain_events (family_id, idempotency_key)` and
 *      `rewards_ledger_entries (child_id, idempotency_key)` are what actually
 *      make the grant happen once. A2 §7.3 measured what a code-level "does it
 *      already exist?" check does under 8 concurrent identical requests: it
 *      grants 8 rewards.
 *
 * The key is derived SERVER-SIDE from server-known values (the child resolved
 * from the device token, the localDate, the source id). A device cannot choose
 * its own idempotency key, because a device that could choose it could also
 * choose a fresh one per retry and mint unlimited rewards.
 */
import type { CompletionKind } from './completion-event';
import type { DomainEventType } from './event-types';

/** `VARCHAR(80)` in `domain_events.idempotency_key` — docs/05 §3.3. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 80;

function clamp(key: string): string {
  return key.length <= IDEMPOTENCY_KEY_MAX_LENGTH ? key : key.slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);
}

/** Short uuid form used inside keys so the 80-char budget is not blown. */
function short(id: string): string {
  return id.replace(/-/g, '').slice(0, 12);
}

export interface CompletionKeyParts {
  readonly childId: string;
  readonly completionKind: CompletionKind;
  readonly sourceId: string;
  readonly localDate: string;
  readonly milestone?: string | number;
}

/**
 * The composition table from docs/04 §5.3, in code.
 *
 * | event                     | key                                              |
 * |---------------------------|--------------------------------------------------|
 * | HABIT_COMPLETED           | child:{c}:habit:{habitId}:{localDate}            |
 * | TASK_COMPLETED            | child:{c}:task:{occurrenceId}                    |
 * | STREAK_ACHIEVED           | child:{c}:streak:{type}:{length}                 |
 * | DAILY_GOAL_COMPLETED      | child:{c}:dailygoal:{goalType}:{localDate}       |
 * | HYDRATION_GOAL_COMPLETED  | child:{c}:hydration:{localDate}                  |
 * | ACTIVITY_GOAL_COMPLETED   | child:{c}:activity:{localDate}                   |
 * | EDUCATION_PROGRESS        | child:{c}:edu:{goalId}:{milestone}               |
 * | MEMORIZATION_COMPLETED    | child:{c}:memorization:{progressId}              |
 * | REWARD_GRANTED            | child:{c}:reward:{sourceType}:{sourceId}         |
 * | SCREEN_TIME_THRESHOLD     | child:{c}:threshold:{percent}:{localDate}        |
 * | DEVICE_PAIRED             | device:{d}:paired                                |
 * | IMPORTANT_SAFETY_EVENT    | device:{d}:safety:{kind}:{hourBucket}            |
 */
export function composeIdempotencyKey(
  type: DomainEventType,
  parts: {
    childId?: string;
    deviceId?: string;
    sourceId?: string;
    localDate?: string;
    milestone?: string | number;
    kind?: string;
    hourBucket?: string;
    sourceType?: string;
  },
): string {
  const c = parts.childId ? short(parts.childId) : 'unknown';
  const d = parts.deviceId ? short(parts.deviceId) : 'unknown';
  const src = parts.sourceId ? short(parts.sourceId) : 'none';
  const day = parts.localDate ?? 'nodate';

  switch (type) {
    case 'HABIT_COMPLETED':
      return clamp(`child:${c}:habit:${src}:${day}`);
    case 'TASK_COMPLETED':
      return clamp(`child:${c}:task:${src}`);
    case 'STREAK_ACHIEVED':
      return clamp(`child:${c}:streak:${parts.kind ?? 'habits'}:${parts.milestone ?? 0}`);
    case 'DAILY_GOAL_COMPLETED':
      return clamp(`child:${c}:dailygoal:${parts.kind ?? 'default'}:${day}`);
    case 'HYDRATION_GOAL_COMPLETED':
      return clamp(`child:${c}:hydration:${day}`);
    case 'ACTIVITY_GOAL_COMPLETED':
      return clamp(`child:${c}:activity:${day}`);
    case 'EDUCATION_PROGRESS':
      return clamp(`child:${c}:edu:${src}:${parts.milestone ?? 0}`);
    case 'MEMORIZATION_COMPLETED':
      return clamp(`child:${c}:memorization:${src}`);
    case 'REWARD_GRANTED':
      return clamp(`child:${c}:reward:${parts.sourceType ?? 'unknown'}:${src}`);
    case 'SCREEN_TIME_THRESHOLD':
      return clamp(`child:${c}:threshold:${parts.milestone ?? 0}:${day}`);
    case 'DEVICE_PAIRED':
      return clamp(`device:${d}:paired`);
    case 'IMPORTANT_SAFETY_EVENT':
      return clamp(`device:${d}:safety:${parts.kind ?? 'unknown'}:${parts.hourBucket ?? day}`);
    default: {
      // Forward-compatible fallback: a type added to the catalogue without a
      // rule here still gets a deterministic key rather than a random one.
      const exhaustive: string = type;
      return clamp(`child:${c}:${exhaustive.toLowerCase()}:${src}:${day}`);
    }
  }
}

/**
 * The key used for the DERIVED `REWARD_GRANTED` event. Derived from the
 * ORIGINATING event's key, so a redelivered completion produces the same
 * reward-granted key and the outbox's own unique constraint absorbs it.
 */
export function composeRewardGrantedKey(sourceIdempotencyKey: string): string {
  return clamp(`granted:${sourceIdempotencyKey}`);
}

/** UTC calendar date. Used when a device supplies no `localDate`/timezone. */
export function utcLocalDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toISOString().slice(0, 10);
}
