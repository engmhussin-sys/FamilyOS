import { Inject, Injectable } from '@nestjs/common';

import {
  FEATURE_FLAG_REPOSITORY,
  type IFeatureFlagRepository,
} from '../domain/feature-flag.repository.port';
import type { IFeatureFlagClientView, IFeatureFlagSummary } from '../domain/feature-flag.types';

/**
 * Sprint 8's internal Feature Flag engine. "The application should
 * already function without any external feature flag provider" is
 * structural here, not a promise: there is no adapter/provider
 * abstraction at all in this module \u2014 it reads/writes Postgres
 * directly. An external sync (LaunchDarkly, etc.) would be a FUTURE
 * addition that reconciles INTO this table, not a dependency this
 * service has today.
 */
@Injectable()
export class FeatureFlagService {
  constructor(
    @Inject(FEATURE_FLAG_REPOSITORY) private readonly repository: IFeatureFlagRepository,
  ) {}

  async isEnabled(key: string, familyId?: string): Promise<boolean> {
    const flag = await this.repository.findByKey(key);
    if (!flag) return false; // unknown flag = off, never an error
    if (flag.isEnabledGlobally) return true;
    if (familyId && flag.enabledFamilyIds.includes(familyId)) return true;
    return false;
  }

  /**
   * THE CLIENT-FACING LIST. The server takes the decision and sends the
   * decision: one `isEnabledForMe` boolean per flag, evaluated here from the
   * `familyId` on the caller's verified access token.
   *
   * The predecessor of this method returned raw rows, which meant the CLIENT
   * held the rollout allow-list and worked out its own answer — an entitlement
   * decided on the far side of the trust boundary, using the UUIDs of every
   * other family on that list.
   *
   * A caller with no `familyId` (a principal not bound to a household) sees
   * only the globally-enabled flags: absence of a family cannot be an
   * accidental match against an allow-list.
   */
  async listForFamily(familyId?: string): Promise<IFeatureFlagClientView[]> {
    const flags = await this.repository.listAll();
    const allowListed = familyId
      ? new Set((await this.repository.listKeysEnabledForFamily(familyId)).map((f) => f.key))
      : new Set<string>();

    return flags.map((flag) => ({
      key: flag.key,
      isEnabledForMe: flag.isEnabledGlobally || allowListed.has(flag.key),
    }));
  }

  /**
   * OPERATOR/DIAGNOSTIC read: every flag and its GLOBAL state, with no
   * per-family allow-list attached. `GET /system/diagnostics` is its one
   * caller. Kept separate from `listForFamily` so that "what has the
   * deployment switched on?" and "what may this household do?" cannot be
   * answered by the same query by accident.
   */
  listAll(): Promise<IFeatureFlagSummary[]> {
    return this.repository.listAll();
  }

  setGlobalState(key: string, description: string, isEnabledGlobally: boolean) {
    return this.repository.upsert({ key, description, isEnabledGlobally, enabledFamilyIds: [] });
  }

  async enableForFamily(key: string, description: string, familyId: string) {
    const existing = await this.repository.findByKey(key);
    const enabledFamilyIds = existing ? [...new Set([...existing.enabledFamilyIds, familyId])] : [familyId];
    await this.repository.upsert({
      key,
      description,
      isEnabledGlobally: existing?.isEnabledGlobally ?? false,
      enabledFamilyIds,
    });
  }
}
