import { Module } from '@nestjs/common';

import { TimeModule } from '../../common/time/time.module';
import { DataRetentionModule } from '../data-retention/data-retention.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { EventsModule } from '../events/events.module';
import { LifeIntelligenceModule } from '../life-intelligence/life-intelligence.module';
import { BillingNotificationsModule } from '../billing/billing-notifications.module';
import { JobObservability } from './application/job-observability.service';
import { JobRegistry } from './application/job-registry.service';
import { JobRunner } from './application/job-runner.service';
import { SchedulerService } from './application/scheduler.service';
import { DeadLetterAlertJob } from './application/jobs/dead-letter-alert.job';
import { ExpiredTokenSweepJob } from './application/jobs/expired-token-sweep.job';
import { FamilyDailyRolloverJob } from './application/jobs/family-daily-rollover.job';
import { NotificationDeliverySweepJob } from './application/jobs/notification-delivery-sweep.job';
import { RetentionSweepJob } from './application/jobs/retention-sweep.job';
import { GrowthDailyAggregationJob } from './application/jobs/growth-daily-aggregation.job';
import { GrowthAlertScanJob } from './application/jobs/growth-alert-scan.job';
import { GoalNudgeSweepJob } from './application/jobs/goal-nudge-sweep.job';
import { SchedulerOperationsController } from './presentation/controllers/scheduler-operations.controller';

/**
 * PHASE C P4 (PA-B-031) — THE SCHEDULER.
 *
 * IT IMPORTS THE MODULES THAT ALREADY OWN THE WORK AND ADDS NO SECOND
 * IMPLEMENTATION OF ANY OF IT. That is the shape the brief asked for and it is
 * worth making visible in the imports list:
 *
 *   DataRetentionModule   owns the sweeps. This module gives them a clock.
 *   LifeIntelligenceModule owns `markMissedHabits`. This module gives it a
 *                          caller that is not a human pressing a button once
 *                          per child per day.
 *   EventsModule           owns `OutboxRelay.deadLetters()`. This module gives
 *                          it a reader that runs every five minutes.
 *   TimeModule             owns the family calendar. Nothing here re-derives a
 *                          business date; `job-schedule.ts` composes
 *                          `family-date.ts` and nothing else.
 *   AnalyticsModule        PHASE D (GROWTH): owns the daily aggregate, the
 *                          referral qualification sweep and the eight alert
 *                          rules. This module gives all three a clock and a
 *                          lease, and adds no second implementation of any of
 *                          them — the two job classes below are twenty lines
 *                          each and delegate immediately.
 *
 * NO NEW RUNTIME DEPENDENCY WAS ADDED TO `package.json`. Not
 * `@nestjs/schedule`, not `bullmq`, not `node-cron`. The full argument is in
 * `scheduler.service.ts` and in migration 0011's header; the short form is that
 * the two things a scheduler must have that a timer does not give you — a
 * durable run history and cross-replica exclusion — are a table and a lock,
 * and this deployment already has a PostgreSQL holding both.
 */
@Module({
  imports: [TimeModule, DataRetentionModule, LifeIntelligenceModule, EventsModule, AnalyticsModule, BillingNotificationsModule],
  controllers: [SchedulerOperationsController],
  providers: [
    RetentionSweepJob,
    ExpiredTokenSweepJob,
    DeadLetterAlertJob,
    FamilyDailyRolloverJob,
    NotificationDeliverySweepJob,
    GrowthDailyAggregationJob,
    GrowthAlertScanJob,
    GoalNudgeSweepJob,
    JobRegistry,
    JobRunner,
    JobObservability,
    SchedulerService,
  ],
  exports: [SchedulerService, JobRunner, JobObservability, JobRegistry],
})
export class SchedulerModule {}
