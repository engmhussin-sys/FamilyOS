import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { IAnalyticsEventInput, IAnalyticsProviderAdapter } from '../../domain/analytics.types';

/**
 * The real, no-external-dependency default — same role `ManualPaymentAdapter`
 * plays for Billing.
 *
 * PHASE F (`F6-004`, closing `PF-E-004`) — THE WRITE IS NOW `ON CONFLICT DO
 * NOTHING`, AND THE INSERT IS RAW BECAUSE OF IT.
 *
 * `prisma.analyticsEvent.create` cannot express «insert unless this cause is
 * already counted», and `createMany({ skipDuplicates: true })` compiles to a
 * TOTAL conflict clause while the constraint that matters here is PARTIAL —
 * `analytics_events (event_name, source_event_id) WHERE source_event_id IS NOT
 * NULL` (migration 0020). Naming the index's own predicate in the conflict
 * target is what keeps the open `POST /analytics/track` surface completely
 * unaffected: an ad-hoc event carries no cause, writes NULL, matches no index
 * predicate, and is inserted exactly as it always was.
 *
 * The columns are named explicitly and every value is a bound parameter — the
 * same discipline as `notification-decision.sql.ts`, which is the other place
 * in this codebase where a conflict clause made raw SQL the honest choice.
 */
@Injectable()
export class SelfHostedAnalyticsAdapter implements IAnalyticsProviderAdapter {
  readonly providerName = 'SELF_HOSTED';

  constructor(private readonly prisma: PrismaService) {}

  async track(event: IAnalyticsEventInput): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "analytics_events"
         ("id", "family_id", "user_id", "session_id", "event_name", "payload", "source_event_id")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6)
       ON CONFLICT ("event_name", "source_event_id")
         WHERE "source_event_id" IS NOT NULL
         DO NOTHING`,
      event.familyId ?? null,
      event.userId ?? null,
      event.sessionId,
      event.eventName,
      event.payload === undefined ? null : JSON.stringify(event.payload),
      event.sourceEventId ?? null,
    );
  }
}
