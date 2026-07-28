import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { ScreenTimeService } from '../../application/services/screen-time.service';
import { SetScreenTimePolicyDto } from '../dto/set-screen-time-policy.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

@Controller('children/:childId/screen-time-policy')
@UseGuards(JwtAuthGuard)
export class ScreenTimeController {
  constructor(private readonly screenTimeService: ScreenTimeService) {}

  @Get()
  getPolicy(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.screenTimeService.getPolicy(childId, user.familyId!);
  }

  @Post()
  setPolicy(
    @Param('childId') childId: string,
    @Body() dto: SetScreenTimePolicyDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.screenTimeService.setPolicy(childId, user.familyId!, user.sub, dto);
  }
}
