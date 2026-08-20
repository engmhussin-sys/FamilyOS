import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { currentContext, runWithTenant } from '../tenancy/tenant-context';
import {
  DEFAULT_FAMILY_TIMEZONE,
  addBusinessDays,
  businessAgeInYears,
  businessDateDaysAgo,
  getBusinessDate,
  getBusinessDayOfWeek,
  getBusinessDayRange,
  getBusinessTimeHHMM,
  getEndOfBusinessDay,
  getStartOfBusinessDay,
  isSameBusinessDay,
  nextLocalTimeAfter,
  resolveTimeZone,
  type BusinessDate,
} from './family-date';

/** How long a family's timezone is trusted from cache. A parent changing it in
 * settings is a rare, non-urgent event; a database round trip on every streak
 * calculation is not. `invalidate()` makes the change immediate anyway. */
const TIMEZONE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * THE ONE PLACE `Family.timezone` IS READ.
 *
 * Before B2 that column (`schema.prisma:321`, present since 0001) had exactly
 * one reader in the entire backend — `prisma-settings.repository.ts`, which
 * echoes it back to the parent who just wrote it. It was an ORPHAN FIELD: the
 * schema, the API and the mobile settings screen all implied the product
 * understood timezones, and no calculation anywhere used it. That is worse than
 * a missing column, because it looks solved.
 *
 * This service is the seam between that column and `family-date.ts`. Everything
 * that needs to know what day it is for a family asks here, and nothing else
 * queries `family.timezone`.
 *
 * ON THE TENANT EXTENSION. `Family` is a SELF_TENANT model (scoped by `id`), so
 * this read is automatically constrained to the caller's own family by
 * `tenant.extension.ts`. Passing another family's id returns nothing rather
 * than that family's timezone — the isolation is structural here too. When the
 * read fails for any reason (no tenant context on a background path, a deleted
 * family) the service degrades to UTC and logs it, because a reward grant must
 * not fail because a calendar lookup did.
 *
 * ONE FAMILY = ONE CALENDAR. There is deliberately no `Child.timezone` and no
 * per-device override. The travelling-child case is a product decision that has
 * not been taken (Phase A §24, open question 11); inventing a second source of
 * truth for it here would violate CONTEXT §3 principle 1.
 */
