import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { FeatureFlagService } from '../../application/feature-flag.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

@Controller('feature-flags')
@UseGuards(JwtAuthGuard)
export class FeatureFlagsController {
  constructor(private readonly featureFlagService: FeatureFlagService) {}

  @Get()
  @ParentSurface()
  listAll() {
    return this.featureFlagService.listAll();
  }

  @Get(':key')
  @ParentSurface()
  async isEnabled(@Param('key') key: string, @CurrentUser() user: IJwtPayload) {
    return { enabled: await this.featureFlagService.isEnabled(key, user.familyId) };
  }
}
