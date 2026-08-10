import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type {
  ICreatePairingDeviceInput,
  IPairingDeviceRecord,
  IPairingDeviceRepository,
  IPairingDeviceWithChild,
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

  async updateCapabilityProfile(
    deviceId: string,
    profile: Record<string, unknown>,
    profileHash: string,
  ): Promise<void> {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { capabilityProfile: profile as Prisma.InputJsonValue, capabilityProfileHash: profileHash },
    });
  }

  async findAllByFamily(familyId: string): Promise<IPairingDeviceWithChild[]> {
    const devices = await this.prisma.device.findMany({
      where: { familyId, ownerType: 'CHILD', deletedAt: null },
      include: { child: { select: { firstName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return devices.map((d: any) => ({
      ...this.toRecord(d),
      childFirstName: d.child?.firstName ?? 'Unknown',
      platform: d.platform,
    }));
  }

  async updateTelemetry(deviceId: string, telemetry: Record<string, unknown>): Promise<void> {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastTelemetry: telemetry as Prisma.InputJsonValue },
    });
  }

  private toRecord(device: {
    id: string;
    childId: string | null;
    familyId: string;
    status: string;
    lastSeenAt: Date | null;
    capabilityProfile: unknown;
    capabilityProfileHash: string | null;
    lastTelemetry: unknown;
  }): IPairingDeviceRecord {
    return {
      id: device.id,
      childId: device.childId!,
      familyId: device.familyId,
      status: device.status,
      lastSeenAt: device.lastSeenAt,
      capabilityProfile: (device.capabilityProfile as Record<string, unknown>) ?? null,
      capabilityProfileHash: device.capabilityProfileHash,
      lastTelemetry: (device.lastTelemetry as Record<string, unknown>) ?? null,
    };
  }
}
