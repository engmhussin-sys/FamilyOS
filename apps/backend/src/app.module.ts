import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { RedisService } from './common/redis/redis.service';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { validateEnv } from './config/env.validation';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { TimeModule } from './common/time/time.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { TenantContextInterceptor } from './common/tenancy/tenant-context.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { ChildrenModule } from './modules/children/children.module';
import { FamiliesModule } from './modules/families/families.module';
import { ScreenTimeModule } from './modules/screen-time/screen-time.module';
import { AppCatalogModule } from './modules/screen-time/app-catalog.module';
import { AiAssistantModule } from './modules/ai-assistant/ai-assistant.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { SupportModule } from './modules/support/support.module';
import { AccountDeletionModule } from './modules/account-deletion/account-deletion.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { PairingModule } from './modules/pairing/pairing.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { NotificationEngineModule } from './modules/notification-engine/notification-engine.module';
import { BillingModule } from './modules/billing/billing.module';
import { BillingNotificationsModule } from './modules/billing/billing-notifications.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { ProfileModule } from './modules/profile/profile.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SearchModule } from './modules/search/search.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { HealthModule } from './modules/health/health.module';
import { OperatorsModule } from './modules/operators/operators.module';
import { AuditModule } from './modules/audit/audit.module';
import { SystemDiagnosticsModule } from './modules/system-diagnostics/system-diagnostics.module';
import { DataRetentionModule } from './modules/data-retention/data-retention.module';
import { ConfigurationModule } from './config/configuration.module';
import { LifeIntelligenceModule } from './modules/life-intelligence/life-intelligence.module';
import { EventsModule } from './modules/events/events.module';
import { RewardsEngineModule } from './modules/rewards-engine/rewards-engine.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ConfigurationModule,
    AuditModule,
    // SPRINT F2. Identity for platform staff. No controller yet — see the
    // module header for why the forty-five existing routes are not moved in
    // the same change that creates the way in.
    OperatorsModule,
    // Application-wide default rate limit. Individual endpoints (login,
    // register, pairing/accept) override this with a stricter @Throttle()
    // — see AuthController / PairingController.
    //
    // SA-004: counters live in Redis, not in an in-process Map. With the
    // default storage every limit silently multiplies by the replica
    // count and resets on every deploy. RedisModule is @Global, so
    // RedisService resolves here without importing it.
    //
    // Graceful degradation is deliberate and load-bearing for the test
    // suite: unit tests (and test/app.module.spec.ts) replace
    // RedisService with a stub that has no `getRawClient`, and the
    // throttler then falls back to the in-memory storage rather than
    // opening a socket. Production always has the real service.
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redisService: RedisService) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        storage:
          typeof redisService?.getRawClient === 'function'
            ? new RedisThrottlerStorage(redisService.getRawClient())
            : undefined,
      }),
    }),
    PrismaModule,
    RedisModule,
    // B2 (PA-B-001). @Global, imported right after PrismaModule because it
    // depends on PrismaService and every engine below depends on it: it is the
    // ONE implementation of "which calendar day is it for this family".
    TimeModule,
    AuthModule,
    // PHASE C. Leaf module owning the family-membership surface (roster,
    // ownership transfer, co-parent removal). Placed next to ChildrenModule
    // because it is the same layer: the family graph itself, not an engine
    // over it.
    FamiliesModule,
    ChildrenModule,
    ScreenTimeModule,
    // The app catalogue: screen-time code, in screen-time's directory, in its
    // own Nest module because its child surface needs `PairingModule` and
    // `PairingModule -> ScreenTimeModule` already exists. Registered here for
    // the same reason `BillingNotificationsModule` is — it is imported by
    // nothing, so removing this line silently un-ships two routes rather than
    // breaking a build. `app-catalog.module.ts` has the full reasoning.
    AppCatalogModule,
    AiAssistantModule,
    ComplianceModule,
    SupportModule,
    AccountDeletionModule,
    OrganizationModule,
    PairingModule,
    NotificationsModule,
    // PHASE F (`F6-002`): the smart notification DECISION layer. It imports
    // `NotificationsModule` and `LifeIntelligenceModule` and is imported by
    // neither — the one-way direction that keeps the graph acyclic without a
    // `forwardRef`.
    NotificationEngineModule,
    BillingModule,
    // SPRINT F1: billing's one door to the engine above. It is `@Global` and
    // imported by nothing, because `BillingModule -> NotificationEngineModule`
    // is a measured cycle (`billing-notifications.module.ts` has the Nest error
    // verbatim). Registered here so that removing it breaks
    // `PaymentWebhookService` at BOOT rather than silently un-producing
    // `PAYMENT_FAILED` — which is `PF-E-001`, the defect this producer closes.
    BillingNotificationsModule,
    FeatureFlagsModule,
    ProfileModule,
    SettingsModule,
    ReportsModule,
    SearchModule,
    AnalyticsModule,
    HealthModule,
    SystemDiagnosticsModule,
    DataRetentionModule,
    LifeIntelligenceModule,
    // F3 (R3). Imported LAST on purpose: EventsModule imports
    // LifeIntelligenceModule and PairingModule to reach the Rewards Engine, the
    // Smart Notification pipeline and the device->child resolution, so the
    // dependency edge runs Events -> those, never the other way. Nothing in an
    // existing module imports EventsModule, which is why adding it here changed
    // no existing behaviour: the backbone is wired IN FRONT of the engines, not
    // through them.
    EventsModule,
    // F4 (Smart Learning & Reward Engine). Imported AFTER EventsModule for the
    // same reason: it depends on the backbone (OutboxWriter, EVENT_SUBSCRIBER,
    // ConsumerIdempotency) and nothing in the backbone depends on it.
    RewardsEngineModule,
    // PHASE C P4 (PA-B-031): the scheduler. Registering the module only builds
    // the graph; the poller is started by `main.ts`, exactly like the outbox
    // relay, so instantiating AppModule in a test does not start a timer.
    SchedulerModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // F2 (R8, CONTEXT §3.3). Global on purpose: a controller added tomorrow is
    // covered without anyone remembering to opt in, and a request that carries
    // no verified familyId gets NO tenant context — which makes every
    // tenant-scoped Prisma call on it throw rather than return everything.
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Sprint 9: applied to every route, including /health — a health
    // check's own logs should be correlation-ID-tagged too, for the rare
    // case a probe itself needs debugging.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
