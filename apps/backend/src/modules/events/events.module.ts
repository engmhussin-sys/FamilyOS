import { Module } from '@nestjs/common';

import { LifeIntelligenceModule } from '../life-intelligence/life-intelligence.module';
import { PairingModule } from '../pairing/pairing.module';
import { EVENT_PUBLISHER, EVENT_SUBSCRIBER } from './domain/event-bus.port';
import { InProcessEventBus } from './infrastructure/in-process-event-bus';
import { OutboxWriter } from './application/outbox.writer';
import { OutboxRelay } from './application/outbox.relay';
import { EventIngestionService } from './application/event-ingestion.service';
import { ConsumerIdempotency } from './application/consumers/consumer-idempotency.service';
import { RewardsCompletionConsumer } from './application/consumers/rewards-completion.consumer';
import { NotificationRewardConsumer } from './application/consumers/notification-reward.consumer';
import { StreakDetectionConsumer } from './application/consumers/streak-detection.consumer';
import { EventsController } from './presentation/controllers/events.controller';
import { DeviceEventsThrottlerGuard } from './presentation/guards/device-events-throttler.guard';

/**
 * The event backbone (Sprint F3, risk R3).
 *
 * THE ONE-FILE SWAP PATH. `InProcessEventBus` appears exactly twice below, both
 * times behind a token. Moving to Redis Streams or SQS is:
 *
 *   1. write `infrastructure/redis-streams-event-bus.ts` implementing
 *      `IEventPublisher` + `IEventSubscriber`;
 *   2. change the two `useClass` lines here.
 *
 * Nothing else in the codebase names the implementation — not the relay, not
 * the ingestion service, not one of the three consumers. That is verified, not
 * asserted: `test/events/event-bus.spec.ts` greps the module tree for direct
 * imports of the concrete bus and fails if any file outside this module and its
 * own `infrastructure/` folder has one.
 *
 * NOTE ON THE TWO TOKENS FOR ONE CLASS: publisher and subscriber are separate
 * interfaces on purpose. Consumers get `EVENT_SUBSCRIBER` and so cannot publish
 * (a consumer that could publish directly would bypass the outbox and lose the
 * atomicity the whole design is for); the relay gets `EVENT_PUBLISHER` and so
 * cannot register handlers.
 */
@Module({
  imports: [
    // For RewardsEngineService, SmartNotificationIntegrationService and
    // HabitEngineService — all three already exported by that module. Zero
    // changes were needed there to consume them.
    LifeIntelligenceModule,
    // For PairingOrchestratorService.getChildAndFamilyIdForDevice, which is how
    // a device token becomes a (childId, familyId) without trusting the body.
    PairingModule,
  ],
  controllers: [EventsController],
  providers: [
    InProcessEventBus,
    { provide: EVENT_PUBLISHER, useExisting: InProcessEventBus },
    { provide: EVENT_SUBSCRIBER, useExisting: InProcessEventBus },
    OutboxWriter,
    OutboxRelay,
    EventIngestionService,
    ConsumerIdempotency,
    RewardsCompletionConsumer,
    NotificationRewardConsumer,
    StreakDetectionConsumer,
    DeviceEventsThrottlerGuard,
  ],
  exports: [OutboxWriter, OutboxRelay, EVENT_PUBLISHER, EVENT_SUBSCRIBER],
})
export class EventsModule {}
