import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';

import { SettingsService } from '../../application/settings.service';
import { UpdateSettingsDto } from '../dto/update-settings.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  getSettings(@CurrentUser() user: IJwtPayload) {
    return this.settingsService.getSettings(user.familyId!);
  }

  @Patch()
  updateSettings(@Body() dto: UpdateSettingsDto, @CurrentUser() user: IJwtPayload) {
    return this.settingsService.updateSettings(user.familyId!, dto);
  }
}
