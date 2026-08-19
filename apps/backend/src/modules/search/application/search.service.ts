import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { SEARCH_COPY_AR } from '../domain/search-copy';

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

    // EVERY STRING BELOW IS RENDERED VERBATIM by both consumers \u2014 the admin
    // dashboard's `SearchBar.tsx` prints `title` and `subtitle` straight into
    // the dropdown, with no lookup table of its own. So the server is the only
    // place these can be right, and `search-copy.ts` is where they live.
    const results: ISearchResult[] = [
      ...children.map((c: any) => ({
        type: 'CHILD' as const,
        id: c.id,
        // The child's own given name, as the parent typed it. Never rewritten.
        title: c.firstName,
        subtitle: SEARCH_COPY_AR.childProfile(),
      })),
      ...devices.map((d: any) => ({
        type: 'DEVICE' as const,
        id: d.id,
        // `d.platform` IS A PRISMA ENUM and used to be the title outright
        // whenever `deviceModel` was null \u2014 \u00abANDROID\u00bb as a row title on an
        // Arabic screen. It no longer reaches the response in any field.
        title: d.deviceModel ?? SEARCH_COPY_AR.deviceTitleFallback(d.platform),
        subtitle: SEARCH_COPY_AR.deviceSubtitle(d.platform),
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
