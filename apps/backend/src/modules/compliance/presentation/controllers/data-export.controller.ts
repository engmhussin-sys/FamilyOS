import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { DataExportService } from '../../application/services/data-export.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

@Controller('children/:childId/data-export')
@UseGuards(JwtAuthGuard)
export class DataExportController {
  constructor(private readonly dataExportService: DataExportService) {}

  @Get()
  // Export is more expensive than a normal read (fans out to three
  // services) — modestly throttled rather than left at the app default.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  export(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.dataExportService.exportChildData(childId, user.familyId!);
  }
}
