import type { ScreenTimePolicy } from '@prisma/client';
import type { IAppBlockRule, ICreateAppBlockRuleInput, ISetScreenTimePolicyInput } from '../../domain/screen-time.types';
import type { IAppCatalogEntryView, IReportedApp } from '../../domain/app-catalog.types';

export const SCREEN_TIME_POLICY_REPOSITORY = Symbol('SCREEN_TIME_POLICY_REPOSITORY');

export interface IScreenTimePolicyRepository {
  create(
    childId: string,
    createdByUserId: string,
    input: ISetScreenTimePolicyInput,
  ): Promise<ScreenTimePolicy>;
  findActiveByChild(childId: string): Promise<ScreenTimePolicy | null>;
  deactivate(policyId: string): Promise<void>;
}

/**
 * F4. The bonus minutes a child has EARNED and not yet used up, read at policy
 * time. A port rather than a direct Prisma call for the same reason the two
 * above are ports: `ScreenTimeService` is the one place the effective allowance
 * is computed, and it must stay testable without a database.
 */
export const SCREEN_TIME_BONUS_REPOSITORY = Symbol('SCREEN_TIME_BONUS_REPOSITORY');

export interface IScreenTimeBonusGrant {
  id: string;
  minutes: number;
  grantedAt: Date;
  expiresAt: Date;
}

export interface IScreenTimeBonusRepository {
  /** ACTIVE = not revoked and not expired at `now`. */
  listActiveGrants(childId: string, now: Date): Promise<IScreenTimeBonusGrant[]>;
}

export const APP_BLOCK_RULE_REPOSITORY = Symbol('APP_BLOCK_RULE_REPOSITORY');

export interface IAppBlockRuleRepository {
  create(childId: string, createdByUserId: string, input: ICreateAppBlockRuleInput): Promise<IAppBlockRule>;
  findById(ruleId: string): Promise<IAppBlockRule | null>;
  listActiveByChild(childId: string): Promise<IAppBlockRule[]>;
  deactivate(ruleId: string): Promise<void>;
}

/**
 * THE MISSING HALF OF `AppBlockRule`. A rule names a package; until this port
 * existed nothing in the codebase ever WROTE the table that says which
 * packages a child's devices actually have, so a parent could only block an
 * app by typing a raw Android package name from memory.
 *
 * A port rather than a direct Prisma call, for the same reason as the three
 * above: the service that decides what a parent may see and what a device may
 * write has to stay testable without a database.
 */
export const APP_CATALOG_REPOSITORY = Symbol('APP_CATALOG_REPOSITORY');

export interface IAppCatalogRepository {
  /**
   * Every app across every device the child owns, most-recently-used first
   * (nulls last), then by name. `limit` is a hard cap the caller states — the
   * repository never answers "all rows".
   */
  listForChild(childId: string, limit: number): Promise<IAppCatalogEntryView[]>;

  /**
   * Writes one device's inventory. Idempotent by the `(device_id,
   * package_name)` UNIQUE CONSTRAINT — never by a read-then-decide in this
   * process. Returns the number of rows written (= the number of apps given,
   * which the caller has already de-duplicated).
   */
  upsertDeviceInventory(deviceId: string, apps: IReportedApp[]): Promise<number>;
}
