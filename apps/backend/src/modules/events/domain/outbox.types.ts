import type { DomainEventType } from '../../../shared/events/event-types';

/** A message as the relay claims it out of `outbox_messages`. */
export interface ClaimedOutboxMessage {
  readonly id: string;
  readonly familyId: string;
  readonly domainEventId: string;
  readonly eventType: DomainEventType;
  readonly destination: string;
  readonly payload: Record<string, unknown>;
  readonly attemptCount: number;
}

/**
 * What a producer hands the writer. Note what is NOT here: `familyId` is not a
 * parameter. It comes from the ambient tenant context via `tenantIdForWrite()`,
 * so a producer cannot write an event into another family's stream even by
 * mistake.
 */
export interface DomainEventDraft {
  readonly type: DomainEventType;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly childId: string | null;
  readonly deviceId: string | null;
  readonly idempotencyKey: string;
  readonly clientEventId: string | null;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
  readonly traceId: string | null;
  readonly schemaVersion?: number;
}

export interface WriteEventOutcome {
  /** False when the idempotency key (or clientEventId) already existed. */
  readonly created: boolean;
  /** The existing row's id on a duplicate, the new row's id otherwise. */
  readonly domainEventId: string | null;
}

export const OUTBOX_RELAY_DEFAULTS = {
  /** docs/04 §5.4: "polls domain_event every 2s". */
  pollIntervalMs: 2_000,
  batchSize: 200,
  /** docs/04 §5.4: "after 8 attempts -> DEAD + alert". */
  maxAttempts: 8,
  /** A lock older than this is treated as a dead worker's. */
  staleLockSeconds: 120,
} as const;
