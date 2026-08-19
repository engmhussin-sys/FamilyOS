import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { FeatureFlagService } from '../../application/feature-flag.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface } from '../../../../common/authz/roles.decorator';
import type { IFeatureFlagClientView } from '../../domain/feature-flag.types';

/**
 * THE SERIALIZATION BOUNDARY FOR FEATURE FLAGS.
 *
 * `GET /feature-flags` used to return `featureFlag.findMany()` verbatim. Behind
 * `JwtAuthGuard` + `@ParentSurface()` that meant ANY parent, in ANY family,
 * received `enabledFamilyIds` — the per-family rollout allow-list, a
 * `String[] @db.Uuid` of OTHER TENANTS' family ids, the very key this API
 * authorizes on — together with the names and descriptions of features that had
 * not shipped. Exactly the shape of the `GET /children` defect that returned a
 * child's PIN hash inside the raw Prisma row.
 *
 * The handler now declares `IFeatureFlagClientView` as its return type, so it
 * is `tsc` — not a reviewer's memory — that stops a wider object from reaching
 * a client. That type is `{ key, isEnabledForMe }`: the DECISION, taken on the
 * server from the `familyId` on the verified access token. The client is never
 * handed the allow-list and asked to evaluate itself, because a client that
 * evaluates its own entitlement can simply assert it.
 *
 * `feature-flag.types.ts` carries the field-by-field argument for what is kept
 * and what is gone.
 */
@Controller('feature-flags')
@UseGuards(JwtAuthGuard)
export class FeatureFlagsController {
  constructor(private readonly featureFlagService: FeatureFlagService) {}

  @Get()
  @ParentSurface()
  listAll(@CurrentUser() user: IJwtPayload): Promise<IFeatureFlagClientView[]> {
    return this.featureFlagService.listForFamily(user.familyId);
  }

  @Get(':key')
  @ParentSurface()
  async isEnabled(
    @Param('key') key: string,
    @CurrentUser() user: IJwtPayload,
  ): Promise<{ enabled: boolean }> {
    return { enabled: await this.featureFlagService.isEnabled(key, user.familyId) };
  }
}
