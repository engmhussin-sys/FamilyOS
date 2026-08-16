import { Module } from '@nestjs/common';

import { EventsModule } from '../events/events.module';
import { GrowthCaptureModule } from './growth-capture.module';
import { AnalyticsController } from './presentation/controllers/analytics.controller';
import { GrowthAdminController } from './presentation/controllers/growth-admin.controller';
import { ReferralController } from './presentation/controllers/referral.controller';
import { DashboardMetricsService } from './application/dashboard-metrics.service';
import { KpiService } from './application/kpi.service';
import { FunnelService } from './application/funnel.service';
import { CampaignService } from './application/campaign.service';
import { ForecastService } from './application/forecast.service';
import { GrowthAlertsService } from './application/growth-alerts.service';
import { GrowthAggregationService } from './application/growth-aggregation.service';
import { ReferralRewardService } from './application/referral-reward.service';
import { GrowthDomainEventBridge } from './application/growth-domain-event.bridge';

/**
 * Sprint 8's Analytics Core, EXTENDED by Phase D (Growth) rather than replaced.
 *
 * WHAT SURVIVED UNCHANGED: `EventCollectorService`, `PrivacyFilter`, the
 * self-hosted adapter and the optional PostHog mirror — the whole
 * "self-hosted-first, external providers are additive and fail silently"
 * posture A1 §20 praised while classifying this module EXTEND. They now live in
 * `GrowthCaptureModule` (see its docstring for the dependency cycle that forced
 * the split) and are re-exported here, so there is still exactly ONE collector
 * in the application and every analytics event in the system still passes
 * through one privacy filter.
 *
 * WHAT WAS ADDED: the read and admin half. KPIs (computed only by
 * `domain/kpi-definitions.ts`), the eleven-step funnel, campaigns, forecasts,
 * the eight alert rules, the daily aggregate, the referral payout path, and
 * `GrowthDomainEventBridge` — which is why `EventsModule` is imported: five of
 * the nineteen growth events are projections of domain events that already
 * existed, and subscribing to the bus instruments every producer without
 * editing one of them.
 *
 * NOTHING IMPORTS THIS MODULE except the scheduler, which needs the two job
 * bodies. That is what keeps the graph acyclic: producers depend on
 * `GrowthCaptureModule`, which imports nothing.
 */
@Module({
  imports: [GrowthCaptureModule, EventsModule],
  controllers: [AnalyticsController, GrowthAdminController, ReferralController],
  providers: [
    DashboardMetricsService,
    KpiService,
    FunnelService,
    CampaignService,
    ForecastService,
    GrowthAlertsService,
    GrowthAggregationService,
    ReferralRewardService,
    GrowthDomainEventBridge,
  ],
  exports: [
    // The MODULE is re-exported, not the provider: `EventCollectorService` is
    // provided by `GrowthCaptureModule`, and Nest refuses to export a provider
    // a module does not own. Re-exporting the module keeps every historical
    // consumer of `AnalyticsModule`'s `EventCollectorService` working while
    // there is still exactly one instance of it.
    GrowthCaptureModule,
    GrowthAggregationService,
    GrowthAlertsService,
    ReferralRewardService,
    KpiService,
  ],
})
export class AnalyticsModule {}
