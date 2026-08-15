import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { MAX_EVENTS_PER_BATCH } from '../../../../shared/events/events-batch.contract';

/**
 * NOTE ON WHAT IS ABSENT: there is no `familyId` and no `childId` on this DTO,
 * and the CI static guard (`scripts/ci/assert-tenant-scoping.ts` RULE 3) fails
 * the build if either appears. The tenant and the child are derived from the
 * device token. A device physically cannot address another family's data
 * through this endpoint because there is no field in which to name one.
 */
export class WireEventDto {
  /** `{deviceId-short}:seq:{monotonic}` — the device's own queue key. */
  @IsString()
  @MaxLength(120)
  @Matches(/^[A-Za-z0-9._:-]+$/, {
    message: 'clientEventId must be an opaque identifier ([A-Za-z0-9._:-]).',
  })
  clientEventId!: string;

  /**
   * Deliberately NOT `@IsEnum(DomainEventType)`. docs/06 §6.2 requires forward
   * compatibility: an OLD server must reject ONE unknown event type as a
   * per-item `EVENT_UNKNOWN_TYPE`, not 400 the whole batch, or every agent
   * release would break every server that had not been deployed yet.
   */
  @IsString()
  @MaxLength(60)
  type!: string;

  @IsISO8601()
  occurredAt!: string;

  @IsOptional()
  @IsInt()
  schemaVersion?: number;

  /**
   * TELEMETRY ONLY (B1). The device's own idea of its zone. Stored as
   * `clientReportedTimezone`; it dates nothing. The family's calendar is
   * `Family.timezone`, and one family has one calendar.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  /**
   * TELEMETRY ONLY (B1, closes PA-B-003). THIS FIELD IS NOT THE BUSINESS DATE
   * AND MUST NEVER BECOME ONE AGAIN.
   *
   * It used to be. It was validated for SHAPE ONLY and then flowed straight
   * into `composeIdempotencyKey`. Because the attacker chose it, the attacker
   * chose the key: 200 different values in one 200-event batch produced 200
   * grants for a single habit completion, and 2,400/hour through the
   * per-device throttler. The unique constraint was intact throughout — it was
   * guarding a lock whose key the caller was handed.
   *
   * The server now derives the business date from `occurredAt` (already
   * bounded to -48h/+5min by `EventIngestionService.validate`) projected onto
   * `Family.timezone`. This value survives only as `clientReportedLocalDate`
   * in the stored payload, for clock-skew diagnostics.
   *
   * It is still ACCEPTED rather than rejected on purpose: ignoring an input is
   * a backward-compatible change that keeps every already-deployed agent
   * working and keeps the skew signal flowing; refusing it would break them
   * and blind us at the same time.
   */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'localDate must be YYYY-MM-DD.' })
  localDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  agentVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  priority?: string;

  /**
   * Polymorphic by design — its shape depends on `type`, and for the eight
   * completion types it is a `CompletionEvent`. Validated per-type in
   * `EventIngestionService`, which can reject ONE malformed payload as
   * `EVENT_PAYLOAD_INVALID` instead of 400-ing 199 valid siblings.
   */
  @IsObject()
  payload!: Record<string, unknown>;
}

export class IngestEventsDto {
  /** The device's own clock at send time. Checked for batch-level skew. */
  @IsISO8601()
  deviceTime!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_EVENTS_PER_BATCH * 2, {
    // A second, coarser bound so an absurd array is rejected by the pipe before
    // 100k objects are transformed. The real 200 cap answers 413 with the
    // documented `EVENT_BATCH_TOO_LARGE` code, which this message cannot.
    message: 'events array is implausibly large.',
  })
  @ValidateNested({ each: true })
  @Type(() => WireEventDto)
  events!: WireEventDto[];
}
