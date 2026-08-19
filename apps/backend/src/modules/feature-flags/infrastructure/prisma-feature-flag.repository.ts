import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  IFeatureFlagRecord,
  IFeatureFlagRepository,
} from '../domain/feature-flag.repository.port';
import {
  FEATURE_FLAG_EVALUATION_SELECT,
  FEATURE_FLAG_KEY_SELECT,
  FEATURE_FLAG_ROSTER_SELECT,
  type IFeatureFlagEvaluation,
  type IFeatureFlagKey,
  type IFeatureFlagSummary,
} from '../domain/feature-flag.types';

/**
 * EVERY QUERY BELOW NAMES A `select`. That is the whole security property.
 *
 * `listAll` used to be `findMany({ orderBy: … })` with no projection at all,
 * and its rows went to a parent verbatim — so `enabled_family_ids`, a column of
 * OTHER TENANTS' family UUIDs, was read out of Postgres and put on the wire on
 * a route any authenticated parent can call. Only `findByKey` selects that
 * column now, it is the evaluation path, and it returns to a boolean rather
 * than to a controller.
 *
 * Because the projections are constants in `feature-flag.types.ts` and the
 * return types are derived from them, a column added to `FeatureFlag` later is
 * invisible on every path here until somebody adds it to a whitelist on
 * purpose.
 */
@Injectable()
export class PrismaFeatureFlagRepository implements IFeatureFlagRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByKey(key: string): Promise<IFeatureFlagEvaluation | null> {
    return this.prisma.featureFlag.findUnique({
      where: { key },
      select: FEATURE_FLAG_EVALUATION_SELECT,
    });
  }

  listAll(): Promise<IFeatureFlagSummary[]> {
    return this.prisma.featureFlag.findMany({
      orderBy: { key: 'asc' },
      select: FEATURE_FLAG_ROSTER_SELECT,
    });
  }

  /**
   * Membership is asked as a `where` clause, not computed in this process from
   * a list it fetched. `familyId` comes from the caller's verified access
   * token, so the only tenant id that ever enters this filter is the caller's
   * own, and the only rows that come back are keys.
   */
  listKeysEnabledForFamily(familyId: string): Promise<IFeatureFlagKey[]> {
    return this.prisma.featureFlag.findMany({
      where: { enabledFamilyIds: { has: familyId } },
      orderBy: { key: 'asc' },
      select: FEATURE_FLAG_KEY_SELECT,
    });
  }

  async upsert(record: IFeatureFlagRecord): Promise<void> {
    await this.prisma.featureFlag.upsert({
      where: { key: record.key },
      update: record,
      create: record,
    });
  }
}