@Injectable()
export class FamilyDateService {
  private readonly logger = new Logger(FamilyDateService.name);
  private readonly cache = new Map<string, { timeZone: string; readAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** The family's IANA zone, validated. Never throws, never returns garbage. */
  async timeZoneOf(familyId: string): Promise<string> {
    const cached = this.cache.get(familyId);
    if (cached && Date.now() - cached.readAt < TIMEZONE_CACHE_TTL_MS) return cached.timeZone;

    let timeZone = DEFAULT_FAMILY_TIMEZONE;
    try {
      const family = await this.readFamily(familyId);
      timeZone = resolveTimeZone(family?.timezone);
    } catch (err) {
      // A calendar lookup must never be the reason a completion is lost.
      this.logger.warn(
        `family_date.timezone_lookup_failed family=${familyId.slice(0, 8)} — falling back to ${DEFAULT_FAMILY_TIMEZONE}. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return DEFAULT_FAMILY_TIMEZONE;
    }

    this.cache.set(familyId, { timeZone, readAt: Date.now() });
    return timeZone;
  }

  /** Called by the settings write path so a timezone change takes effect now. */
  invalidate(familyId: string): void {
    this.cache.delete(familyId);
  }

  /**
   * THE ONE READ, AND WHY IT IS SCOPED THE WAY IT IS.
   *
   * With an ambient TENANT context (every HTTP request, and every consumer the
   * outbox relay wakes inside `runWithTenant`), the read runs under it and the
   * extension pins `id` to the CALLER's family. Asking about another family's
   * calendar from inside a request returns nothing, not that family's zone.
   *
   * With NO ambient context — a scheduled job, a bootstrap path, a unit test —
   * a tenant-scoped read throws `TenantContextMissingError` by design, and the
   * catch above would silently answer "UTC" for a Cairo family. Silently
   * wrong is the failure mode this whole sprint exists to remove, so instead a
   * context is established FOR THE FAMILY BEING ASKED ABOUT, using the same
   * `runWithTenant` the relay uses. That is not a bypass: it narrows the read
   * to exactly one family, and the `familyId` reaching this method is always
   * server-derived (device row, JWT claim, or outbox message column) — the
   * `familyId` NEVER comes from a client (CONTEXT §3 principle 3).
   */
  private async readFamily(familyId: string): Promise<{ timezone: string } | null> {
    const read = (): Promise<{ timezone: string } | null> =>
      this.prisma.family.findFirst({ where: { id: familyId }, select: { timezone: true } });

    if (currentContext() !== undefined) return read();

    // `await` INSIDE the scope, deliberately. A `PrismaPromise` is LAZY: it
    // executes when `.then` is attached, not when it is constructed. Passing
    // `read` straight through would build the query inside this
    // AsyncLocalStorage scope and then run it outside — the extension would see
    // no context and deny by default. The F3 fixtures document the same trap.
    return runWithTenant(
      { familyId, actorType: 'SYSTEM', actorId: 'FamilyDateService' },
      async () => await read(),
    );
  }

  // --- the four required primitives, family-bound ---------------------------

  async getBusinessDate(familyId: string, instant: Date | string | number = new Date()): Promise<BusinessDate> {
    return getBusinessDate(instant, await this.timeZoneOf(familyId));
  }

  async getStartOfBusinessDay(
    familyId: string,
    dateOrInstant: Date | string | number = new Date(),
  ): Promise<Date> {
    return getStartOfBusinessDay(dateOrInstant, await this.timeZoneOf(familyId));
  }

  async getEndOfBusinessDay(
    familyId: string,
    dateOrInstant: Date | string | number = new Date(),
  ): Promise<Date> {
    return getEndOfBusinessDay(dateOrInstant, await this.timeZoneOf(familyId));
  }

  async isSameBusinessDay(
    familyId: string,
    a: Date | string | number,
    b: Date | string | number,
  ): Promise<boolean> {
    return isSameBusinessDay(a, b, await this.timeZoneOf(familyId));
  }

  // --- the derived helpers the 20 migrated sites actually call --------------

  /** `{ start, endExclusive }` for a `gte`/`lt` day query. */
  async getBusinessDayRange(
    familyId: string,
    dateOrInstant: Date | string | number = new Date(),
  ): Promise<{ start: Date; endExclusive: Date }> {
    return getBusinessDayRange(dateOrInstant, await this.timeZoneOf(familyId));
  }

  /** `YYYY-MM-DD`, `days` calendar days before today on the family's calendar. */
  async businessDateDaysAgo(
    familyId: string,
    days: number,
    instant: Date | string | number = new Date(),
  ): Promise<BusinessDate> {
    return businessDateDaysAgo(instant, days, await this.timeZoneOf(familyId));
  }

  /**
   * The UTC midnight `Date` that represents a business date in a `@db.Date`
   * column. Prisma stores `@db.Date` as UTC midnight, so a business date is
   * PERSISTED as `YYYY-MM-DDT00:00:00Z` and INTERPRETED as a family-local day.
   * That is a storage convention, not a UTC calculation — the family's calendar
   * decided which `YYYY-MM-DD` it is before this function is reached.
   */
  static toDateColumn(date: BusinessDate): Date {
    return new Date(`${date}T00:00:00.000Z`);
  }

  /** Local wall-clock `HH:MM` — the input to quiet hours. */
  async getBusinessTimeHHMM(
    familyId: string,
    instant: Date | string | number = new Date(),
  ): Promise<string> {
    return getBusinessTimeHHMM(instant, await this.timeZoneOf(familyId));
  }

  /**
   * PHASE D (`PC-D-005`) — the instant this family's clock next reads `HH:MM`.
   * The scheduled delivery time of a quiet-hours-deferred notification,
   * computed on the family's calendar and nowhere else.
   */
  async nextLocalTimeAfter(
    familyId: string,
    hhmm: string,
    now: Date | string | number = new Date(),
  ): Promise<Date> {
    return nextLocalTimeAfter(now, hhmm, await this.timeZoneOf(familyId));
  }

  /** 0 = Sunday .. 6 = Saturday, on the family's calendar. */
  async getBusinessDayOfWeek(
    familyId: string,
    dateOrInstant: Date | string | number = new Date(),
  ): Promise<number> {
    return getBusinessDayOfWeek(dateOrInstant, await this.timeZoneOf(familyId));
  }

  /** Whole years on the family's calendar. */
  async ageInYears(
    familyId: string,
    dateOfBirth: Date | string,
    asOf: Date | string | number = new Date(),
  ): Promise<number> {
    return businessAgeInYears(dateOfBirth, asOf, await this.timeZoneOf(familyId));
  }

  /** Re-exported so a caller that already holds a business date never reaches
   * for `Date` arithmetic to move a day. */
  static addDays(date: BusinessDate, days: number): BusinessDate {
    return addBusinessDays(date, days);
  }
}
