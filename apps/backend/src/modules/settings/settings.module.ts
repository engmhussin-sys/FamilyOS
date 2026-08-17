import { Module } from '@nestjs/common';

import { GrowthCaptureModule } from '../analytics/growth-capture.module';
import { SettingsController } from './presentation/controllers/settings.controller';
import { SettingsService } from './application/settings.service';
import { CountryCatalogueService } from './application/country-catalogue.service';
import { PrismaSettingsRepository } from './infrastructure/prisma-settings.repository';
import { SETTINGS_REPOSITORY } from './domain/settings.types';

/**
 * F1 — TWO NEW EDGES IN THE MODULE GRAPH, BOTH CHECKED FOR CYCLES.
 *
 *   SettingsModule -> GrowthCaptureModule
 *   `CountryCatalogueService` reads the canonical country -> timezone mapping
 *   from `GrowthSettingsService` (`reporting.timezone.<CC>`) instead of
 *   declaring a second one. `GrowthCaptureModule` IMPORTS NOTHING — that is its
 *   stated design property — so this edge cannot close a cycle.
 *
 *   AuthModule -> SettingsModule (declared in `auth.module.ts`)
 *   Registration must validate a country exactly the way `PATCH /settings`
 *   does, and having ONE implementation of "is this a market we serve" is the
 *   whole point. `SettingsModule` imports only `GrowthCaptureModule`, so the
 *   graph stays Auth -> Settings -> GrowthCapture -> (nothing).
 *   `SettingsController` references `JwtAuthGuard` by class, which is not a
 *   module import and does not create the reverse edge.
 */
@Module({
  imports: [GrowthCaptureModule],
  controllers: [SettingsController],
  providers: [
    SettingsService,
    CountryCatalogueService,
    { provide: SETTINGS_REPOSITORY, useClass: PrismaSettingsRepository },
  ],
  exports: [CountryCatalogueService],
})
export class SettingsModule {}
