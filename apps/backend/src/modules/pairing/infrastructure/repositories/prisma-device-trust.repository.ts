import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { IDeviceTrustRepository } from '../../application/ports/device-trust.repository.port';
import type { TrustLevelValue } from '../../domain/trust.types';

@Injectable()
export class PrismaDeviceTrustRepository implements IDeviceTrustRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getTrustLevel(deviceId: string): Promise<TrustLevelValue | null> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { trustLevel: true },
    });
    return (device?.trustLevel as TrustLevelValue) ?? null;
  }

  async updateTrustLevel(deviceId: string, trustLevel: TrustLevelValue): Promise<void> {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { trustLevel },
    });
  }
}
