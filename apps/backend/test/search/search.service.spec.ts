/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ===========================================================================
 * F1 — GLOBAL SEARCH PUT A PRISMA ENUM ON THE SCREEN, IN ENGLISH.
 * ===========================================================================
 *
 * WHAT WAS THERE, MEASURED. `search.service.ts` built its rows inline:
 *
 *   subtitle: 'Child profile'
 *   subtitle: `Device · ${d.platform}`      ->  «Device · ANDROID»
 *   title:    d.deviceModel ?? d.platform   ->  «ANDROID» as the ROW TITLE
 *
 * `DevicePlatform` is a Prisma enum (`schema.prisma:127`) and `deviceModel`
 * is nullable, so a device that never reported a model was listed to the
 * parent under the literal name of a database enum value. `SearchBar.tsx`
 * renders `title` and `subtitle` straight into the dropdown with no lookup
 * table of its own, so the server is the only place this can be right.
 *
 * THE ASSERTION THAT MATTERS is not the specific Arabic — it is that NO enum
 * value and no Latin text reaches any user-visible field, for any row, in any
 * shape. Both are asserted: the exact copy, so a silent rewording is visible,
 * and the property, so a NEW result type added tomorrow with an inline English
 * literal is caught by the sweep rather than by a reader.
 */
import { Test } from '@nestjs/testing';

import { SearchService } from '../../src/modules/search/application/search.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';

describe('SearchService', () => {
  const prismaMock = {
    child: { findMany: jest.fn() },
    device: { findMany: jest.fn() },
    notification: { findMany: jest.fn() },
  };

  let service: SearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.child.findMany.mockResolvedValue([]);
    prismaMock.device.findMany.mockResolvedValue([]);
    prismaMock.notification.findMany.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [SearchService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();
    service = moduleRef.get(SearchService);
  });

  it('a query shorter than two characters is not a search — no query is issued at all', async () => {
    expect(await service.search('fam-1', 'user-1', ' a ')).toEqual([]);
    expect(prismaMock.child.findMany).not.toHaveBeenCalled();
  });

  it('every query is scoped to the caller’s own family, never across families', async () => {
    await service.search('fam-1', 'user-1', 'ahmed');

    expect(prismaMock.child.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ familyId: 'fam-1' }) }),
    );
    expect(prismaMock.device.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ familyId: 'fam-1' }) }),
    );
    // Notifications are the USER's, not the family's — a co-parent does not
    // read the other parent's inbox through search.
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user-1' }) }),
    );
  });

  describe('F1 — no raw enum, and no English, in a user-visible field', () => {
    it('a child row reads «ملف الطفل», not «Child profile»', async () => {
      prismaMock.child.findMany.mockResolvedValue([{ id: 'child-1', firstName: 'أحمد' }]);

      const [row] = await service.search('fam-1', 'user-1', 'أحمد');

      expect(row).toEqual({
        type: 'CHILD',
        id: 'child-1',
        // The child's own given name, as the parent typed it — never rewritten.
        title: 'أحمد',
        subtitle: 'ملف الطفل',
      });
    });

    /**
     * THE ENUM, IN THE TITLE. This is the row the old code labelled «ANDROID».
     */
    it.each([
      ['ANDROID', 'جهاز أندرويد', 'جهاز · أندرويد'],
      ['IOS', 'جهاز آبل', 'جهاز · آبل'],
    ])(
      'a %s device with NO deviceModel is titled by an Arabic noun, never by the enum',
      async (platform, expectedTitle, expectedSubtitle) => {
        prismaMock.device.findMany.mockResolvedValue([
          { id: 'dev-1', deviceModel: null, platform },
        ]);

        const [row] = await service.search('fam-1', 'user-1', 'جهاز');

        expect(row.title).toBe(expectedTitle);
        expect(row.subtitle).toBe(expectedSubtitle);
        expect(JSON.stringify(row)).not.toContain(platform);
      },
    );

    it('a device WITH a deviceModel keeps the manufacturer’s own name as the title', async () => {
      prismaMock.device.findMany.mockResolvedValue([
        { id: 'dev-2', deviceModel: 'Galaxy A54', platform: 'ANDROID' },
      ]);

      const [row] = await service.search('fam-1', 'user-1', 'galaxy');

      // Rewriting somebody else's stored product name is not this module's
      // business — the same rule `life-timeline-copy.ts` applies to a habit's
      // own title.
      expect(row.title).toBe('Galaxy A54');
      expect(row.subtitle).toBe('جهاز · أندرويد');
    });

    /**
     * FAILS OPEN IS THE DEFECT. A third `DevicePlatform` value added to the
     * schema tomorrow must degrade to a generic Arabic noun, not append itself
     * to the subtitle — which is precisely how `ANDROID` reached the screen.
     */
    it('an unknown platform degrades to a generic Arabic noun rather than printing itself', async () => {
      prismaMock.device.findMany.mockResolvedValue([
        { id: 'dev-3', deviceModel: null, platform: 'HARMONY_OS' },
      ]);

      const [row] = await service.search('fam-1', 'user-1', 'جهاز');

      expect(JSON.stringify(row)).not.toContain('HARMONY_OS');
      expect(row.subtitle).toBe('جهاز');
      expect(row.title).toBe('جهاز غير محدّد الطراز');
    });

    /**
     * THE SWEEP. Every user-visible string the service AUTHORS must be free of
     * Latin. Fields that carry somebody else's stored text — a child's name, a
     * device model, a notification's own title and body — are excluded by
     * construction: this case seeds them all in Arabic, so anything Latin left
     * in the output was written by this module.
     */
    it('authors no Latin text in any label, for any result type', async () => {
      prismaMock.child.findMany.mockResolvedValue([{ id: 'c', firstName: 'سارة' }]);
      prismaMock.device.findMany.mockResolvedValue([
        { id: 'd1', deviceModel: null, platform: 'ANDROID' },
        { id: 'd2', deviceModel: null, platform: 'IOS' },
      ]);
      prismaMock.notification.findMany.mockResolvedValue([
        { id: 'n', title: 'تذكير', body: 'حان وقت المذاكرة' },
      ]);

      const results = await service.search('fam-1', 'user-1', 'سارة');

      expect(results).toHaveLength(4);
      for (const row of results) {
        expect(row.title).not.toMatch(/[A-Za-z]/);
        expect(row.subtitle).not.toMatch(/[A-Za-z]/);
      }
      // And nothing that looks like an ALL_CAPS enum token, in any field.
      expect(JSON.stringify(results.map((r) => [r.title, r.subtitle]))).not.toMatch(/[A-Z]{3,}/);
    });
  });
});
