import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { ChildSurface, ParentSurface } from '../../../../common/authz/roles.decorator';
import { DeviceJwtAuthGuard, JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { PairingOrchestratorService } from '../../../pairing/application/services/pairing-orchestrator.service';
import { AppCatalogService } from '../../application/services/app-catalog.service';
import { ReportDeviceAppsDto } from '../dto/report-device-apps.dto';

/**
 * PARENT SURFACE — `GET /api/v1/children/:childId/apps`.
 *
 * The other half of `AppBlockRuleController`, which lives one file over at
 * `children/:childId/app-block-rules`: that route takes a package name, this
 * one is where a parent finds out which package names exist on their child's
 * devices. Its own `@Controller` rather than a route on the block-rule
 * controller, for the reason that controller states about itself — the
 * catalogue is not a sub-resource of a rule.
 *
 * `familyId` is read from the VERIFIED TOKEN and passed to the service, which
 * asserts the child belongs to it before any row is read. There is no query
 * parameter, header or body on this route through which a family could be
 * named, so cross-tenant access is not "checked" here, it is unexpressible.
 *
 * The response never carries `deviceId` or `familyId` — see
 * `APP_CATALOG_CLIENT_SELECT`, which is applied in the repository, so those
 * columns are not even read out of PostgreSQL on this path.
 */
@Controller('children/:childId/apps')
@UseGuards(JwtAuthGuard)
export class ChildAppCatalogController {
  constructor(private readonly appCatalog: AppCatalogService) {}

  @Get()
  @ParentSurface()
  listApps(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.appCatalog.listAppsForChild(childId, user.familyId!);
  }
}

/**
 * CHILD SURFACE — `POST /api/v1/self/apps`.
 *
 * THE SECURITY SHAPE, and it is deliberately the SAME PARAGRAPH
 * `ChildAchievementsController` and `ChildCatalogueController` state about
 * themselves, using the same mechanism rather than a new one:
 *
 *   - `@UseGuards(DeviceJwtAuthGuard)` PER ROUTE — the `'device-jwt'` Passport
 *     strategy. A parent token cannot reach this route and a device token
 *     cannot reach the parent controller above. No class-level guard, no
 *     stacked pair, per the pattern F1 established.
 *   - `deviceId` is the VERIFIED TOKEN'S SUBJECT (`device.sub`) and nothing
 *     else. `childId` and `familyId` are the server's own resolution of that
 *     device through `PairingOrchestratorService.getChildAndFamilyIdForDevice`
 *     — called for its ASSERTIONS as much as its answer: it refuses a device
 *     that is not ACTIVE or not paired to a child, so a revoked device holding
 *     an unexpired access token cannot keep writing.
 *   - A body that names a `deviceId`, `childId` or `familyId` is REJECTED, not
 *     obeyed: `ReportDeviceAppsDto` declares no such field and the global
 *     `forbidNonWhitelisted: true` pipe refuses unknown keys. Ignoring them
 *     and rejecting them are the same security answer; rejecting is the one
 *     this application's pipeline already gives everywhere else.
 *
 * NOTHING IS GRANTED HERE. An inventory report cannot move points, unlock a
 * reward, change a policy or approve anything — the only table it can touch is
 * `app_catalog_entries`, and the only rows of it that are reachable are the
 * ones keyed by this device.
 */
@Controller('self/apps')
export class ChildAppInventoryController {
  constructor(
    private readonly appCatalog: AppCatalogService,
    private readonly pairing: PairingOrchestratorService,
  ) {}

  @Post()
  @ChildSurface()
  @UseGuards(DeviceJwtAuthGuard)
  async report(@Body() dto: ReportDeviceAppsDto, @CurrentUser() device: IJwtPayload) {
    // Called for the assertions: ACTIVE, and paired to a child. The returned
    // ids are not needed to write a row keyed by device — the check is.
    await this.pairing.getChildAndFamilyIdForDevice(device.sub);
    return this.appCatalog.reportDeviceInventory(device.sub, dto.apps);
  }
}
