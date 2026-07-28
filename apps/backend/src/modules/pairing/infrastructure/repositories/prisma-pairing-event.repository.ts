import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type {
  IPairingEventRepository,
  IPairingEventRecord,
  IRecordPairingEventInput,
} from '../../application/ports/pairing-event.repository.port';

@Injectable()
export class PrismaPairingEventRepository implements IPairingEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: IRecordPairingEventInput): Promise<IPairingEventRecord> {
    const row = await this.prisma.devicePairingEvent.create({
      data: {
        deviceId: input.deviceId,
        childId: input.childId,
        eventType: input.eventType,
        fromState: input.fromState,
        toState: input.toState,
        actorType: input.actorType,
        actorId: input.actorId,
        metadata: input.metadata,
      },
    });
    return row;
  }

  async findLatest(correlation: { deviceId?: string; childId?: string }): Promise<IPairingEventRecord | null> {
    // Prefer deviceId once one exists (it's the more specific, permanent
    // key); fall back to childId for the pre-registration window.
    const where = correlation.deviceId
      ? { deviceId: correlation.deviceId }
      : { childId: correlation.childId };

    return this.prisma.devicePairingEvent.findFirst({
      where,
      orderBy: { occurredAt: 'desc' },
    });
  }
}
