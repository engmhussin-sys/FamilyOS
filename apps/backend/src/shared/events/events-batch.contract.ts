/**
 * `POST /events/batch` — THE WIRE CONTRACT.
 * docs/06-API-Architecture.md §6.1–§6.6.
 *
 * This file is what the Android agent's `EventSyncWorker` codes against, so
 * every constant a client needs to make a correct decision is exported from
 * here rather than being buried in a controller.
 */
import type { WireEventEnvelope } from './event-envelope';

/** docs/06 §6.2 — the whole batch is rejected above this. */
export const MAX_EVENTS_PER_BATCH = 200;

/**
 * docs/06 §6.2 — batch-level clock skew. |deviceTime − serverTime| above this
 * rejects the ENTIRE batch with `DEVICE_CLOCK_SKEW`.
 */
export const MAX_BATCH_CLOCK_SKEW_MS = 10 * 60 * 1000;

/**
 * PER-EVENT future tolerance. An `occurredAt` further ahead than this is a
 * clock that is wrong or a device that is lying; either way the event is
 * rejected individually, not the batch.
 */
export const MAX_EVENT_FUTURE_MS = 5 * 60 * 1000;

/**
 * PER-EVENT past tolerance: 48 hours.
 *
 * DELIBERATE DIVERGENCE, STATED: docs/06 §6.2 says 7 days. The Sprint F3 brief
 * specifies 48h ("reject events older than 48h or more than 5 minutes in the
 * future") and it is the tighter, safer number — a shorter replay window is
 * strictly less exploitable, and CONTEXT §6 has devices syncing every 15
 * minutes, so 48h already tolerates a two-day offline stretch. Widening it back
 * to 7 days is a one-constant change; narrowing it later would be a breaking
 * change for queued clients, which is why the tighter value is the default now.
 */
export const MAX_EVENT_AGE_MS = 48 * 60 * 60 * 1000;

/** docs/06 §9.1, category `EVENTS`: 12 batches per hour, keyed by deviceId. */
export const EVENTS_RATE_LIMIT = { limit: 12, ttlMs: 60 * 60 * 1000 } as const;

/** Batch-level `Idempotency-Key` replay window in Redis (docs/06 §6.6 layer 2). */
export const BATCH_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface IngestEventsRequest {
  /** The device's own clock at send time. Checked against the server clock. */
  readonly deviceTime: string;
  readonly events: readonly WireEventEnvelope[];
}

/**
 * docs/06 §6.4 — the pruning contract, restated so a client author cannot miss
 * it:
 *   ACCEPTED  -> delete from the local queue (the server owns it now)
 *   DUPLICATE -> delete from the local queue (NOT an error — it is the
 *                acknowledgement you needed after a network timeout)
 *   REJECTED  -> dead-letter it if the code is permanent, retry otherwise
 *   ABSENT from results[] -> KEEP IT. Always the safe assumption.
 */
export type EventResultStatus = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';

export type EventRejectionCode =
  | 'EVENT_CLOCK_SKEW'
  | 'EVENT_UNKNOWN_TYPE'
  | 'EVENT_SCHEMA_MISMATCH'
  | 'EVENT_TYPE_NOT_DEVICE_INGESTIBLE'
  | 'EVENT_PAYLOAD_INVALID'
  | 'EVENT_SOURCE_NOT_FOUND'
  | 'EVENT_INTERNAL_ERROR';

/** Rejection codes a client must NOT retry — retrying can never help. */
export const PERMANENT_REJECTION_CODES: readonly EventRejectionCode[] = [
  'EVENT_CLOCK_SKEW',
  'EVENT_UNKNOWN_TYPE',
  'EVENT_SCHEMA_MISMATCH',
  'EVENT_TYPE_NOT_DEVICE_INGESTIBLE',
  'EVENT_PAYLOAD_INVALID',
];

export interface EventEffects {
  /** True only when a NEW reward row was created. Never true for a duplicate. */
  readonly rewardGranted?: boolean;
  readonly points?: number;
  readonly newBalance?: number;
}

export interface EventResult {
  readonly clientEventId: string;
  readonly status: EventResultStatus;
  /** Server-assigned `domain_events.id`, present on ACCEPTED. */
  readonly eventId?: string;
  readonly effects?: EventEffects;
  readonly errorCode?: EventRejectionCode;
  readonly messageAr?: string;
}

export interface IngestEventsData {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: number;
  /** Authoritative server clock — a device with drift can correct itself. */
  readonly serverTime: string;
  readonly results: readonly EventResult[];
}

export interface IngestEventsResponse {
  readonly data: IngestEventsData;
  readonly meta: { readonly requestId: string };
}

/** Batch-level failures. These are HTTP errors, not per-item results. */
export type BatchErrorCode =
  | 'EVENT_BATCH_TOO_LARGE'
  | 'DEVICE_CLOCK_SKEW'
  | 'AUTHZ_DEVICE_SCOPE_VIOLATION';

/**
 * Arabic messages for per-item rejections. CONTEXT §3 principle 7 (NO PUNITIVE
 * UX) applies to a child-facing surface; these are agent-facing diagnostics, so
 * they are neutral and factual rather than encouraging or accusing.
 */
export const REJECTION_MESSAGE_AR: Readonly<Record<EventRejectionCode, string>> = {
  EVENT_CLOCK_SKEW: 'وقت الحدث غير منطقي مقارنة بوقت الخادم.',
  EVENT_UNKNOWN_TYPE: 'نوع الحدث غير معروف لهذا الإصدار من الخادم.',
  EVENT_SCHEMA_MISMATCH: 'إصدار مخطط الحدث غير مدعوم.',
  EVENT_TYPE_NOT_DEVICE_INGESTIBLE: 'هذا النوع من الأحداث لا يُقبل من الجهاز.',
  EVENT_PAYLOAD_INVALID: 'حمولة الحدث غير مكتملة أو غير صالحة.',
  EVENT_SOURCE_NOT_FOUND: 'المصدر المشار إليه غير موجود لهذا الطفل.',
  EVENT_INTERNAL_ERROR: 'تعذّرت معالجة هذا الحدث؛ أعد المحاولة لاحقًا.',
};
