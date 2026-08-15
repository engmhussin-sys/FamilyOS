import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AiDiagnosticsService } from '../../application/services/ai-diagnostics.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

@Controller('ai-core')
export class AiCoreController {
  constructor(private readonly aiDiagnosticsService: AiDiagnosticsService) {}

  @Get('device-health/:deviceId')
  @ParentSurface()
  @UseGuards(JwtAuthGuard)
  // A real (if cheaper than the Assistant's) LLM call each time —
  // throttled for the same cost-bounding reason as ai-assistant's ask endpoint.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  getDeviceHealth(@Param('deviceId') deviceId: string, @CurrentUser() user: IJwtPayload) {
    return this.aiDiagnosticsService.diagnoseDeviceHealth(deviceId, user.familyId!);
  }
}
