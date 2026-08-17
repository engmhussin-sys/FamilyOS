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

  async upsertParentDevicePushToken(input: {
    userId: string;
    familyId: string;
    platform: 'ANDROID' | 'IOS';
    pushToken: string;
  }): Promise<void> {
    const existing = await this.prisma.device.findFirst({
      where: { userId: input.userId, ownerType: 'PARENT', platform: input.platform },
    });

    if (existing) {
      await this.prisma.device.update({
        where: { id: existing.id },
        data: { pushToken: input.pushToken, lastSeenAt: new Date() },
      });
    } else {
      await this.prisma.device.create({
        data: {
          familyId: input.familyId,
          userId: input.userId,
          ownerType: 'PARENT',
          platform: input.platform,
          pushToken: input.pushToken,
          status: 'ACTIVE',
          pairedAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
    }
  }

  async setChildDevicePushToken(deviceId: string, pushToken: string): Promise<void> {
    // UPDATE BY ID. The caller has already resolved this id from a verified
    // device token and asserted the device is ACTIVE and paired to a child —
    // nothing here is derived from a request body, so there is no id to probe.
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { pushToken, lastSeenAt: new Date() },
    });
  }

  async clearDeadChildDevicePushToken(pushToken: string): Promise<number> {
    // `ownerType: 'CHILD'` is the scope line, and it is the whole reason this
    // is safe to ship while FCM_CONTRACT.md item 13 (the PARENT half) is still
    // open and owned elsewhere: a parent's dead token is deliberately left
    // alone by this method rather than half-handled by two owners.
    const { count } = await this.prisma.device.updateMany({
      where: { pushToken, ownerType: 'CHILD' },
      data: { pushToken: null },
    });
    return count;
  }

  async findPushTokensForUser(userId: string): Promise<string[]> {
    const devices = await this.prisma.device.findMany({
      where: { userId, pushToken: { not: null } },
      select: { pushToken: true },
    });
    return devices.map((d: { pushToken: string | null }) => d.pushToken).filter((t: string | null): t is string => t !== null);
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
