import { Injectable, Logger } from '@nestjs/common';

import { EventCollectorService } from './event-collector.service';
import {
  ALLOWED_PAYLOAD_KEYS,
  GROWTH_EVENT_CATALOGUE,
  type GrowthEventName,
} from '../domain/growth-events';

export interface IGrowthEmitInput {
  readonly name: GrowthEventName;
  /** Server-derived. `null` only for the genuinely pre-family events. */
  readonly familyId: string | null;
  readonly userId?: string | null;
  /** Anonymous session for pre-registration events; a synthetic id otherwise. */
  readonly sessionId: string;
  readonly payload?: Record<string, unknown>;
  /** PHASE F (`F6-004`) — the domain event this projection counts, so a
   * redelivery is a no-op. See `IAnalyticsEventInput.sourceEventId`. */
  readonly sourceEventId?: string;
}

/**
 * PHASE D (GROWTH) — THE ONLY WAY A GROWTH EVENT IS EMITTED.
 *
 * It wraps `EventCollectorService` rather than replacing it: the privacy
 * filter, the self-hosted store and the optional PostHog mirror are all
 * unchanged and still the single ingestion path. What this class adds is the
 * three things a free-form `track(eventName: string)` cannot enforce:
 *
 *   1. A CLOSED EVENT VOCABULARY. `name` is a `GrowthEventName`, so a typo is a
 *      compile error rather than a nineteenth event nobody queries. The
 *      pre-existing `POST /analytics/track` remains open for ad-hoc product
 *      telemetry — this is additive, not a restriction on it.
 *
 *   2. A PAYLOAD ALLOW-LIST. Keys outside `ALLOWED_PAYLOAD_KEYS` are DROPPED
 *      and logged. This is the second privacy layer, and it is an allow-list
 *      rather than a deny-list on purpose: `PrivacyFilter` already removes the
 *      PII somebody thought of, and an allow-list removes the PII nobody did.
 *      A caller who passes `childId` gets a warn line and an event without it.
 *
 *      DROPPING RATHER THAN THROWING IS DELIBERATE. An over-eager analytics
 *      payload must never be able to fail a registration, a reward grant or a
 *      payment. The log line is how the drop is noticed; the metric being
 *      slightly poorer is the correct price.
 *
 *   3. NEVER THROWING. `emit` catches everything. Analytics is the least
 *      important thing happening in any transaction it is called from, and a
 *      module that can take down the reward path is a liability regardless of
 *      how good its charts are. `EventCollectorService` already protects the
 *      OPTIONAL adapter this way; this extends the same posture to the
 *      self-hosted write, because a full disk must not stop a family paying.
 */
@Injectable()
export class GrowthEventEmitter {
  private readonly logger = new Logger(GrowthEventEmitter.name);

  constructor(private readonly collector: EventCollectorService) {}

  async emit(input: IGrowthEmitInput): Promise<void> {
    const definition = GROWTH_EVENT_CATALOGUE[input.name];
    if (!definition) {
      this.logger.warn(`growth.unknown_event name=${String(input.name)} — dropped.`);
      return;
    }

    // A FAMILY_SCOPED event without a family is a bug in its producer: it would
    // be stored as an un-attributable row and silently lower every funnel step
    // it feeds. It is logged and dropped rather than stored, because a wrong
    // number is worse than a missing one.
    if (definition.tenancy === 'FAMILY_SCOPED' && !input.familyId) {
      this.logger.warn(
        `growth.missing_family name=${input.name} — this event is FAMILY_SCOPED and was dropped rather than stored un-attributed.`,
      );
      return;
    }

    const payload = this.sanitise(input.name, input.payload);

    try {
      await this.collector.track({
        familyId: input.familyId ?? undefined,
        userId: input.userId ?? undefined,
        sessionId: input.sessionId,
        eventName: input.name,
        payload,
        sourceEventId: input.sourceEventId,
      });
    } catch (err) {
      this.logger.warn(
        `growth.emit_failed name=${input.name} — the caller's transaction is unaffected. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * The allow-list pass. Returns `undefined` for an empty result so the stored
   * `payload` column is NULL rather than `{}` — a distinction that matters when
   * querying for events that carried dimensions.
   */
  private sanitise(
    name: GrowthEventName,
    payload: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!payload) return undefined;

    const kept: Record<string, unknown> = {};
    const dropped: string[] = [];

    for (const [key, value] of Object.entries(payload)) {
      if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
        dropped.push(key);
        continue;
      }
      // Only scalars survive. A nested object is how a child record gets into
      // an analytics payload by accident, and no growth dimension needs one.
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        kept[key] = value;
      } else {
        dropped.push(key);
      }
    }

    if (dropped.length > 0) {
      this.logger.warn(
        `growth.payload_keys_dropped name=${name} keys=[${dropped.join(',')}] — not in ALLOWED_PAYLOAD_KEYS.`,
      );
    }

    return Object.keys(kept).length > 0 ? kept : undefined;
  }
}
