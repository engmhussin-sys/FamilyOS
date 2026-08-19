import {
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { RedisService } from '../../../common/redis/redis.service';
import { PairingOrchestratorService } from '../../pairing/application/services/pairing-orchestrator.service';
import type { CompletionEvent, CompletionKind } from '../../../shared/events/completion-event';
import {
  BATCH_IDEMPOTENCY_TTL_SECONDS,
  MAX_BATCH_CLOCK_SKEW_MS,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENT_AGE_MS,
  MAX_EVENT_FUTURE_MS,
  REJECTION_MESSAGE_AR,
  type EventRejectionCode,
  type EventResult,
  type IngestEventsData,
} from '../../../shared/events/events-batch.contract';
import { SUPPORTED_SCHEMA_VERSIONS } from '../../../shared/events/event-envelope';
import {
  isDeviceIngestibleEventType,
  isDomainEventType,
  type DomainEventType,
} from '../../../shared/events/event-types';
import { composeIdempotencyKey } from '../../../shared/events/idempotency';
import {
  HabitCompletionClient,
  habitCompletionStatus,
  recordHabitCompletion,
} from '../../life-intelligence/infrastructure/repositories/habit-completion.recorder';
import { FamilyDateService } from '../../../common/time/family-date.service';
import { getBusinessDate } from '../../../common/time/family-date';
import { OutboxWriter, type PrismaLike } from './outbox.writer';
import type { WireEventDto } from './dto/ingest-events.dto';

/**
 * What each event type declares about itself, so the loop below has no switch.
 *
 * Written as a DISCRIMINATED UNION rather than two independently-nullable
 * fields, because the invariant "a completion type always has a sourceType" is
 * real and the type system should be the thing that enforces it. With two
 * nullable fields, `sourceType` still had to be asserted non-null at the one
 * place it is read; with the union, narrowing on `spec.completionKind` proves
 * it, and a future entry that sets a `completionKind` without a `sourceType`
 * fails to compile instead of producing a `CompletionEvent` with a null
 * `sourceType` that the Rewards Engine cannot route.
 */
type TypeSpec =
  | {
      readonly completionKind: CompletionKind;
      readonly aggregateType: string;
      readonly sourceType: CompletionEvent['sourceType'];
      /** Which payload field carries the aggregate id. */
      readonly sourceIdField: string | null;
      /** Writes a domain row inside the event's own transaction. */
      readonly writesDomainRow: boolean;
    }
  | {
      /** Not a completion — never reaches the Rewards Engine. */
      readonly completionKind: null;
      readonly aggregateType: string;
      readonly sourceType: null;
      readonly sourceIdField: string | null;
      readonly writesDomainRow: boolean;
    };

const TYPE_SPECS: Readonly<Partial<Record<DomainEventType, TypeSpec>>> = {
  HABIT_COMPLETED: {
    completionKind: 'HABIT',
    aggregateType: 'HabitOccurrence',
    sourceType: 'HabitOccurrence',
    sourceIdField: 'habitId',
    writesDomainRow: true,
  },
  TASK_COMPLETED: {
    completionKind: 'TASK',
    aggregateType: 'TaskOccurrence',
    sourceType: 'TaskOccurrence',
    sourceIdField: 'taskId',
    writesDomainRow: false,
  },
  DAILY_GOAL_COMPLETED: {
    completionKind: 'HABIT',
    aggregateType: 'DailyGoal',
    sourceType: 'HabitOccurrence',
    sourceIdField: 'goalId',
    writesDomainRow: false,
  },
  HYDRATION_GOAL_COMPLETED: {
    completionKind: 'HEALTH_GOAL',
    aggregateType: 'HydrationLog',
    sourceType: 'HydrationLog',
    sourceIdField: null,
    writesDomainRow: false,
  },
  ACTIVITY_GOAL_COMPLETED: {
    completionKind: 'HEALTH_GOAL',
    aggregateType: 'ActivityLog',
    sourceType: 'ActivityLog',
    sourceIdField: null,
    writesDomainRow: false,
  },
  EDUCATION_PROGRESS: {
    completionKind: 'LEARNING_SESSION',
    aggregateType: 'LearningSession',
    sourceType: 'LearningSession',
    sourceIdField: 'goalId',
    writesDomainRow: false,
  },
  MEMORIZATION_COMPLETED: {
    completionKind: 'FAITH_SESSION',
    aggregateType: 'MemorizationProgress',
    sourceType: 'MemorizationProgress',
    sourceIdField: 'progressId',
    writesDomainRow: false,
  },
  SCREEN_TIME_THRESHOLD: {
    completionKind: null,
    aggregateType: 'ScreenTimeBudget',
    sourceType: null,
    sourceIdField: null,
    writesDomainRow: false,
  },
  IMPORTANT_SAFETY_EVENT: {
    completionKind: null,
    aggregateType: 'DeviceSafetySignal',
    sourceType: null,
    sourceIdField: null,
    writesDomainRow: false,
  },
};

/**
 * `POST /events/batch` — the server side of docs/06 §6.
 *
 * THE FOUR THINGS THIS CLASS REFUSES TO DO, each of which is a real attack:
 *  1. Read `familyId` or `childId` from the payload. Both come from the device
 *     token via `getChildAndFamilyIdForDevice`, which ALSO re-checks that the
 *     device is still ACTIVE — a revoked device with an unexpired token is
 *     rejected here even though its JWT signature is perfectly valid.
 *  2. Accept a client-chosen `idempotencyKey`. A device that could choose its
 *     own key could choose a fresh one per retry and mint unlimited rewards, so
 *     the key is composed server-side from server-known values.
 *  3. Accept `REWARD_GRANTED` or `STREAK_ACHIEVED` from the wire. Both are
 *     DERIVED events; a device that could post `REWARD_GRANTED` could
 *     manufacture a notification for a reward that never happened.
 *  4. Fail a whole batch for one bad event. docs/06 §6.5: one transaction per
 *     event, "one corrupt event does not take down 199 valid ones".
 *  5. B1 (PA-B-003) — READ THE DAY FROM THE DEVICE. Rule 2 above closed the
 *     front door and left the key under the mat: the key was composed
 *     server-side, but one of its inputs — `localDate` — arrived on the wire,
 *     was validated for SHAPE ONLY (`/^\d{4}-\d{2}-\d{2}$/`), and was never
 *     compared to `occurredAt` or to any timezone. A device sending the same
 *     habit completion 200 times with 200 different `localDate` values in one
 *     batch produced 200 distinct keys, 200 ledger rows and 200 grants; at 12
 *     batches/hour through `DeviceEventsThrottlerGuard` that is 2,400 grants an
 *     hour from a single habit. The unique constraint held perfectly and was
 *     worthless, because the attacker controlled the key.
 *
 *     The business date is now DERIVED: `occurredAt` (already validated against
 *     the 48h/+5min clock-skew bounds by `validate()`) converted into
 *     `Family.timezone`. `event.localDate` never reaches an idempotency key, a
 *     domain row or a rule evaluation. It is retained ONLY as
 *     `clientReportedLocalDate` inside the stored payload — a telemetry field
 *     whose name makes its status unmistakable — so device clock skew stays
 *     diagnosable. See `deriveBusinessDate` below.
 */
@Injectable()
export class EventIngestionService {
  private readonly logger = new Logger(EventIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxWriter,
    private readonly pairing: PairingOrchestratorService,
    private readonly redis: RedisService,
    private readonly familyDate: FamilyDateService,
  ) {}

  async ingestBatch(params: {
    deviceId: string;
    deviceTime: string;
    events: readonly WireEventDto[];
    batchIdempotencyKey?: string;
    traceId?: string;
  }): Promise<IngestEventsData> {
    const serverNow = new Date();

    // --- batch-level gate 1: size (docs/06 §6.2) -----------------------------
    if (params.events.length > MAX_EVENTS_PER_BATCH) {
      throw new PayloadTooLargeException({
        code: 'EVENT_BATCH_TOO_LARGE',
        message: `A batch may carry at most ${MAX_EVENTS_PER_BATCH} events; received ${params.events.length}.`,
      });
    }

    // --- batch-level gate 2: device clock (docs/06 §6.2) ---------------------
    const deviceTimeMs = Date.parse(params.deviceTime);
    if (Number.isNaN(deviceTimeMs) || Math.abs(deviceTimeMs - serverNow.getTime()) > MAX_BATCH_CLOCK_SKEW_MS) {
      throw new BadRequestException({
        code: 'DEVICE_CLOCK_SKEW',
        message: 'Device clock differs from server clock by more than 10 minutes; the whole batch is rejected.',
        serverTime: serverNow.toISOString(),
      });
    }

    // --- the tenant. From the device row, never from the payload. -----------
    const { childId, familyId } = await this.pairing.getChildAndFamilyIdForDevice(params.deviceId);

    // B1/B2: the family's calendar, read ONCE per batch. Every event in the
    // batch is dated against this zone, so a 200-event batch costs one lookup
    // and every row in it agrees about what day it is.
    const timeZone = await this.familyDate.timeZoneOf(familyId);

    // --- replay protection layer 2 (docs/06 §6.6): the whole round trip -----
    const cached = await this.readBatchReplay(familyId, params.deviceId, params.batchIdempotencyKey);
    if (cached) return cached;

    const results: EventResult[] = [];
    for (const event of params.events) {
      results.push(
        await this.ingestOne({
          event,
          childId,
          familyId,
          deviceId: params.deviceId,
          serverNow,
          timeZone,
          traceId: params.traceId ?? null,
        }),
      );
    }

    const data: IngestEventsData = {
      accepted: results.filter((r) => r.status === 'ACCEPTED').length,
      duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
      rejected: results.filter((r) => r.status === 'REJECTED').length,
      serverTime: serverNow.toISOString(),
      results,
    };

    await this.writeBatchReplay(familyId, params.deviceId, params.batchIdempotencyKey, data);
    return data;
  }

  /**
   * ONE EVENT, ONE TRANSACTION (docs/06 §6.5).
   *
   * Inside the transaction, in this order: the domain row, then the event row,
   * then the outbox row. All three commit together or none does — which is the
   * single property the entire Outbox pattern exists to provide.
   */
  private async ingestOne(ctx: {
    event: WireEventDto;
    childId: string;
    familyId: string;
    deviceId: string;
    serverNow: Date;
    timeZone: string;
    traceId: string | null;
  }): Promise<EventResult> {
    const { event } = ctx;

    const rejection = this.validate(event, ctx.serverNow);
    if (rejection) return reject(event.clientEventId, rejection);

    const type = event.type as DomainEventType;
    const spec = TYPE_SPECS[type];
    if (!spec) return reject(event.clientEventId, 'EVENT_TYPE_NOT_DEVICE_INGESTIBLE');

    const occurredAt = new Date(event.occurredAt);
    // B1 (PA-B-003). THE SINGLE MOST IMPORTANT LINE IN THIS FILE. The business
    // date is a SERVER OUTPUT, computed from an occurrence time that `validate()`
    // has already bounded to [-48h, +5min] of server time, projected onto the
    // family's own calendar. `event.localDate` is not consulted.
    const localDate = getBusinessDate(occurredAt, ctx.timeZone);
    const sourceId = spec.sourceIdField
      ? String(event.payload[spec.sourceIdField] ?? '')
      : `${ctx.childId}`;

    if (spec.sourceIdField && !isUuid(sourceId)) {
      return reject(event.clientEventId, 'EVENT_PAYLOAD_INVALID');
    }

    const idempotencyKey = composeIdempotencyKey(type, {
      childId: ctx.childId,
      deviceId: ctx.deviceId,
      sourceId,
      localDate,
      milestone: numberOrUndefined(event.payload.milestone ?? event.payload.thresholdPercent),
      kind: stringOrUndefined(event.payload.goalType ?? event.payload.kind),
      hourBucket: occurredAt.toISOString().slice(0, 13),
    });

    // B1: TELEMETRY, NOT AUTHORITY. The device's own opinion of the day and its
    // zone is kept for one purpose — diagnosing clock skew and mis-set device
    // timezones in the field — and is named so that no future reader can
    // mistake it for the business date. `skewDays` is the measured disagreement
    // between the device's calendar and the family's; a fleet-wide non-zero
    // value is a real signal, and a single device reporting 200 different days
    // in one batch now shows up here instead of in the ledger.
    const clientTelemetry = buildClientDateTelemetry(event, localDate);
    if (clientTelemetry.clientLocalDateSkewDays !== null && clientTelemetry.clientLocalDateSkewDays !== 0) {
      this.logger.debug(
        `ingest.client_date_skew type=${event.type} skewDays=${clientTelemetry.clientLocalDateSkewDays} — server date used.`,
      );
    }

    // The payload the SERVER stores — a CompletionEvent for completion types,
    // the client's own payload otherwise. Client-sent childId/deviceId/
    // idempotencyKey are overwritten, not merged: they are server-owned fields.
    // So, now, is `localDate`.
    const storedPayload: Record<string, unknown> = spec.completionKind
      ? ({
          ...event.payload,
          schemaVersion: 1,
          completionKind: spec.completionKind,
          childId: ctx.childId,
          deviceId: ctx.deviceId,
          sourceType: spec.sourceType,
          sourceId,
          localDate,
          occurredAt: occurredAt.toISOString(),
          idempotencyKey,
          pointsHint: numberOrNull(event.payload.pointsHint),
          /**
           * PHASE C (`PC-B-005`) — B1's LESSON, APPLIED TO THE FIELD B1 DID NOT
           * LOOK AT.
           *
           * This used to be `verifiedByOrDefault(event.payload.verifiedBy)`,
           * which accepted `'PARENT'`, `'SENSOR'` and `'SYSTEM'` STRAIGHT OFF
           * THE WIRE. `meetsVerificationFloor` (rewards-rules.ts) reads exactly
           * this field to decide whether a rule carrying
           * `minVerifiedBy: 'PARENT'` — rank 3, the highest — is satisfied. So
           * a parent's «pay only when I have confirmed it» was defeated by one
           * word in a free-form JSON payload the child's own device composes.
           * Measured before the fix: a forged `{"verifiedBy": "PARENT"}` on a
           * self-posted `HABIT_COMPLETED` produced a real 250 XP ledger row
           * against a PARENT-floored rule.
           *
           * `POST /events/batch` is reachable ONLY with a device token
           * (`DeviceJwtAuthGuard`). The caller IS the child's device. It cannot
           * witness a parent, it cannot attest a sensor it also controls, and
           * it is not the system — so the only honest value it can produce is
           * `SELF`, and that is now a constant rather than a parse.
           *
           * A genuine `PARENT` verification still exists and still clears the
           * floor: it comes from the PARENT-authenticated routes, where the
           * server asserts it from the session (`HabitEngineService` and its
           * siblings pass `actor === 'PARENT'`). The claim is not lost here —
           * it is demoted to `clientReportedVerifiedBy` telemetry below, the
           * same treatment B1 gave `clientReportedLocalDate`, so a fleet
           * reporting values it is not entitled to is diagnosable instead of
           * silent.
           */
          verifiedBy: 'SELF',
          metadata: plainMetadata(event.payload.metadata),
        } satisfies CompletionEvent as unknown as Record<string, unknown>)
      : { ...event.payload, childId: ctx.childId, deviceId: ctx.deviceId, localDate };

    // Merged AFTER the spread of `event.payload`, so a payload that tried to
    // smuggle its own `clientReportedLocalDate` cannot forge the telemetry
    // either. The business `localDate` above is already server-owned.
    Object.assign(storedPayload, clientTelemetry, { businessTimezone: ctx.timeZone });

    try {
      const outcome = await this.prismaLike().$transaction(async (tx) => {
        if (spec.writesDomainRow && type === 'HABIT_COMPLETED') {
          const written = await this.writeHabitCompletion(tx, {
            habitId: sourceId,
            childId: ctx.childId,
            familyId: ctx.familyId,
            localDate,
            timeZone: ctx.timeZone,
            occurredAt,
          });
          if (!written) return { created: false, domainEventId: null, missingSource: true };
        }

        const result = await this.outbox.writeWithin(tx, {
          type,
          aggregateType: spec.aggregateType,
          aggregateId: isUuid(sourceId) ? sourceId : ctx.childId,
          childId: ctx.childId,
          deviceId: ctx.deviceId,
          idempotencyKey,
          clientEventId: event.clientEventId,
          occurredAt,
          traceId: ctx.traceId,
          payload: storedPayload,
        });
        return { ...result, missingSource: false };
      });

      if (outcome.missingSource) return reject(event.clientEventId, 'EVENT_SOURCE_NOT_FOUND');
      if (!outcome.created) {
        // docs/06 §6.4: DUPLICATE is a SUCCESS. It is the acknowledgement the
        // device needs to prune the row from its local queue after a timeout.
        return { clientEventId: event.clientEventId, status: 'DUPLICATE' };
      }
      return {
        clientEventId: event.clientEventId,
        status: 'ACCEPTED',
        eventId: outcome.domainEventId ?? undefined,
      };
    } catch (err) {
      // One event's failure, one event's problem. No ids, no payload in the log
      // line (CONTEXT §3 principle 8).
      this.logger.warn(
        `ingest.event_failed type=${event.type} error=${err instanceof Error ? err.message : String(err)}`,
      );
      return reject(event.clientEventId, 'EVENT_INTERNAL_ERROR');
    }
  }

  /**
   * Per-event validation, in the order docs/06 §6.2 lists it. Returns the
   * rejection code, or `null` when the event is acceptable.
   */
  private validate(event: WireEventDto, serverNow: Date): EventRejectionCode | null {
    if (!isDomainEventType(event.type)) return 'EVENT_UNKNOWN_TYPE';
    if (!isDeviceIngestibleEventType(event.type)) return 'EVENT_TYPE_NOT_DEVICE_INGESTIBLE';

    const version = event.schemaVersion ?? 1;
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) return 'EVENT_SCHEMA_MISMATCH';

    const occurredMs = Date.parse(event.occurredAt);
    if (Number.isNaN(occurredMs)) return 'EVENT_CLOCK_SKEW';

    const delta = occurredMs - serverNow.getTime();
    // Future boundary: +5 minutes (docs/06 §6.2, and the brief).
    if (delta > MAX_EVENT_FUTURE_MS) return 'EVENT_CLOCK_SKEW';
    // Past boundary: 48 hours. See MAX_EVENT_AGE_MS for why this is 48h and not
    // the 7 days docs/06 §6.2 states.
    if (-delta > MAX_EVENT_AGE_MS) return 'EVENT_CLOCK_SKEW';

    return null;
  }

  /**
   * Writes the habit completion row THROUGH THE ONE WRITER,
   * `recordHabitCompletion`. The habit's existence and ownership is checked
   * FIRST, because a device that could complete an arbitrary habit id could
   * complete another child's habits.
   *
   * WHAT WAS HERE AND WHAT IT COST. This method had its own `upsert` beside the
   * repository's, and the two had diverged by one line: `update: {}` against the
   * repository's `update: { status }`, plus a hardcoded `COMPLETED` on create.
   * `family-daily-rollover` writes yesterday's `MISSED` row for an untouched
   * habit; an offline device syncing that completion the next morning (inside
   * the 48h skew `validate()` accepts) landed HERE, and `update: {}` touched
   * nothing. The row stayed `MISSED` — so `findDistinctCompletionDates`, which
   * filters `status IN (COMPLETED, COMPLETED_LATE)`, could not see the day,
   * while the domain event written in the same transaction went on to the
   * Rewards Engine and PAID it. Measured, then closed:
   * `test/life-intelligence/habit-completion-one-door.e2e.spec.ts`.
   *
   * The status is now decided by `habitCompletionStatus` — the same function the
   * direct door uses — so this path can express `COMPLETED_LATE`, which it
   * previously could not produce at all.
   */
  private async writeHabitCompletion(
    tx: PrismaLike,
    params: {
      habitId: string;
      childId: string;
      familyId: string;
      localDate: string;
      timeZone: string;
      occurredAt: Date;
    },
  ): Promise<boolean> {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const anyTx = tx as any;
    const habit = await anyTx.habit.findFirst({
      where: { id: params.habitId, childId: params.childId, isActive: true, deletedAt: null },
      select: { id: true, scheduledEndTime: true },
    });
    if (!habit) return false;

    await recordHabitCompletion(anyTx as HabitCompletionClient, {
      familyId: params.familyId,
      habitId: params.habitId,
      childId: params.childId,
      date: new Date(`${params.localDate}T00:00:00.000Z`),
      status: habitCompletionStatus({
        scheduledEndTime: habit.scheduledEndTime ?? null,
        businessDate: params.localDate,
        todayBusinessDate: getBusinessDate(new Date(), params.timeZone),
        at: params.occurredAt,
        timeZone: params.timeZone,
      }),
    });
    return true;
  }

  // --- batch replay cache (docs/06 §6.6 layer 2) ----------------------------
  //
  // Redis saves a full round trip when a device retries after a network
  // timeout. It is a CACHE, not the guarantee: with Redis down, every event
  // still lands on `domain_events (family_id, idempotency_key)` and comes back
  // as DUPLICATE. Both failures below are therefore swallowed by design — a
  // Redis outage must degrade this endpoint's latency, never its correctness.

  private replayKey(familyId: string, deviceId: string, key: string): string {
    return `events:batch:${familyId}:${deviceId}:${key}`;
  }

  private async readBatchReplay(
    familyId: string,
    deviceId: string,
    key?: string,
  ): Promise<IngestEventsData | null> {
    if (!key) return null;
    try {
      const cached = await this.redis.get(this.replayKey(familyId, deviceId, key));
      return cached ? (JSON.parse(cached) as IngestEventsData) : null;
    } catch {
      return null;
    }
  }

  private async writeBatchReplay(
    familyId: string,
    deviceId: string,
    key: string | undefined,
    data: IngestEventsData,
  ): Promise<void> {
    if (!key) return;
    try {
      await this.redis.setWithTtl(
        this.replayKey(familyId, deviceId, key),
        JSON.stringify(data),
        BATCH_IDEMPOTENCY_TTL_SECONDS,
      );
    } catch {
      /* see the note above: correctness does not depend on this. */
    }
  }

  private prismaLike(): PrismaLike {
    return this.prisma as unknown as PrismaLike;
  }
}

