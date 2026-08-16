import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import {
  GROWTH_SETTING_SCHEMAS,
  UnknownGrowthSettingError,
  defaultGrowthSetting,
  growthSettingSchema,
  parseGrowthSetting,
} from '../domain/growth-settings';

/**
 * PHASE D (GROWTH) — THE READER AND WRITER FOR EVERY BUSINESS NUMBER.
 *
 * No other service in this module holds a business constant. A referral reward
 * value, a qualification window, an activation threshold and an alert
 * threshold are all `await settings.int('...')` — which means changing any of
 * them is an UPDATE by an admin, not a deploy, which is what the brief
 * requires and what a marketing team will actually need in launch month.
 *
 * TENANCY. `growth_settings` is GLOBAL, so a read needs no tenant — but the
 * tenant extension denies by default when there is no ambient context at all
 * (a scheduled job, a boot path). Every read therefore runs inside a NARROW
 * `runAsSystemAsync`, exactly as `FamilyDateService` does for the same reason.
 * The narrowness is the control: the bypass covers one `findMany` over a table
 * with no `family_id` column.
 *
 * THE CACHE IS 60 SECONDS AND THAT IS A DECISION. A settings read happens on
 * every referral qualification and every alert evaluation; a database round
 * trip per referral is a cost with no benefit. Sixty seconds is short enough
 * that an admin who changes a threshold sees it take effect within a minute
 * (and `invalidate()` makes it immediate for the surface that wrote it), and
 * long enough that the aggregation job's thousands of reads cost one query.
 */
@Injectable()
export class GrowthSettingsService {
  private readonly logger = new Logger(GrowthSettingsService.name);
  private cache: { values: ReadonlyMap<string, string>; readAt: number } | null = null;

  private static readonly CACHE_TTL_MS = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  /** Drops the cache so the next read sees a just-written value. */
  invalidate(): void {
    this.cache = null;
  }

  private async load(): Promise<ReadonlyMap<string, string>> {
    const cached = this.cache;
    if (cached && Date.now() - cached.readAt < GrowthSettingsService.CACHE_TTL_MS) {
      return cached.values;
    }

    let rows: Array<{ key: string; value: string }> = [];
    try {
      rows = await runInSystemScope(
        'ADMIN_CONSOLE',
        'growth_settings is a GLOBAL configuration table with no family_id column; the read spans no tenant.',
        () => this.prisma.growthSetting.findMany({ select: { key: true, value: true } }),
      );
    } catch (err) {
      // A configuration read must never be the reason a referral or an alert
      // fails. Falling back to the documented defaults is the safe direction:
      // the defaults are conservative (a LONGER refund window, a SMALLER
      // reward), so a database blip cannot cause an over-payment.
      this.logger.warn(
        `growth_settings.read_failed — falling back to documented defaults. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      rows = [];
    }

    const values = new Map(rows.map((r) => [r.key, r.value]));
    this.cache = { values, readAt: Date.now() };
    return values;
  }

  /** The parsed value, or the documented default when no row exists. */
  async get(key: string): Promise<number | string | boolean> {
    const schema = growthSettingSchema(key);
    if (!schema) throw new UnknownGrowthSettingError(key);

    const stored = (await this.load()).get(key);
    if (stored === undefined) return defaultGrowthSetting(key);

    try {
      return parseGrowthSetting(key, stored);
    } catch (err) {
      // A stored value that no longer validates (bounds tightened in a later
      // release) must not take the module down. The default is used and the
      // discrepancy is logged loudly, because it means an operator's intent is
      // silently not in force.
      this.logger.error(
        `growth_settings.invalid_stored_value key=${key} value="${stored}" — using the default instead. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return defaultGrowthSetting(key);
    }
  }

  async int(key: string): Promise<number> {
    const value = await this.get(key);
    if (typeof value !== 'number') throw new UnknownGrowthSettingError(key);
    return value;
  }

  async rate(key: string): Promise<number> {
    return this.int(key);
  }

  async text(key: string): Promise<string> {
    const value = await this.get(key);
    return typeof value === 'string' ? value : String(value);
  }

  /**
   * The reporting timezone for a country's day boundary, with the platform
   * default as the fallback. `**` is the platform-wide sentinel used by
   * `growth_daily_metrics`.
   */
  async reportingTimeZone(countryCode: string): Promise<string> {
    const key = countryCode === '**' ? 'reporting.timezone.PLATFORM' : `reporting.timezone.${countryCode}`;
    if (!growthSettingSchema(key)) {
      // A country with no configured zone reports on the platform calendar
      // rather than on UTC. Silently using UTC would mis-bucket exactly the
      // hours around local midnight — the defect B1/B2 removed everywhere else.
      return this.text('reporting.timezone.PLATFORM');
    }
    return this.text(key);
  }

  /** Every setting with its schema and its EFFECTIVE value — the admin surface. */
  async listAll(): Promise<
    Array<{
      key: string;
      value: number | string | boolean;
      isDefault: boolean;
      type: string;
      min: number | null;
      max: number | null;
      descriptionAr: string;
      humanDecision: boolean;
    }>
  > {
    const stored = await this.load();
    const out = [];
    for (const schema of GROWTH_SETTING_SCHEMAS) {
      out.push({
        key: schema.key,
        value: await this.get(schema.key),
        isDefault: !stored.has(schema.key),
        type: schema.type,
        min: schema.min,
        max: schema.max,
        descriptionAr: schema.descriptionAr,
        humanDecision: schema.humanDecision,
      });
    }
    return out;
  }

  /**
   * Writes a value after validating it against its schema. An out-of-bounds
   * or unparseable value THROWS before it reaches the table — a settings table
   * whose contents the code silently reinterprets is exactly as bad as a
   * hardcoded constant and considerably harder to find.
   */
  async set(key: string, rawValue: string, updatedByUserId: string | null): Promise<void> {
    parseGrowthSetting(key, rawValue); // throws on unknown key or invalid value

    await runInSystemScope(
      'ADMIN_CONSOLE',
      'An admin is editing a platform-level growth setting; growth_settings has no family_id column.',
      () =>
        this.prisma.growthSetting.upsert({
          where: { key },
          create: { key, value: rawValue, updatedByUserId },
          update: { value: rawValue, updatedByUserId },
        }),
    );
    this.invalidate();
  }
}
