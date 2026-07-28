import { Injectable } from '@nestjs/common';
import type { Device } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type {
  ICreateChildDeviceInput,
  IDeviceRepository,
} from '../../application/ports/auth.repository.ports';

@Injectable()
export class PrismaDeviceRepository implements IDeviceRepository {
  constructor(private readonly prisma: PrismaService) {}

  createPairedChildDevice(input: ICreateChildDeviceInput): Promise<Device> {
    return this.prisma.device.create({
      data: {
        familyId: input.familyId,
        childId: input.childId,
        ownerType: 'CHILD',
        platform: input.platform,
        deviceModel: input.deviceModel,
        osVersion: input.osVersion,
        appVersion: input.appVersion,
        pushToken: input.pushToken,
        status: 'ACTIVE',
        pairedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
  }

  findById(id: string): Promise<Device | null> {
    return this.prisma.device.findUnique({ where: { id } });
  }

  async revoke(id: string): Promise<void> {
    await this.prisma.device.update({ where: { id }, data: { status: 'REVOKED' } });
  }
}
