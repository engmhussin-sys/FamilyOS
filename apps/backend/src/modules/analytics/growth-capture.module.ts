import { Module } from '@nestjs/common';

import { EventCollectorService } from './application/event-collector.service';
import { PrivacyFilter } from './application/privacy-filter';
import { SelfHostedAnalyticsAdapter } from './infrastructure/adapters/self-hosted-analytics.adapter';
import { PostHogAdapter } from './infrastructure/adapters/posthog.adapter';
import { GrowthEventEmitter } from './application/growth-event-emitter.service';
import { GrowthSettingsService } from './application/growth-settings.service';
import { AttributionService } from './application/attribution.service';
import { ActivationService } from './application/activation.service';
import { ReferralService } from './application/referral.service';

/**
 * PHASE D (GROWTH) — THE CAPTURE HALF, IN ITS OWN MODULE, AND THE REASON IS A
 * DEPENDENCY CYCLE THAT WOULD OTHERWISE BE REAL.
 *
 * The producers of growth events are `auth` (registration), `children`,
 * `billing` and `life-intelligence`. If they imported the full
 * `AnalyticsModule`, the graph would be:
 *
 *   AuthModule -> AnalyticsModule -> EventsModule -> PairingModule -> AuthModule
 *
 * a genuine cycle, which Nest resolves only with `forwardRef` — and a
 * `forwardRef` between four modules is a maintenance trap that fails at
 * runtime, not at compile time, and fails in whichever module was loaded
 * second.
 *
 * SO THE MODULE IS SPLIT ALONG THE LINE THAT ALREADY EXISTED IN THE DESIGN:
 *
 *   THIS MODULE — CAPTURE. Emitting events, writing attribution, minting a
 *   referral code, evaluating activation. It imports NOTHING (Prisma and
 *   FamilyDate are `@Global`), so any producer can depend on it and no cycle is
 *   constructible.
 *
 *   `AnalyticsModule` — READ AND ADMIN. KPIs, funnels, campaigns, forecasts,
 *   alerts, aggregation, the referral PAYOUT path, and the bridge that
 *   subscribes to the domain bus. It imports this module and `EventsModule`,
 *   and nothing imports it.
 *
 * `EventCollectorService` and its three collaborators are provided HERE and
 * re-exported by `AnalyticsModule`, so there is exactly one collector instance
 * in the application — the same single-ingestion-path property Sprint 8 built,
 * preserved rather than duplicated.
 */
@Module({
  providers: [
    PrivacyFilter,
    SelfHostedAnalyticsAdapter,
    PostHogAdapter,
    EventCollectorService,
    GrowthSettingsService,
    GrowthEventEmitter,
    AttributionService,
    ActivationService,
    ReferralService,
  ],
  exports: [
    EventCollectorService,
    GrowthSettingsService,
    GrowthEventEmitter,
    AttributionService,
    ActivationService,
    ReferralService,
  ],
})
export class GrowthCaptureModule {}
