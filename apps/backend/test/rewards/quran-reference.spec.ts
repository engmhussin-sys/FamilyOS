/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * THE QURAN REFERENCE DATA IS CORRECT, AND THE TWO COPIES CANNOT DRIFT.
 *
 * The brief's own reason for this file: "an incorrect ayah count makes the whole
 * feature lie to a memorising child". So the data is not eyeballed, it is
 * checked three ways:
 *
 *   1. STRUCTURE — 114 rows, numbered 1..114 with no gap and no duplicate,
 *      every name non-empty, every count a positive integer.
 *   2. CHECKSUMS — SUM(ayahCount) === 6236 and 28 Medinan surahs. Both are
 *      well-known totals; a single mistyped entry breaks at least one.
 *   3. SPOT VALUES — the surahs the product actually names, plus the extremes.
 *
 * And when a real database is available, the SEEDED TABLE is compared row for
 * row against the TypeScript constant, so migration 0006 and `quran.ts` cannot
 * disagree without something failing.
 */
import {
  MEDINAN_SURAH_COUNT,
  QURAN_JUZ_COUNT,
  QURAN_SURAHS,
  QURAN_SURAH_COUNT,
  QURAN_TOTAL_AYAHS,
  findSurah,
  isAyahRangeInSurah,
} from '../../src/shared/rewards/quran';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';

describe('Quran reference data', () => {
  it('has exactly 114 surahs', () => {
    expect(QURAN_SURAHS).toHaveLength(114);
    expect(QURAN_SURAH_COUNT).toBe(114);
  });

  it('is numbered 1..114 with no gap and no duplicate', () => {
    const numbers = QURAN_SURAHS.map((s) => s.number);
    expect(numbers).toEqual(Array.from({ length: 114 }, (_, i) => i + 1));
    expect(new Set(numbers).size).toBe(114);
  });

  it('CHECKSUM: the ayah counts sum to 6,236 — the Hafs total', () => {
    expect(QURAN_TOTAL_AYAHS).toBe(6236);
  });

  it('CHECKSUM: 28 surahs are Medinan, therefore 86 are Meccan', () => {
    expect(MEDINAN_SURAH_COUNT).toBe(28);
    expect(QURAN_SURAHS.filter((s) => s.revelationType === 'MECCAN')).toHaveLength(86);
  });

  it('every row is complete — Arabic name, transliteration, positive count, known type', () => {
    for (const s of QURAN_SURAHS) {
      expect(s.nameAr.trim().length).toBeGreaterThan(0);
      expect(s.transliteration.trim().length).toBeGreaterThan(0);
      expect(Number.isInteger(s.ayahCount)).toBe(true);
      expect(s.ayahCount).toBeGreaterThan(0);
      expect(['MECCAN', 'MEDINAN']).toContain(s.revelationType);
    }
  });

  it.each([
    [1, 'الفاتحة', 7, 'MECCAN'],
    [2, 'البقرة', 286, 'MEDINAN'],
    // The brief's own worked example. If this number is wrong the flagship
    // journey validates the wrong ayah range.
    [67, 'الملك', 30, 'MECCAN'],
    [36, 'يس', 83, 'MECCAN'],
    [55, 'الرحمن', 78, 'MEDINAN'],
    [103, 'العصر', 3, 'MECCAN'],
    [108, 'الكوثر', 3, 'MECCAN'],
    [114, 'الناس', 6, 'MECCAN'],
  ])('surah %i is %s with %i ayahs (%s)', (number, nameAr, ayahCount, revelationType) => {
    const surah = findSurah(number as number);
    expect(surah).toBeDefined();
    expect(surah!.nameAr).toBe(nameAr);
    expect(surah!.ayahCount).toBe(ayahCount);
    expect(surah!.revelationType).toBe(revelationType);
  });

  it('the longest surah is Al-Baqarah (286) and the shortest are 3 ayahs', () => {
    const max = Math.max(...QURAN_SURAHS.map((s) => s.ayahCount));
    const min = Math.min(...QURAN_SURAHS.map((s) => s.ayahCount));
    expect(max).toBe(286);
    expect(min).toBe(3);
  });

  it('has 30 ajzaa', () => {
    expect(QURAN_JUZ_COUNT).toBe(30);
  });

  describe('isAyahRangeInSurah — the predicate the whole feature depends on', () => {
    it('accepts a real range: Al-Mulk 1–5', () => {
      expect(isAyahRangeInSurah(67, 1, 5)).toBe(true);
    });

    it('accepts the exact last ayah: Al-Mulk 30–30', () => {
      expect(isAyahRangeInSurah(67, 30, 30)).toBe(true);
    });

    it('REJECTS ayah 31 of Al-Mulk — the surah has 30', () => {
      expect(isAyahRangeInSurah(67, 1, 31)).toBe(false);
    });

    it('REJECTS ayah 300 of Al-Mulk — the case the brief names', () => {
      expect(isAyahRangeInSurah(67, 1, 300)).toBe(false);
    });

    it('REJECTS surah 115 — there is no such surah', () => {
      expect(isAyahRangeInSurah(115, 1, 1)).toBe(false);
    });

    it('REJECTS an inverted range', () => {
      expect(isAyahRangeInSurah(67, 10, 3)).toBe(false);
    });

    it('REJECTS ayah 0 and negative ayahs', () => {
      expect(isAyahRangeInSurah(67, 0, 5)).toBe(false);
      expect(isAyahRangeInSurah(67, -1, 5)).toBe(false);
    });

    it('REJECTS non-integer ayahs', () => {
      expect(isAyahRangeInSurah(67, 1.5, 5)).toBe(false);
    });
  });
});

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

