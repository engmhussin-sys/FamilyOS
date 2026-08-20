import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { DeviceJwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { EVENTS_RATE_LIMIT, type IngestEventsResponse } from '../../../../shared/events/events-batch.contract';
import { EventIngestionService } from '../../application/event-ingestion.service';
import { IngestEventsDto } from '../../application/dto/ingest-events.dto';
import { DeviceEventsThrottlerGuard } from '../guards/device-events-throttler.guard';
import { ChildSurface } from '../../../../common/authz/roles.decorator';

/**
 * `POST /events/batch` (docs/06 §6; `/api/v1` is prepended by
 * `main.ts`'s `setGlobalPrefix`, so the deployed path is
 * `/api/v1/events/batch` — this repository's existing convention, not a
 * deviation invented here).
 *
 * DEVICE-AUTHENTICATED. `DeviceJwtAuthGuard` is the guard F1 established for
 * device routes, and it is deliberately a DIFFERENT Passport strategy from the
 * parent one: a stolen parent token cannot post events and a stolen device
 * token cannot reach parent endpoints.
 */
@Controller('events')
export class EventsController {
  constructor(private readonly ingestion: EventIngestionService) {}

  /**
   * 200 with per-item results, never 207 (docs/06 §6.3: 207 is WebDAV, and
   * Dart/Kotlin HTTP clients handle it badly). A partial failure is normal
   * operation for an offline-first queue, not an HTTP-level error.
   *
   * `@HttpCode(200)` because Nest answers POST with 201 by default and the
   * contract the device codes against says 200.
   */
  @Post('batch')
  @ChildSurface()
  @HttpCode(200)
  @SkipThrottle() // switches off the GLOBAL IP-keyed limit; see the guard.
  @Throttle({ default: { limit: EVENTS_RATE_LIMIT.limit, ttl: EVENTS_RATE_LIMIT.ttlMs } })
  @UseGuards(DeviceJwtAuthGuard, DeviceEventsThrottlerGuard)
  async ingestBatch(
    @Body() dto: IngestEventsDto,
    @CurrentUser() device: IJwtPayload,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: { correlationId?: string },
  ): Promise<IngestEventsResponse> {
    const data = await this.ingestion.ingestBatch({
      // The ONLY source of tenant identity on this request. `device.sub` is the
      // deviceId out of a signature-verified token; the family is then read
      // from the device row. Nothing in `dto` influences it.
      deviceId: device.sub,
      deviceTime: dto.deviceTime,
      events: dto.events,
      batchIdempotencyKey: idempotencyKey,
      traceId: req?.correlationId,
    });

    return { data, meta: { requestId: req?.correlationId ?? '' } };
  }
}
