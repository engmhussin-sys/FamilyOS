import { Prisma } from '@prisma/client';

/**
 * THE ONE PLACE THAT DECIDES WHAT A PARENT MAY SEE OF AN APP CATALOGUE ROW.
 *
 * Same discipline as `CHILD_CLIENT_SELECT` in `children/domain/child.types.ts`,
 * and for the same reason it was written: a repository that returns the raw
 * Prisma row exports every column the schema grows tomorrow. `AppCatalogEntry`
 * carries two columns that have no business on a parent's screen:
 *
 *  - `deviceId` — an internal identifier for a paired device. The parent
 *    surface addresses APPS, per child; `GET /children/:childId/apps` merges
 *    every device that child owns, so a device id in the payload would be an
 *    id the client cannot use and must not start keying on.
 *  - `familyId` — the caller's own tenant, already carried by the token that
 *    authorised the call. Nothing is gained by repeating it, and every field
 *    that repeats it is a field a future response shape has to keep honest.
 *
 * `createdAt` / `updatedAt` are row bookkeeping: `firstSeenAt` and `lastUsedAt`
 * are the two timestamps that mean something to a human, and they are here.
 *
 * The type below is DERIVED from this select rather than restated, so widening
 * one without the other is not expressible.
 */
export const APP_CATALOG_CLIENT_SELECT = {
  id: true,
  packageName: true,
  appName: true,
  category: true,
  iconUrl: true,
  firstSeenAt: true,
  lastUsedAt: true,
} as const satisfies Prisma.AppCatalogEntrySelect;

/** An app catalogue row as anything outside the repository may see it. */
export type IAppCatalogEntryView = Prisma.AppCatalogEntryGetPayload<{
  select: typeof APP_CATALOG_CLIENT_SELECT;
}>;

/**
 * THE CAP ON THE PARENT READ, STATED RATHER THAN IMPLIED.
 *
 * A child can own more than one device and an Android device reports a few
 * hundred packages including system ones, so "every row for this child" is an
 * unbounded query in the only place it matters — the request a parent makes
 * while looking at a picker. 500 is roughly two devices' worth of real apps;
 * the response is ordered most-recently-used first, so the rows a cap could
 * ever drop are the ones a parent is least likely to be looking for.
 *
 * It is a CAP, not a page: there is no cursor in the contract this closes, and
 * inventing one that no client asked for would be a second thing to keep
 * honest. When a client needs paging, this constant is where it starts.
 */
export const APP_CATALOG_PARENT_RESULT_CAP = 500;

/**
 * THE CAP ON ONE INVENTORY REPORT. A device has hundreds of apps, not
 * thousands — 500 is above every real Android inventory we have seen and far
 * below the size at which one request could hold a transaction open long
 * enough to matter. A device with more than this splits its report; it does
 * not get to decide how much work one call costs the server.
 */
export const MAX_APPS_PER_INVENTORY_REPORT = 500;

/**
 * A REAL ANDROID PACKAGE SHAPE, not "any non-empty string".
 *
 * Android's own rule (`PackageParser.validateName`): at least two segments
 * separated by dots, each segment starting with a letter and continuing with
 * letters, digits or underscores. Enforcing it here is what stops the
 * catalogue from becoming a free-text store that an `AppBlockRule` can then
 * point at — the two halves have to agree about what a package name IS.
 */
export const ANDROID_PACKAGE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export const MAX_PACKAGE_NAME_LENGTH = 255;
export const MAX_APP_NAME_LENGTH = 100;
export const MAX_CATEGORY_LENGTH = 50;
export const MAX_ICON_URL_LENGTH = 512;

/**
 * HOW FAR AHEAD OF THE SERVER A DEVICE'S CLOCK MAY BE BEFORE ITS
 * `lastUsedAt` IS TREATED AS A LIE RATHER THAN AS SKEW. Five minutes is
 * ordinary phone clock drift; a value beyond it is not drift.
 */
export const LAST_USED_AT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** One app as a device reports it, AFTER DTO validation. */
export interface IReportedApp {
  packageName: string;
  appName: string;
  category?: string;
  iconUrl?: string;
  lastUsedAt?: Date;
}
