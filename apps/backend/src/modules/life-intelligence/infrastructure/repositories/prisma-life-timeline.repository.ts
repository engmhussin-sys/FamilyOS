import { Injectable } from '@nestjs/common';

import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../common/prisma/prisma.service';
import { ILifeTimelineEvent, IRecordTimelineEventInput } from '../../domain/life-timeline.types';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';

/**
 * Prisma's unique-constraint error, checked inline rather than imported from
 * `events/application/outbox.writer`. `LifeIntelligenceModule` is a DEPENDENCY
 * of `EventsModule`, not the other way round, and a five-line predicate is not
 * worth inverting that direction for — `AchievementService` already checks
 * `P2002` the same way for the same reason.
 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

@Injectable()
export class PrismaLifeTimelineRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * PHASE C (`PC-B-006`) — «ALREADY RECORDED» IS A SUCCESS, NOT AN ERROR.
   *
   * When `input.sourceKey` is present it is merged into `metadata`, which is
   * what `life_timeline_events_reward_source_key_uq` (migration 0010) indexes.
   * A second write of the same curated moment then raises P2002, and this
   * method reports the EXISTING row instead of throwing — the same semantics
   * `OutboxWriter.writeWithin` gives a duplicate domain event, and for the same
   * reason: the caller asked for the moment to be on the timeline, and it is.
   *
   * That is precisely what makes the repair in `RewardsCompletionConsumer` safe
   * to attempt on EVERY redelivery. Without the constraint the repair would be
   * a duplicator; with it, the repair is free.
   */
  async create(input: IRecordTimelineEventInput): Promise<ILifeTimelineEvent> {
    const metadata =
      input.sourceKey !== undefined
        ? { ...(input.metadata ?? {}), sourceKey: input.sourceKey }
        : input.metadata;

    try {
      const row = await this.prisma.lifeTimelineEvent.create({
        data: {
          familyId: tenantIdForWrite(),
          childId: input.childId,
          sourceEngine: input.sourceEngine,
          category: input.category,
          eventType: input.eventType,
          title: input.title,
          metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      return this.toDomain(row);
    } catch (err) {
      // ONLY a keyed write can collide: an unkeyed row falls outside the
      // PARTIAL index and can never raise this, so not one existing caller's
      // behaviour changes by a single branch.
      if (input.sourceKey === undefined || !isUniqueViolation(err)) throw err;

      const existing = await this.prisma.lifeTimelineEvent.findFirst({
        where: { childId: input.childId, eventType: input.eventType },
        orderBy: { occurredAt: 'desc' },
      });
      // The row must exist — the database just refused to write a second one.
      // If a concurrent delete removed it, rethrowing is the honest answer.
      if (!existing) throw err;
      return this.toDomain(existing);
    }
  }

  async listForChild(childId: string, category?: string, limit = 50): Promise<ILifeTimelineEvent[]> {
    const rows = await this.prisma.lifeTimelineEvent.findMany({
      where: { childId, ...(category ? { category: category as never } : {}) },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(row: {
    id: string;
    childId: string;
    sourceEngine: string;
    category: string;
    eventType: string;
    title: string;
    occurredAt: Date;
    metadata: unknown;
  }): ILifeTimelineEvent {
    return {
      id: row.id,
      childId: row.childId,
      sourceEngine: row.sourceEngine,
      category: row.category as ILifeTimelineEvent['category'],
      eventType: row.eventType,
      title: row.title,
      occurredAt: row.occurredAt,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    };
  }
}
