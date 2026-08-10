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

  async findRecentForChild(childId: string, since: Date): Promise<Array<{ type: string; priority: string; createdAt: Date }>> {
    const rows = await this.prisma.notification.findMany({
      where: { childId, createdAt: { gte: since } },
      select: { type: true, priority: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows;
  }
}
