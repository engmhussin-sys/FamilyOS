import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

export interface ISearchResult {
  type: 'CHILD' | 'DEVICE' | 'NOTIFICATION';
  id: string;
  title: string;
  subtitle: string;
}

/**
 * Sprint 8's Global Search. Deliberately family-scoped at every query
 * (never a cross-family search) \u2014 same ownership discipline as every
 * other read in this project. Simple `contains` matching \u2014 no search
 * index/engine (Elasticsearch, etc.) introduced; that's a real,
 * separate infrastructure decision for if/when result volume justifies it.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(familyId: string, userId: string, query: string): Promise<ISearchResult[]> {
    if (query.trim().length < 2) return [];

    const [children, devices, notifications] = await Promise.all([
      this.prisma.child.findMany({
        where: { familyId, deletedAt: null, firstName: { contains: query, mode: 'insensitive' } },
        take: 10,
      }),
      this.prisma.device.findMany({
        where: {
          familyId,
          deletedAt: null,
          OR: [
            { deviceModel: { contains: query, mode: 'insensitive' } },
            { platform: { equals: query.toUpperCase() as any } },
          ],
        },
        take: 10,
      }),
      this.prisma.notification.findMany({
        where: {
          userId,
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { body: { contains: query, mode: 'insensitive' } },
          ],
        },
        take: 10,
      }),
    ]);

    const results: ISearchResult[] = [
      ...children.map((c: any) => ({
        type: 'CHILD' as const,
        id: c.id,
        title: c.firstName,
        subtitle: 'Child profile',
      })),
      ...devices.map((d: any) => ({
        type: 'DEVICE' as const,
        id: d.id,
        title: d.deviceModel ?? d.platform,
        subtitle: `Device \u00b7 ${d.platform}`,
      })),
      ...notifications.map((n: any) => ({
        type: 'NOTIFICATION' as const,
        id: n.id,
        title: n.title,
        subtitle: n.body.slice(0, 60),
      })),
    ];

    return results;
  }
}
