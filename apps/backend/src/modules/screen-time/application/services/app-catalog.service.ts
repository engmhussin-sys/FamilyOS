import { Inject, Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import {
  APP_CATALOG_PARENT_RESULT_CAP,
  type IAppCatalogEntryView,
  type IReportedApp,
} from '../../domain/app-catalog.types';
import { APP_CATALOG_REPOSITORY, type IAppCatalogRepository } from '../ports/screen-time.repository.port';

/**
 * CLOSES A REAL GAP: `AppCatalogEntry` has existed in `schema.prisma` since the
 * device-inventory work, mapped, indexed and uniquely constrained, and NOTHING
 * in this codebase read or wrote it. `AppBlockRule` — the other half — has a
 * repository, a service and a controller, so today a parent can block an app
 * only by typing a raw Android package name from memory. This service is the
 * catalogue that makes that a pick instead of a guess.
 *
 * Built the way `ScreenTimeService` in this same module already was: same
 * repository-port indirection, same `assertChildBelongsToFamily` ownership
 * check on every parent-facing read, same "non-existence and
 * ownership-mismatch fail identically" discipline (that assertion throws
 * `NotFoundException`, never `Forbidden`, so the answer never confirms that
 * another family's child exists).
 *
 * DELIBERATELY NOT AUDITED, and this is the one place it differs from
 * `ScreenTimeService`. Every write there is a PARENT DECISION — a policy
 * changed, an app blocked — which is exactly what an audit trail is for. An
 * inventory report is a device restating a fact about itself on every sync;
 * auditing it would add a row per device per sync and bury the parental
 * decisions the log exists to preserve. For the same reason NO DOMAIN EVENT is
 * emitted: a list of installed apps is not a life event, and this repository's
 * event catalogue has no member it could honestly be.
 */
@Injectable()
export class AppCatalogService {
  constructor(
    private readonly childrenService: ChildrenService,
    @Inject(APP_CATALOG_REPOSITORY)
    private readonly appCatalogRepository: IAppCatalogRepository,
  ) {}

  /**
   * THE PARENT READ. `familyId` is the caller's own, taken from the verified
   * token by the controller; `assertChildBelongsToFamily` is what makes a
   * child id from another household a 404 rather than a peek.
   */
  async listAppsForChild(childId: string, familyId: string): Promise<{ items: IAppCatalogEntryView[] }> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    const items = await this.appCatalogRepository.listForChild(childId, APP_CATALOG_PARENT_RESULT_CAP);
    return { items };
  }

  /**
   * THE DEVICE WRITE. `deviceId` is the SERVER's resolution of the token
   * subject, and the caller has already re-asserted through
   * `PairingOrchestratorService.getChildAndFamilyIdForDevice` that the device
   * is ACTIVE and paired to a child — so a revoked device holding a
   * still-valid access token cannot keep filing inventories.
   *
   * Two normalisations happen here and nowhere else:
   *
   *  1. DE-DUPLICATION by package name, last occurrence winning. The unique
   *     constraint would refuse the second write of a package inside one
   *     transaction anyway; collapsing it here means a device that lists an
   *     app twice gets an honest `upserted` count instead of a 500.
   *  2. CLAMPING `lastUsedAt` to the server's `now`. The DTO has already
   *     refused anything more than five minutes ahead as a claim rather than
   *     clock drift; what survives is clamped so that NO future timestamp is
   *     ever stored, whatever the device's clock says. The server is
   *     authoritative about when "now" is — a child must not be able to pin
   *     an app to the top of a parent's most-recently-used list by editing the
   *     device clock.
   */
  async reportDeviceInventory(
    deviceId: string,
    apps: IReportedApp[],
    now: Date = new Date(),
  ): Promise<{ upserted: number }> {
    const byPackage = new Map<string, IReportedApp>();
    for (const app of apps) {
      byPackage.set(app.packageName, {
        ...app,
        lastUsedAt: app.lastUsedAt && app.lastUsedAt > now ? now : app.lastUsedAt,
      });
    }

    const upserted = await this.appCatalogRepository.upsertDeviceInventory(deviceId, [...byPackage.values()]);
    return { upserted };
  }
}
