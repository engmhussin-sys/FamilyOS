/**
 * THE DOMAIN EVENT CATALOGUE — CONTEXT.md §5, docs/04-System-Architecture.md §5.3.
 *
 * This file is the single source of truth for "which domain events exist".
 * It is deliberately framework-free: no NestJS, no Prisma, no decorators, no
 * imports at all. That is what lets `packages/shared-types` re-export it to the
 * admin dashboard (TypeScript) and lets a future OpenAPI/Dart codegen step take
 * it as input without dragging the backend's dependency tree along.
 *
 * A NOTE ON THE 10 vs 12: CONTEXT §5 names ten events. `docs/06-API-Architecture.md
 * §6.0` and `docs/05-Database-Architecture.md §3.3` additionally require
 * `TASK_COMPLETED` and `MEMORIZATION_COMPLETED` to be members of the
 * `CompletionEvent` set, because CONTEXT §4 says Tasks and Faith/Education must
 * flow through the SAME completion path as Habits rather than getting their own
 * engine. Leaving them out would have forced a second ingestion path the first
 * time Tasks shipped — which is the exact duplication REUSE FIRST forbids. They
 * are therefore in the catalogue, marked as such in the table below.
 */

export const DOMAIN_EVENT_TYPES = [
  // -- CONTEXT §5, verbatim --
  'HABIT_COMPLETED',
  'STREAK_ACHIEVED',
  'DAILY_GOAL_COMPLETED',
  'HYDRATION_GOAL_COMPLETED',
  'ACTIVITY_GOAL_COMPLETED',
  'EDUCATION_PROGRESS',
  'REWARD_GRANTED',
  'DEVICE_PAIRED',
  'SCREEN_TIME_THRESHOLD',
  'IMPORTANT_SAFETY_EVENT',
  // -- required by docs/06 §6.0 + docs/05 §3.3 as CompletionEvent members --
  'TASK_COMPLETED',
  'MEMORIZATION_COMPLETED',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

const DOMAIN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(DOMAIN_EVENT_TYPES);

export function isDomainEventType(value: string): value is DomainEventType {
  return DOMAIN_EVENT_TYPE_SET.has(value);
}

/**
 * The subset of the catalogue that carries a `CompletionEvent` payload.
 *
 * This set — not a chain of `if (source === 'habit')` branches — is what makes
 * "one completion path, four producers" real. `REWARD_GRANTED`, `DEVICE_PAIRED`,
 * `SCREEN_TIME_THRESHOLD` and `IMPORTANT_SAFETY_EVENT` are deliberately NOT in
 * it: they are not completions and must not reach the Rewards Engine.
 */
export const COMPLETION_EVENT_TYPES = [
  'HABIT_COMPLETED',
  'TASK_COMPLETED',
  'DAILY_GOAL_COMPLETED',
  'HYDRATION_GOAL_COMPLETED',
  'ACTIVITY_GOAL_COMPLETED',
  'EDUCATION_PROGRESS',
  'MEMORIZATION_COMPLETED',
  'STREAK_ACHIEVED',
] as const;

export type CompletionEventType = (typeof COMPLETION_EVENT_TYPES)[number];

const COMPLETION_EVENT_TYPE_SET: ReadonlySet<string> = new Set(COMPLETION_EVENT_TYPES);

export function isCompletionEventType(value: string): value is CompletionEventType {
  return COMPLETION_EVENT_TYPE_SET.has(value);
}

/**
 * Which event types a DEVICE is allowed to originate through
 * `POST /events/batch`. `REWARD_GRANTED` is the important exclusion: it is a
 * DERIVED event, produced only by the Rewards Engine after a real, non-duplicate
 * grant. A device that could post `REWARD_GRANTED` directly would be able to
 * manufacture a notification for a reward that never happened — which is
 * precisely the failure CONTEXT §5's "no grant ⇒ no notification" rule exists to
 * prevent. `STREAK_ACHIEVED` is excluded for the same reason (derived by the
 * streak consumer from real completion rows, never claimed by the client).
 */
export const DEVICE_INGESTIBLE_EVENT_TYPES = [
  'HABIT_COMPLETED',
  'TASK_COMPLETED',
  'DAILY_GOAL_COMPLETED',
  'HYDRATION_GOAL_COMPLETED',
  'ACTIVITY_GOAL_COMPLETED',
  'EDUCATION_PROGRESS',
  'MEMORIZATION_COMPLETED',
  'SCREEN_TIME_THRESHOLD',
  'IMPORTANT_SAFETY_EVENT',
] as const;

export type DeviceIngestibleEventType = (typeof DEVICE_INGESTIBLE_EVENT_TYPES)[number];

const DEVICE_INGESTIBLE_SET: ReadonlySet<string> = new Set(DEVICE_INGESTIBLE_EVENT_TYPES);

export function isDeviceIngestibleEventType(value: string): value is DeviceIngestibleEventType {
  return DEVICE_INGESTIBLE_SET.has(value);
}

/** Machine-readable form of docs/04 §5.3's catalogue table. */
export interface DomainEventCatalogueEntry {
  readonly type: DomainEventType;
  /** Which module is allowed to emit it. */
  readonly producer: string;
  /** Registered consumers, in the order the bus invokes them. */
  readonly consumers: readonly string[];
  /** The template the deterministic idempotency key is built from. */
  readonly idempotencyKeyTemplate: string;
  /** True when `payload` is a `CompletionEvent`. */
  readonly carriesCompletionEvent: boolean;
  /** True when a paired device may originate it over the wire. */
  readonly deviceIngestible: boolean;
}

export const DOMAIN_EVENT_CATALOGUE: Readonly<Record<DomainEventType, DomainEventCatalogueEntry>> = {
  HABIT_COMPLETED: {
    type: 'HABIT_COMPLETED',
    producer: 'Habits (child device / Child App)',
    consumers: ['RewardsCompletionConsumer', 'StreakDetectionConsumer'],
    idempotencyKeyTemplate: 'child:{childId}:habit:{habitId}:{localDate}',
    carriesCompletionEvent: true,
    deviceIngestible: true,
  },
  TASK_COMPLETED: {
    type: 'TASK_COMPLETED',
    producer: 'Tasks',
    consumers: ['RewardsCompletionConsumer'],
    idempotencyKeyTemplate: 'child:{childId}:task:{sourceId}',
    carriesCompletionEvent: true,
    deviceIngestible: true,
  },
  STREAK_ACHIEVED: {
    type: 'STREAK_ACHIEVED',
    producer: 'StreakDetectionConsumer (derived — never client-originated)',
    consumers: ['RewardsCompletionConsumer'],
    idempotencyKeyTemplate: 'child:{childId}:streak:{streakType}:{length}',
    carriesCompletionEvent: true,
    deviceIngestible: false,
  },
  DAILY_GOAL_COMPLETED: {
    type: 'DAILY_GOAL_COMPLETED',
    producer: 'Habits/Tasks (aggregated on device)',
    consumers: ['RewardsCompletionConsumer'],
    idempotencyKeyTemplate: 'child:{childId}:dailygoal:{goalType}:{localDate}',
    carriesCompletionEvent: true,
    deviceIngestible: true,
  },
  HYDRATION_GOAL_COMPLETED: {
    type: 'HYDRATION_GOAL_COMPLETED',
    producer: 'Health',
    consumers: ['RewardsCompletionConsumer'],
    idempotencyKeyTemplate: 'child:{childId}:hydration:{localDate}',
    carriesCompletionEvent: true,
    deviceIngestible: true,
  },
  ACTIVITY_GOAL_COMPLETED: {
    type: 'ACTIVITY_GOAL_COMPLETED',
    producer: 'Health',
    consumers: ['RewardsCompletionConsumer'],
    idempotencyKeyTemplate: 'child:{childId}:activity:{localDate}',
    carriesCompletionEvent: true,
    deviceIngestible: true,
  },
  EDUCATION_PROGRESS: {
    type: 'EDUCATION_PROGRESS',
    producer: 'Education/Faith (one engine — CONTEXT §4)',
    consumers: ['RewardsCompletionConsumer'],
    idempotencyKeyTemplate: 'child:{childId}:edu:{sourceId}:{milestone}',
    carriesCompletionEvent: true,
    deviceIngestible: true,
  },
  MEMORIZATION_COMPLETED: {
    type: 'MEMORIZATION_COMPLETED',
    producer: 'Education/Faith',
    consumers: ['RewardsCompletionConsumer'],
    idempotencyKeyTemplate: 'child:{childId}:memorization:{sourceId}',
    carriesCompletionEvent: true,
    deviceIngestible: true,
  },
  REWARD_GRANTED: {
    type: 'REWARD_GRANTED',
    producer: 'RewardsCompletionConsumer (derived — emitted ONLY after a real grant)',
    consumers: ['NotificationRewardConsumer'],
    idempotencyKeyTemplate: 'child:{childId}:reward:{sourceType}:{sourceId}',
    carriesCompletionEvent: false,
    deviceIngestible: false,
  },
  DEVICE_PAIRED: {
    type: 'DEVICE_PAIRED',
    producer: 'Pairing',
    consumers: ['NotificationRewardConsumer (informational — not built this sprint)'],
    idempotencyKeyTemplate: 'device:{deviceId}:paired',
    carriesCompletionEvent: false,
    deviceIngestible: false,
  },
  SCREEN_TIME_THRESHOLD: {
    type: 'SCREEN_TIME_THRESHOLD',
    producer: 'DigitalWellbeing (child device)',
    consumers: ['(none registered this sprint — recorded to domain_events only)'],
    idempotencyKeyTemplate: 'child:{childId}:threshold:{thresholdPercent}:{localDate}',
    carriesCompletionEvent: false,
    deviceIngestible: true,
  },
  IMPORTANT_SAFETY_EVENT: {
    type: 'IMPORTANT_SAFETY_EVENT',
    producer: 'Devices/Agent',
    consumers: ['(none registered this sprint — recorded to domain_events only)'],
    idempotencyKeyTemplate: 'device:{deviceId}:safety:{kind}:{hourBucket}',
    carriesCompletionEvent: false,
    deviceIngestible: true,
  },
};
