import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type {
  INotificationRecord,
  INotificationRepository,
} from '../../application/ports/notification.repository.port';

@Injectable()
export class PrismaNotificationRepository implements INotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string, unreadOnly: boolean): Promise<INotificationRecord[]> {
    const rows = await this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows as unknown as INotificationRecord[];
  }

  async markAsRead(notificationId: string, userId: string): Promise<boolean> {
    // Ownership-scoped in the WHERE clause itself, not checked
    // separately — updateMany returns count:0 for a notification
    // belonging to someone else, rather than a 404 that would confirm
    // the ID exists at all (same "don't reveal what you don't own"
    // instinct as ChildNotFoundException).
    const result = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count > 0;
  }

  async markAllAsRead(userId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  async countUnread(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  async findRecentForChild(
    childId: string,
    since: Date,
    until?: Date,
  ): Promise<Array<{ type: string; priority: string; createdAt: Date; sourceEventId: string }>> {
    /**
     * SPRINT F1 (BILLING) — «NO CHILD» IS AN ANSWER, NOT A QUERY.
     *
     * `SmartNotificationIntegrationService.notifyEvent` takes `childId: string`
     * and every caller that has no child passes the empty string — the
     * convention `quiet-hours-release.service.ts:418` already uses
     * (`digestOf[0].childId ?? ''`). Reaching PostgreSQL with it raises
     * `22P02 invalid input syntax for type uuid: ""`, and the surrounding
     * `try` reported the whole notification as `DELIVERY_ERROR`. So every
     * HOUSEHOLD-level notification — a payment failure, a renewal notice, a
     * digest whose first held row had no child — died here, with a message
     * that named a uuid rather than the absent child.
     *
     * A household-level notification has no per-child fatigue history BY
     * CONSTRUCTION, so the honest reading of the empty id is «there is nothing
     * to compare against», which is exactly what an empty list means to every
     * caller. It is answered without a query rather than by a query that
     * cannot parse.
     */
    if (!childId) return [];

    const rows = await this.prisma.notification.findMany({
      // BOUNDED ABOVE WHEN THE CALLER NAMED AN INSTANT — see the port for the
      // whole argument. `lte` rather than `lt`: a row written AT `now` is a row
      // that has already happened, and the two bounds must be the same kind so
      // an in-memory re-application of the filter cannot disagree with the SQL.
      where: { childId, createdAt: until ? { gte: since, lte: until } : { gte: since } },
      // `source_event_id` is the CAUSAL KEY — see the port. Four columns, still
      // no title and no body: the scorer needs to know THAT a notification
      // happened, of what kind, when and FOR WHICH CAUSE, never what it said.
      select: { type: true, priority: true, createdAt: true, sourceEventId: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows;
  }
}
