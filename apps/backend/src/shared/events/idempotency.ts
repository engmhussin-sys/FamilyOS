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
 *
 * B1 (PA-B-003) — WHAT "SERVER-KNOWN" NOW ACTUALLY MEANS. Until B1 that
 * paragraph was true of every input except one: `localDate` arrived from the
 * child's device, shape-validated and nothing more, and five of the key shapes
 * below embed it. Phase A verified the split by reading this table; so did this
 * sprint, before touching anything:
 *
 *   EXPLOITABLE — the key carries `{day}`, so a chosen day was a chosen key:
 *     HABIT_COMPLETED · DAILY_GOAL_COMPLETED · HYDRATION_GOAL_COMPLETED ·
 *     ACTIVITY_GOAL_COMPLETED · SCREEN_TIME_THRESHOLD
 *   STRUCTURALLY IMMUNE — no day component exists in the key at all:
 *     EDUCATION_PROGRESS (`{milestone}`) · MEMORIZATION_COMPLETED (`{src}`) ·
 *     TASK_COMPLETED (`{src}`) · STREAK_ACHIEVED (`{kind}:{milestone}`) ·
 *     ACHIEVEMENT_VERIFIED (`{src}:x{multiplierBps}`, and the multiplier is
 *     FROZEN onto the row rather than recomputed)
 *
 * `localDate` is now a SERVER OUTPUT everywhere: `getBusinessDate(occurredAt,
 * Family.timezone)` from `src/common/time/family-date.ts`. No caller may pass a
 * client-supplied value into `parts.localDate`. The five shapes above are
 * replay-safe only while that holds, and that is the whole of the fix.
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

    // -- F4 (Smart Learning & Reward Engine) ---------------------------------
    case 'REWARD_PROGRAM_CREATED':
      return clamp(`program:${src}:created`);
    case 'ACHIEVEMENT_REQUESTED':
      return clamp(`child:${c}:achvreq:${src}:${parts.milestone ?? 1}`);
    case 'ACHIEVEMENT_VERIFIED':
      // THE MULTIPLIER IS PART OF THE KEY — the brief's explicit requirement.
      // This is only replay-safe because `multiplierBps` is FROZEN onto the
      // achievement row at verification time and read back on every subsequent
      // attempt rather than recomputed from "the streak as of now". See
      // src/shared/rewards/streak-multiplier.ts for why that ordering matters.
      return clamp(`child:${c}:achv:${src}:x${parts.milestone ?? 10000}`);
    case 'ACHIEVEMENT_REJECTED':
      return clamp(`child:${c}:achvrej:${src}:${parts.milestone ?? 1}`);
    case 'QURAN_ACHIEVEMENT_COMPLETED':
      return clamp(`child:${c}:quran:${src}`);
    case 'LEARNING_GOAL_COMPLETED':
      return clamp(`child:${c}:goaldone:${src}`);
    case 'BADGE_EARNED':
      return clamp(`child:${c}:badge:${src}`);
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

/**
 * PHASE C (`PC-B-006`) — the key that makes the REWARDS timeline entry
 * exactly-once, enforced by `life_timeline_events_reward_source_key_uq`
 * (migration 0010).
 *
 * Derived from the ORIGINATING trigger's key by the same rule as
 * `composeRewardGrantedKey` above and for the same reason: every redelivery of
 * one business event must compose a BYTE-IDENTICAL key, so the second INSERT
 * collides instead of adding a second curated moment to a family's timeline.
 *
 * DISTINCT PREFIX FROM `composeRewardGrantedKey`, deliberately. The two keys
 * live in different tables and could never collide with each other, but they
 * are read by humans during an incident, and `granted:` meaning one thing in a
 * `domain_events` row and another in a timeline row is exactly the ambiguity
 * that makes an incident longer.
 *
 * There is NO keyless fallback. A caller with no trigger key writes no
 * `sourceKey` at all, which leaves the row outside the PARTIAL index and
 * preserves pre-Phase-C behaviour exactly. A synthesised constant would be far
 * worse than nothing: it would collide across unrelated rewards and suppress
 * every future timeline entry for that child — the same trap B9 called out for
 * notification keys.
 */
export function composeRewardTimelineKey(sourceIdempotencyKey: string): string {
  return clamp(`timeline:reward:${sourceIdempotencyKey}`);
}

/**
 * REMOVED IN B1: `utcLocalDate(iso)`.
 *
 * It was the fallback used when a device sent no `localDate`, and it was the
 * second half of PA-B-001: it answered "which day?" in UTC, which is the wrong
 * day for three hours out of every twenty-four in both launch markets. Leaving
 * it exported would have left a one-import path back to the bug.
 *
 * Its replacement is `getBusinessDate(instant, timeZone)` in
 * `src/common/time/family-date.ts`, which requires a timezone and therefore
 * cannot be called by accident.
 */

