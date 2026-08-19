import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';
import {
  APP_CATALOG_CLIENT_SELECT,
  type IAppCatalogEntryView,
  type IReportedApp,
} from '../../domain/app-catalog.types';
import type { IAppCatalogRepository } from '../../application/ports/screen-time.repository.port';

@Injectable()
export class PrismaAppCatalogRepository implements IAppCatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * THE PARENT READ. Three things are load-bearing here:
   *
   *  - `select: APP_CATALOG_CLIENT_SELECT` — the whitelist, applied in the
   *    REPOSITORY, so `deviceId` and `familyId` are never read out of
   *    PostgreSQL on this path and there is nothing in memory to leak. Same
   *    placement as `CHILD_CLIENT_SELECT` after the `pinCodeHash` incident.
   *  - `device: { childId, deletedAt: null }` — the catalogue is keyed by
   *    DEVICE and the parent surface asks by CHILD, so the join is the query.
   *    A retired device's apps stop appearing without anything deleting them.
   *  - `take: limit` — the caller's stated cap, never an implicit one.
   *
   * The tenant extension injects `familyId` into the top-level `where`, so
   * this cannot cross a family even though the filter above never mentions one.
   */
  listForChild(childId: string, limit: number): Promise<IAppCatalogEntryView[]> {
    return this.prisma.appCatalogEntry.findMany({
      where: { device: { childId, deletedAt: null } },
      select: APP_CATALOG_CLIENT_SELECT,
      // PostgreSQL orders NULLs FIRST on a DESC sort, which would put every
      // never-opened app above the app the child used ten minutes ago. `nulls:
      // 'last'` is Prisma's own NULLS LAST, not a post-hoc sort in JS — a JS
      // sort would be applied AFTER `take`, i.e. to the wrong 500 rows.
      orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { appName: 'asc' }],
      take: limit,
    });
  }

  /**
   * THE DEVICE WRITE, AND WHERE IDEMPOTENCY ACTUALLY LIVES.
   *
   * `upsert` on `deviceId_packageName` compiles to a write against the UNIQUE
   * CONSTRAINT `app_catalog_entries_device_id_package_name_key`. Replaying the
   * same inventory therefore cannot produce a second row — not because
   * anything here checked first, but because the database will not have it.
   *
   * `familyId` comes from `tenantIdForWrite()`, i.e. the verified token's
   * tenant, and the extension additionally stamps it on both branches and
   * scopes the `where`. A device that somehow named another family's row would
   * hit `CrossTenantWriteError` rather than update it.
   *
   * `firstSeenAt` is deliberately absent from `update`: it means "the first
   * time this family's server ever heard of this app on this device", and a
   * re-report is not a first sighting. `create` lets the column default.
   *
   * One transaction for the whole inventory: a report is one fact about one
   * device at one moment, and half of it landing is a state no client asked
   * for. The array form is a single round trip rather than N.
   */
  async upsertDeviceInventory(deviceId: string, apps: IReportedApp[]): Promise<number> {
    if (apps.length === 0) return 0;
    const familyId = tenantIdForWrite();

    const writes = apps.map((app) =>
      this.prisma.appCatalogEntry.upsert({
        where: { deviceId_packageName: { deviceId, packageName: app.packageName } },
        create: {
          familyId,
          deviceId,
          packageName: app.packageName,
          appName: app.appName,
          category: app.category ?? null,
          iconUrl: app.iconUrl ?? null,
          lastUsedAt: app.lastUsedAt ?? null,
        },
        update: {
          appName: app.appName,
          category: app.category ?? null,
          iconUrl: app.iconUrl ?? null,
          lastUsedAt: app.lastUsedAt ?? null,
        },
        select: { id: true },
      }),
    );

    const written = await this.prisma.$transaction(writes);
    return written.length;
  }
}
