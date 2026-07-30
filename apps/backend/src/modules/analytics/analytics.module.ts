import { Module } from '@nestjs/common';

import { AnalyticsController } from './presentation/controllers/analytics.controller';
import { EventCollectorService } from './application/event-collector.service';
import { DashboardMetricsService } from './application/dashboard-metrics.service';
import { PrivacyFilter } from './application/privacy-filter';
import { SelfHostedAnalyticsAdapter } from './infrastructure/adapters/self-hosted-analytics.adapter';
import { PostHogAdapter } from './infrastructure/adapters/posthog.adapter';

/**
 * Sprint 8's Analytics Core. Business logic (EventCollectorService,
 * DashboardMetricsService) has zero dependency on any external
 * provider \u2014 PostHogAdapter is additive and fails silently if
 * unconfigured, never blocking ingestion. This is the AI Core's own
 * "system must remain fully functional without any external provider"
 * principle, applied identically here.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [
    EventCollectorService,
    DashboardMetricsService,
    PrivacyFilter,
    SelfHostedAnalyticsAdapter,
    PostHogAdapter,
  ],
  exports: [EventCollectorService],
})
export class AnalyticsModule {}
