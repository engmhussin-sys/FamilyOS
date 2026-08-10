import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

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
        categoryScores: input.categoryScores as unknown as Prisma.InputJsonValue,
        reasons: input.reasons as unknown as Prisma.InputJsonValue,
      },
    });
    return row as unknown as IRiskAssessmentRecord;
  }

  async findLatestByDevice(deviceId: string): Promise<IRiskAssessmentRecord | null> {
    const row = await this.prisma.deviceRiskAssessment.findFirst({
      where: { deviceId },
      orderBy: { assessedAt: 'desc' },
    });
    return row as unknown as IRiskAssessmentRecord | null;
  }

  async findHistoryByDevice(deviceId: string): Promise<IRiskAssessmentRecord[]> {
    const rows = await this.prisma.deviceRiskAssessment.findMany({
      where: { deviceId },
      orderBy: { assessedAt: 'asc' },
    });
    return rows as unknown as IRiskAssessmentRecord[];
  }
}
