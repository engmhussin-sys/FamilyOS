import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';

import { ProfileService } from '../../application/profile.service';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

@Controller('profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  @ParentSurface()
  getProfile(@CurrentUser() user: IJwtPayload) {
    return this.profileService.getProfile(user.sub);
  }

  @Patch()
  @ParentSurface()
  updateProfile(@Body() dto: UpdateProfileDto, @CurrentUser() user: IJwtPayload) {
    return this.profileService.updateProfile(user.sub, dto);
  }
}
