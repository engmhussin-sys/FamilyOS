import { Inject, Injectable } from '@nestjs/common';

import {
  FEATURE_FLAG_REPOSITORY,
  type IFeatureFlagRepository,
} from '../domain/feature-flag.repository.port';

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

  listAll() {
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
