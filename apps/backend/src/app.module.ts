import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { validateEnv } from './config/env.validation';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { ChildrenModule } from './modules/children/children.module';
import { ScreenTimeModule } from './modules/screen-time/screen-time.module';
import { AiAssistantModule } from './modules/ai-assistant/ai-assistant.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { PairingModule } from './modules/pairing/pairing.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { BillingModule } from './modules/billing/billing.module';
import { FeatureFlagsModule } from './modules/feature-flags/feature-flags.module';
import { ProfileModule } from './modules/profile/profile.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SearchModule } from './modules/search/search.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Application-wide default rate limit. Individual endpoints (login,
    // register, pairing/confirm) override this with a stricter @Throttle()
    // — see AuthController / DevicePairingController.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    RedisModule,
    AuthModule,
    ChildrenModule,
    ScreenTimeModule,
    AiAssistantModule,
    ComplianceModule,
    PairingModule,
    NotificationsModule,
    BillingModule,
    FeatureFlagsModule,
    ProfileModule,
    SettingsModule,
    ReportsModule,
    SearchModule,
    AnalyticsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
