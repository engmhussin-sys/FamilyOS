/**
 * THE EVENT ENVELOPE — docs/04-System-Architecture.md §5.2.
 *
 * Binding rules from that section, implemented here rather than described:
 *
 *   1. `familyId`/`childId` are NOT part of the wire envelope. They are derived
 *      from the verified JWT (CONTEXT §3 principle 3). `WireEventEnvelope`
 *      below is what a device may send; `DomainEventEnvelope` is what exists
 *      after the server has stamped the tenant onto it.
 *   2. `receivedAt` is always server-filled. Any client value is discarded.
 *   3. `idempotencyKey` is DETERMINISTIC, not random — see `idempotency.ts`.
 *      Regenerating it on the device after a reboot must give the same string.
 *   4. `clientEventId` is `{deviceId-short}:seq:{monotonic}` so gaps in a
 *      device's sequence are detectable.
 *   5. `schemaVersion` allows evolution: the server accepts the newest two.
 */
import type { DomainEventType } from './event-types';

export const ENVELOPE_VERSION = '1' as const;

/** The two `schemaVersion` values this server accepts (docs/04 §5.2 rule 5). */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

export type EventPriority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

/** What a device puts on the wire. Contains no tenant identity of any kind. */
export interface WireEventEnvelope<TPayload = unknown> {
  /** `{deviceId-short}:seq:{monotonic}` — the device's own queue key. */
  readonly clientEventId: string;
  readonly type: DomainEventType | string;
  /** ISO-8601 with offset, from the device clock. Validated for skew. */
  readonly occurredAt: string;
  readonly schemaVersion?: number;
  /** IANA zone, e.g. `Africa/Cairo`. Used to derive `localDate` honestly. */
  readonly timezone?: string;
  /** YYYY-MM-DD in the child's local time. Falls back to UTC date if absent. */
  readonly localDate?: string;
  readonly agentVersion?: string;
  readonly priority?: EventPriority;
  readonly payload: TPayload;
}

/**
 * The envelope after ingestion. Everything the mission brief asks for:
 * id, type, version, familyId, childId?, deviceId?, occurredAt, receivedAt,
 * idempotencyKey, payload, traceId.
 */
export interface DomainEventEnvelope<TPayload = unknown> {
  readonly envelopeVersion: typeof ENVELOPE_VERSION;
  /** Server-generated UUID. Equal to `DomainEvent.id`. */
  readonly id: string;
  readonly type: DomainEventType;
  readonly schemaVersion: number;
  /** Always present. Always from the verified token or a server-derived row. */
  readonly familyId: string;
  readonly childId: string | null;
  readonly deviceId: string | null;
  /** What the aggregate is (`HabitOccurrence`, `RewardGrant`, ...). */
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Device clock. */
  readonly occurredAt: string;
  /** Server clock — authoritative. Never taken from the client. */
  readonly receivedAt: string;
  readonly idempotencyKey: string;
  readonly clientEventId: string | null;
  /** Correlation id of the originating HTTP request, for tracing. */
  readonly traceId: string | null;
  readonly payload: TPayload;
}
