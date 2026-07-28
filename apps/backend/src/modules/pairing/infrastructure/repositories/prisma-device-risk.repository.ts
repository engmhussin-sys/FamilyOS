import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type {
  IDeviceRiskRepository,
  IRecordRiskAssessmentInput,
} from '../../application/ports/device-risk.repository.port';
import type { IRiskAssessmentRecord } from '../../domain/risk.types';

@Injectable()
export class PrismaDeviceRiskRepository implements IDeviceRiskRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: IRecordRiskAssessmentInput): Promise<IRiskAssessmentRecord> {
    const row = await this.prisma.deviceRiskAssessment.create({
      data: {
        deviceId: input.deviceId,
        overallRisk: input.overallRisk,
        overallLevel: input.overallLevel,
        categoryScores: input.categoryScores,
        reasons: input.reasons,
      },
    });
    return row as IRiskAssessmentRecord;
  }

  async findLatestByDevice(deviceId: string): Promise<IRiskAssessmentRecord | null> {
    return this.prisma.deviceRiskAssessment.findFirst({
      where: { deviceId },
      orderBy: { assessedAt: 'desc' },
    });
  }

  async findHistoryByDevice(deviceId: string): Promise<IRiskAssessmentRecord[]> {
    return this.prisma.deviceRiskAssessment.findMany({
      where: { deviceId },
      orderBy: { assessedAt: 'asc' },
    });
  }
}
