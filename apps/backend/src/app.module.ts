import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { RedisService } from './common/redis/redis.service';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { APP_GUARD } from '@nestjs/core';

import { validateEnv } from './config/env.validation';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { AuthModule } from './modules/auth/auth.module';
import { ChildrenModule } from './modules/children/children.module';
import { ScreenTimeModule } from './modules/screen-time/screen-time.module';
import { AiAssistantModule } from './modules/ai-assistant/ai-assistant.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { SupportModule } from './modules/support/support.module';
import { AccountDeletionModule } from './modules/account-deletion/account-deletion.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { PairingModule } from './modules/pairing/pairing.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { BillingModule } from './modules/billing/billing.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { ProfileModule } from './modules/profile/profile.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SearchModule } from './modules/search/search.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { HealthModule } from './modules/health/health.module';
import { AuditModule } from './modules/audit/audit.module';
import { SystemDiagnosticsModule } from './modules/system-diagnostics/system-diagnostics.module';
import { DataRetentionModule } from './modules/data-retention/data-retention.module';
import { ConfigurationModule } from './config/configuration.module';
import { LifeIntelligenceModule } from './modules/life-intelligence/life-intelligence.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ConfigurationModule,
    AuditModule,
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
    AuthModule,
    ChildrenModule,
    ScreenTimeModule,
    AiAssistantModule,
    ComplianceModule,
    SupportModule,
    AccountDeletionModule,
    OrganizationModule,
    PairingModule,
    NotificationsModule,
    BillingModule,
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
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Sprint 9: applied to every route, including /health — a health
    // check's own logs should be correlation-ID-tagged too, for the rare
    // case a probe itself needs debugging.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
