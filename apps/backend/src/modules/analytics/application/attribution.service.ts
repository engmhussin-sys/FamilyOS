import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import { GrowthEventEmitter } from './growth-event-emitter.service';
import {
  normaliseAttribution,
  type AcquisitionChannel,
  type IAttributionInput,
} from '../domain/attribution';

/**
 * PHASE D (GROWTH) — WRITES THE ATTRIBUTION ROW, ONCE, AT REGISTRATION.
 *
 * WHY THIS RUNS UNDER `AUTH_BOOTSTRAP` AND NOT UNDER A TENANT. Registration is
 * the one request in the system that CREATES its own tenant: `/auth/*` is
 * already `@SystemRoute('AUTH_BOOTSTRAP')` for exactly this reason, so there is
 * no ambient tenant context for the extension to stamp. The `familyId` written
 * here is the id of the row the registration transaction just created —
 * server-derived, never from the payload, so CONTEXT §3 principle 3 holds
 * even though the extension is not the thing enforcing it on this path. This is
 * the same shape `AuthService.register` already uses for its audit record.
 *
 * FAILURE IS SWALLOWED, DELIBERATELY. A marketing label must never be the
 * reason a family cannot be created. If this write fails the family exists with
 * no attribution row, which reads as "unattributed" — an honest answer — rather
 * than as a 500 on the most important request in the funnel.
 */
@Injectable()
export class AttributionService {
  private readonly logger = new Logger(AttributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly growthEvents: GrowthEventEmitter,
  ) {}

  /**
   * Captures attribution for a newly created family and emits the two
   * registration growth events. Returns the resolved channel so the caller can
   * log it; returns `null` when nothing could be written.
   */
  async captureAtRegistration(
    familyId: string,
    userId: string,
    input: IAttributionInput | undefined,
  ): Promise<AcquisitionChannel | null> {
    const normalised = normaliseAttribution(input ?? {});

    try {
      await runInSystemScope(
        'AUTH_BOOTSTRAP',
        'Attribution is written inside registration, which creates the tenant it belongs to; the familyId is the row this transaction just created.',
        () =>
          this.prisma.acquisitionAttribution.create({
            data: {
              familyId,
              channel: normalised.channel,
              source: normalised.source,
              campaign: normalised.campaign,
              medium: normalised.medium,
              content: normalised.content,
              countryCode: normalised.countryCode,
              platform: normalised.platform,
              referralCode: normalised.referralCode,
              referrer: normalised.referrer,
              landingPage: normalised.landingPage,
              sessionId: normalised.sessionId,
            },
          }),
      );
    } catch (err) {
      // The UNIQUE on family_id is expected on a retried registration and is
      // not an error condition — the first write won and attribution stays
      // immutable, which is the property this table exists for.
      this.logger.warn(
        `attribution.write_skipped family=${familyId.slice(0, 8)} channel=${normalised.channel} — ` +
          `either a duplicate (attribution is write-once) or a transient failure. ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }

    // The session id links this registration back to the anonymous
    // APP_INSTALLED event, which is the only join between the pre- and
    // post-registration funnel. When absent, a synthetic one is used so the
    // NOT NULL column is honest rather than empty.
    const sessionId = normalised.sessionId ?? `reg:${familyId}`;

    await this.growthEvents.emit({
      name: 'ACCOUNT_CREATED',
      familyId,
      userId,
      sessionId,
      payload: {
        channel: normalised.channel,
        source: normalised.source ?? undefined,
        campaign: normalised.campaign ?? undefined,
        medium: normalised.medium ?? undefined,
        content: normalised.content ?? undefined,
        countryCode: normalised.countryCode ?? undefined,
        platform: normalised.platform,
        referralCode: normalised.referralCode ?? undefined,
      },
    });

    // FAMILY_CREATED is emitted separately even though registration creates the
    // family in the same transaction, because the funnel names them as two
    // steps and a future invite-to-existing-family flow will separate them.
    // Emitting one event and counting it twice would make that future change
    // a data migration.
    await this.growthEvents.emit({
      name: 'FAMILY_CREATED',
      familyId,
      userId,
      sessionId,
      payload: { channel: normalised.channel, countryCode: normalised.countryCode ?? undefined },
    });

    return normalised.channel;
  }

  /** The attribution row for one family. Tenant-scoped by the extension. */
  async forFamily(familyId: string): Promise<{
    channel: AcquisitionChannel;
    campaign: string | null;
    countryCode: string | null;
  } | null> {
    const row = await this.prisma.acquisitionAttribution.findFirst({
      where: { familyId },
      select: { channel: true, campaign: true, countryCode: true },
    });
    return row === null
      ? null
      : { channel: row.channel as AcquisitionChannel, campaign: row.campaign, countryCode: row.countryCode };
  }
}
