import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type {
  ICreatePairingDeviceInput,
  IPairingDeviceRecord,
  IPairingDeviceRepository,
} from '../../application/ports/pairing-device.repository.port';

@Injectable()
export class PrismaPairingDeviceRepository implements IPairingDeviceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createDevice(input: ICreatePairingDeviceInput): Promise<IPairingDeviceRecord> {
    const device = await this.prisma.device.create({
      data: {
        familyId: input.familyId,
        childId: input.childId,
        ownerType: 'CHILD',
        platform: input.platform,
        deviceModel: input.deviceModel,
        osVersion: input.osVersion,
        appVersion: input.appVersion,
        publicKey: input.publicKey,
        pairingProtocolVersion: input.pairingProtocolVersion,
        // status stays PENDING_PAIRING (the schema default) until
        // /pairing/activate — DEVICE_REGISTERED is a state on the
        // richer PairingState timeline (DevicePairingEvent), not yet
        // "active" on this simpler 4-value summary field.
        pairedAt: new Date(),
        lastSeenAt: new Date(),
      },
    });
    return this.toRecord(device);
  }

  async findById(deviceId: string): Promise<IPairingDeviceRecord | null> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    return device ? this.toRecord(device) : null;
  }

  async activateDevice(deviceId: string): Promise<void> {
    await this.prisma.device.update({ where: { id: deviceId }, data: { status: 'ACTIVE' } });
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.prisma.device.update({ where: { id: deviceId }, data: { status: 'REVOKED' } });
  }

  async touchLastSeen(deviceId: string): Promise<void> {
    await this.prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
  }

  private toRecord(device: {
    id: string;
    childId: string | null;
    familyId: string;
    status: string;
    lastSeenAt: Date | null;
  }): IPairingDeviceRecord {
    return {
      id: device.id,
      childId: device.childId!,
      familyId: device.familyId,
      status: device.status,
      lastSeenAt: device.lastSeenAt,
    };
  }
}