function reject(clientEventId: string, errorCode: EventRejectionCode): EventResult {
  return {
    clientEventId,
    status: 'REJECTED',
    errorCode,
    messageAr: REJECTION_MESSAGE_AR[errorCode],
  };
}

/**
 * B1. What the device CLAIMED the day and the zone were, and by how many
 * calendar days it disagreed with the server's answer.
 *
 * Three deliberate naming decisions, because this is the field a future
 * engineer is most likely to misuse:
 *   - `clientReportedLocalDate`, not `localDate`. The prefix is the warning.
 *   - it lives in the payload next to the authoritative `localDate`, so any
 *     diff between them is visible in one row rather than requiring a join.
 *   - `clientLocalDateSkewDays` is precomputed, so an alert can be written
 *     against a number instead of two strings.
 *
 * Nothing here is read by any rule, any key, or any query. It exists to answer
 * "is this fleet's clock drifting?" and "did someone try this?".
 */
function buildClientDateTelemetry(
  event: WireEventDto,
  serverBusinessDate: string,
): {
  clientReportedLocalDate: string | null;
  clientReportedTimezone: string | null;
  clientLocalDateSkewDays: number | null;
  clientReportedVerifiedBy: string | null;
} {
  const claimed = typeof event.localDate === 'string' ? event.localDate : null;
  const skewDays =
    claimed !== null
      ? Math.round(
          (Date.parse(`${claimed}T00:00:00.000Z`) -
            Date.parse(`${serverBusinessDate}T00:00:00.000Z`)) /
            86_400_000,
        )
      : null;
  return {
    clientReportedLocalDate: claimed,
    clientReportedTimezone: typeof event.timezone === 'string' ? event.timezone : null,
    clientLocalDateSkewDays: Number.isFinite(skewDays as number) ? skewDays : null,
    // PHASE C (`PC-B-005`). What the device SAID verified this completion, kept
    // for the same reason `clientReportedLocalDate` is kept: a device claiming
    // `PARENT` is either an out-of-date client or an attempt, and both are
    // worth being able to see. The authoritative `verifiedBy` is the server's
    // constant `'SELF'`, set above; this field is read by no rule, no key and
    // no query.
    clientReportedVerifiedBy:
      typeof event.payload?.verifiedBy === 'string' ? event.payload.verifiedBy : null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** ≤ 2 KB, scalars only — the contract's own bound, enforced not assumed. */
function plainMetadata(value: unknown): Record<string, string | number | boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    if (JSON.stringify(out).length > 2048) {
      delete out[k];
      break;
    }
  }
  return out;
}
