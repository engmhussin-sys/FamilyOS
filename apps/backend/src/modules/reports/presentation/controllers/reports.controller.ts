import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { ReportsService } from '../../application/reports.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get(':childId')
  async getReport(
    @Param('childId') childId: string,
    @Query('deviceId') deviceId: string,
    @Query('format') format: string | undefined,
    @CurrentUser() user: IJwtPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const report = await this.reportsService.generateChildReport(childId, user.familyId!, deviceId);

    if (format === 'csv') {
      const csv = this.reportsService.toCsv(report);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="report-${childId}.csv"`);
      return csv;
    }

    return report;
  }
}