describeIfDb('the SEEDED quran_surahs table equals the TypeScript constant', () => {
  let prisma: any;

  beforeAll(() => {
    const url = process.env.INTEGRATION_DATABASE_URL as string;
    if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
      const { PrismaClient } = require('@prisma/client/wasm');
      const { PrismaPg } = require('@prisma/adapter-pg');
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: url });
      prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      prisma.__pool = pool;
    } else {
      const { PrismaClient } = require('@prisma/client');
      prisma = new PrismaClient({ datasources: { db: { url } } });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (prisma.__pool) await prisma.__pool.end();
  });

  it('has 114 seeded rows', async () => {
    expect(await prisma.quranSurah.count()).toBe(114);
  });

  it('matches the code table row for row — number, name, transliteration, count, type', async () => {
    const rows = await prisma.quranSurah.findMany({ orderBy: { number: 'asc' } });
    const asCode = rows.map((r: any) => ({
      number: r.number,
      nameAr: r.nameAr,
      transliteration: r.transliteration,
      ayahCount: r.ayahCount,
      revelationType: r.revelationType,
    }));
    expect(asCode).toEqual(QURAN_SURAHS.map((s) => ({ ...s })));
  });

  it('CHECKSUM holds in the DATABASE too, not only in the constant', async () => {
    const rows = await prisma.quranSurah.findMany({ select: { ayahCount: true, revelationType: true } });
    expect(rows.reduce((n: number, r: any) => n + r.ayahCount, 0)).toBe(6236);
    expect(rows.filter((r: any) => r.revelationType === 'MEDINAN')).toHaveLength(28);
  });

  it('seeds the 18 program categories from the brief', async () => {
    const rows = await prisma.rewardProgramCategory.findMany({ orderBy: { sortOrder: 'asc' } });
    expect(rows).toHaveLength(18);
    expect(rows.map((r: any) => r.code)).toEqual(
      expect.arrayContaining([
        'QURAN',
        'HADITH',
        'FIQH',
        'MANNERS',
        'STUDY',
        'SCIENCE',
        'MATH',
        'PROGRAMMING',
        'READING',
        'SPORT',
        'ENGLISH',
        'ARABIC',
        'SKILLS',
        'HOUSEWORK',
        'HEALTH',
        'HABITS',
        'VOLUNTEERING',
        'CREATIVITY',
      ]),
    );
  });
});
