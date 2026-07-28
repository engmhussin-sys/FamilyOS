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
        childId: input.childId,
        deviceId: input.deviceId,
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

  async findLatest(childId: string): Promise<IPairingEventRecord | null> {
    // Decision-066: always keyed on childId, never deviceId — this is
    // what keeps a child's pairing timeline coherent across a future
    // device replacement (a new device for the same child continues the
    // same childId-scoped timeline rather than starting a disconnected one).
    return this.prisma.devicePairingEvent.findFirst({
      where: { childId },
      orderBy: { occurredAt: 'desc' },
    });
  }

  async findByEventType(
    childId: string,
    eventType: string,
  ): Promise<IPairingEventRecord[]> {
    return this.prisma.devicePairingEvent.findMany({
      where: { childId, eventType },
      orderBy: { occurredAt: 'asc' },
    });
  }
}
