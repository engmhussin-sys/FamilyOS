import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { PairingModule } from '../pairing/pairing.module';
import { AppCatalogService } from './application/services/app-catalog.service';
import { PrismaAppCatalogRepository } from './infrastructure/repositories/prisma-app-catalog.repository';
import { APP_CATALOG_REPOSITORY } from './application/ports/screen-time.repository.port';
import {
  ChildAppCatalogController,
  ChildAppInventoryController,
} from './presentation/controllers/app-catalog.controller';

/**
 * THE APP CATALOGUE — the missing half of `AppBlockRule` — IN ITS OWN NEST
 * MODULE INSIDE THE SCREEN-TIME MODULE'S DIRECTORY, AND THE REASON IS A REAL
 * CYCLE.
 *
 * Everything below is screen-time code and lives in screen-time's own layering
 * (`presentation/controllers`, `presentation/dto`, `application/services`,
 * `application/ports`, `infrastructure/repositories`, `domain`), beside the
 * `AppBlockRule` files it completes. What it cannot do is be registered in
 * `ScreenTimeModule`, because the child surface resolves its device through
 * `PairingOrchestratorService` and:
 *
 *     PairingModule -> ScreenTimeModule        (already true: `getPolicySync`
 *                                               needs `getBlockedPackageNames`)
 *     ScreenTimeModule -> PairingModule        (what registering it there
 *                                               would add)
 *
 * is a genuine cycle, and the only cure for a cycle is `forwardRef` — which
 * `growth-capture.module.ts`, `billing-notifications.module.ts` and
 * `notification-engine.module.ts` each independently refused for the same
 * stated reason: it fails at runtime rather than compile time, in whichever
 * module was loaded second. So the module is split along the line that already
 * exists in the design, exactly as `BillingNotificationsModule` was split out
 * of `BillingModule`: this module IMPORTS and is IMPORTED BY nothing but the
 * root, so the graph stays acyclic and no `forwardRef` is constructible.
 *
 * `ScreenTimeService` is untouched and this module does not import
 * `ScreenTimeModule` — the catalogue is a READ of what a device has, and the
 * block rules are the DECISION about it. They meet on `packageName`, in the
 * Parent App, which is the whole point of building the catalogue.
 */
@Module({
  imports: [ChildrenModule, PairingModule],
  controllers: [ChildAppCatalogController, ChildAppInventoryController],
  providers: [
    AppCatalogService,
    { provide: APP_CATALOG_REPOSITORY, useClass: PrismaAppCatalogRepository },
  ],
  exports: [AppCatalogService],
})
export class AppCatalogModule {}
