/**
 * THE QURAN REFERENCE TABLE — fixed, well-known, and therefore seedable.
 *
 * 114 surahs with their Arabic name, transliteration, Hafs `ayahCount` and
 * revelation type. This is not configuration and it is not user data: it is a
 * constant of the domain, which is exactly why it lives in code AND is seeded
 * into `quran_surahs` by migration 0006. The code copy is what validates a
 * `targetSpec` synchronously (no round trip on every program create); the table
 * copy is what a report/JOIN can use, and `test/rewards/quran-reference.spec.ts`
 * asserts the two are the same list so they cannot drift.
 *
 * WHY CORRECTNESS HERE IS NOT COSMETIC: an ayah count that is wrong by one
 * means the server tells a memorising child that آية 31 of الملك exists. Two
 * independent, cheap checks are therefore asserted by the test suite rather
 * than trusted:
 *
 *   1. `QURAN_TOTAL_AYAHS === 6236` — the well-known Hafs total. A single
 *      mistyped count changes this sum.
 *   2. `MEDINAN_SURAH_COUNT === 28` — the King Fahd Complex classification has
 *      exactly 28 Medinan surahs and 86 Meccan ones.
 *
 * Framework-free on purpose, same discipline as `src/shared/events/*`: no
 * NestJS, no Prisma, no decorators.
 */

/** The King Fahd Complex classification, the one an Egyptian/Saudi mushaf prints. */
export type RevelationType = 'MECCAN' | 'MEDINAN';

export interface QuranSurah {
  /** 1..114 */
  readonly number: number;
  readonly nameAr: string;
  /** Latin transliteration, for search and for a non-Arabic admin UI. */
  readonly transliteration: string;
  /** Hafs an Asim count. Al-Mulk (67) is 30 — the brief's own worked example. */
  readonly ayahCount: number;
  readonly revelationType: RevelationType;
}

export const QURAN_SURAHS: readonly QuranSurah[] = [
  { number: 1, nameAr: 'الفاتحة', transliteration: 'Al-Fatihah', ayahCount: 7, revelationType: 'MECCAN' },
  { number: 2, nameAr: 'البقرة', transliteration: 'Al-Baqarah', ayahCount: 286, revelationType: 'MEDINAN' },
  { number: 3, nameAr: 'آل عمران', transliteration: 'Ali Imran', ayahCount: 200, revelationType: 'MEDINAN' },
  { number: 4, nameAr: 'النساء', transliteration: 'An-Nisa', ayahCount: 176, revelationType: 'MEDINAN' },
  { number: 5, nameAr: 'المائدة', transliteration: 'Al-Maidah', ayahCount: 120, revelationType: 'MEDINAN' },
  { number: 6, nameAr: 'الأنعام', transliteration: 'Al-Anam', ayahCount: 165, revelationType: 'MECCAN' },
  { number: 7, nameAr: 'الأعراف', transliteration: 'Al-Araf', ayahCount: 206, revelationType: 'MECCAN' },
  { number: 8, nameAr: 'الأنفال', transliteration: 'Al-Anfal', ayahCount: 75, revelationType: 'MEDINAN' },
  { number: 9, nameAr: 'التوبة', transliteration: 'At-Tawbah', ayahCount: 129, revelationType: 'MEDINAN' },
  { number: 10, nameAr: 'يونس', transliteration: 'Yunus', ayahCount: 109, revelationType: 'MECCAN' },
  { number: 11, nameAr: 'هود', transliteration: 'Hud', ayahCount: 123, revelationType: 'MECCAN' },
  { number: 12, nameAr: 'يوسف', transliteration: 'Yusuf', ayahCount: 111, revelationType: 'MECCAN' },
  { number: 13, nameAr: 'الرعد', transliteration: 'Ar-Rad', ayahCount: 43, revelationType: 'MEDINAN' },
  { number: 14, nameAr: 'إبراهيم', transliteration: 'Ibrahim', ayahCount: 52, revelationType: 'MECCAN' },
  { number: 15, nameAr: 'الحجر', transliteration: 'Al-Hijr', ayahCount: 99, revelationType: 'MECCAN' },
  { number: 16, nameAr: 'النحل', transliteration: 'An-Nahl', ayahCount: 128, revelationType: 'MECCAN' },
  { number: 17, nameAr: 'الإسراء', transliteration: 'Al-Isra', ayahCount: 111, revelationType: 'MECCAN' },
  { number: 18, nameAr: 'الكهف', transliteration: 'Al-Kahf', ayahCount: 110, revelationType: 'MECCAN' },
  { number: 19, nameAr: 'مريم', transliteration: 'Maryam', ayahCount: 98, revelationType: 'MECCAN' },
  { number: 20, nameAr: 'طه', transliteration: 'Ta-Ha', ayahCount: 135, revelationType: 'MECCAN' },
  { number: 21, nameAr: 'الأنبياء', transliteration: 'Al-Anbiya', ayahCount: 112, revelationType: 'MECCAN' },
  { number: 22, nameAr: 'الحج', transliteration: 'Al-Hajj', ayahCount: 78, revelationType: 'MEDINAN' },
  { number: 23, nameAr: 'المؤمنون', transliteration: 'Al-Muminun', ayahCount: 118, revelationType: 'MECCAN' },
  { number: 24, nameAr: 'النور', transliteration: 'An-Nur', ayahCount: 64, revelationType: 'MEDINAN' },
  { number: 25, nameAr: 'الفرقان', transliteration: 'Al-Furqan', ayahCount: 77, revelationType: 'MECCAN' },
  { number: 26, nameAr: 'الشعراء', transliteration: 'Ash-Shuara', ayahCount: 227, revelationType: 'MECCAN' },
  { number: 27, nameAr: 'النمل', transliteration: 'An-Naml', ayahCount: 93, revelationType: 'MECCAN' },
  { number: 28, nameAr: 'القصص', transliteration: 'Al-Qasas', ayahCount: 88, revelationType: 'MECCAN' },
  { number: 29, nameAr: 'العنكبوت', transliteration: 'Al-Ankabut', ayahCount: 69, revelationType: 'MECCAN' },
  { number: 30, nameAr: 'الروم', transliteration: 'Ar-Rum', ayahCount: 60, revelationType: 'MECCAN' },
  { number: 31, nameAr: 'لقمان', transliteration: 'Luqman', ayahCount: 34, revelationType: 'MECCAN' },
  { number: 32, nameAr: 'السجدة', transliteration: 'As-Sajdah', ayahCount: 30, revelationType: 'MECCAN' },
  { number: 33, nameAr: 'الأحزاب', transliteration: 'Al-Ahzab', ayahCount: 73, revelationType: 'MEDINAN' },
  { number: 34, nameAr: 'سبأ', transliteration: 'Saba', ayahCount: 54, revelationType: 'MECCAN' },
  { number: 35, nameAr: 'فاطر', transliteration: 'Fatir', ayahCount: 45, revelationType: 'MECCAN' },
  { number: 36, nameAr: 'يس', transliteration: 'Ya-Sin', ayahCount: 83, revelationType: 'MECCAN' },
  { number: 37, nameAr: 'الصافات', transliteration: 'As-Saffat', ayahCount: 182, revelationType: 'MECCAN' },
  { number: 38, nameAr: 'ص', transliteration: 'Sad', ayahCount: 88, revelationType: 'MECCAN' },
  { number: 39, nameAr: 'الزمر', transliteration: 'Az-Zumar', ayahCount: 75, revelationType: 'MECCAN' },
  { number: 40, nameAr: 'غافر', transliteration: 'Ghafir', ayahCount: 85, revelationType: 'MECCAN' },
  { number: 41, nameAr: 'فصلت', transliteration: 'Fussilat', ayahCount: 54, revelationType: 'MECCAN' },
  { number: 42, nameAr: 'الشورى', transliteration: 'Ash-Shura', ayahCount: 53, revelationType: 'MECCAN' },
  { number: 43, nameAr: 'الزخرف', transliteration: 'Az-Zukhruf', ayahCount: 89, revelationType: 'MECCAN' },
  { number: 44, nameAr: 'الدخان', transliteration: 'Ad-Dukhan', ayahCount: 59, revelationType: 'MECCAN' },
  { number: 45, nameAr: 'الجاثية', transliteration: 'Al-Jathiyah', ayahCount: 37, revelationType: 'MECCAN' },
  { number: 46, nameAr: 'الأحقاف', transliteration: 'Al-Ahqaf', ayahCount: 35, revelationType: 'MECCAN' },
  { number: 47, nameAr: 'محمد', transliteration: 'Muhammad', ayahCount: 38, revelationType: 'MEDINAN' },
  { number: 48, nameAr: 'الفتح', transliteration: 'Al-Fath', ayahCount: 29, revelationType: 'MEDINAN' },
  { number: 49, nameAr: 'الحجرات', transliteration: 'Al-Hujurat', ayahCount: 18, revelationType: 'MEDINAN' },
  { number: 50, nameAr: 'ق', transliteration: 'Qaf', ayahCount: 45, revelationType: 'MECCAN' },
  { number: 51, nameAr: 'الذاريات', transliteration: 'Adh-Dhariyat', ayahCount: 60, revelationType: 'MECCAN' },
  { number: 52, nameAr: 'الطور', transliteration: 'At-Tur', ayahCount: 49, revelationType: 'MECCAN' },
  { number: 53, nameAr: 'النجم', transliteration: 'An-Najm', ayahCount: 62, revelationType: 'MECCAN' },
  { number: 54, nameAr: 'القمر', transliteration: 'Al-Qamar', ayahCount: 55, revelationType: 'MECCAN' },
  { number: 55, nameAr: 'الرحمن', transliteration: 'Ar-Rahman', ayahCount: 78, revelationType: 'MEDINAN' },
  { number: 56, nameAr: 'الواقعة', transliteration: 'Al-Waqiah', ayahCount: 96, revelationType: 'MECCAN' },
  { number: 57, nameAr: 'الحديد', transliteration: 'Al-Hadid', ayahCount: 29, revelationType: 'MEDINAN' },
  { number: 58, nameAr: 'المجادلة', transliteration: 'Al-Mujadilah', ayahCount: 22, revelationType: 'MEDINAN' },
  { number: 59, nameAr: 'الحشر', transliteration: 'Al-Hashr', ayahCount: 24, revelationType: 'MEDINAN' },
  { number: 60, nameAr: 'الممتحنة', transliteration: 'Al-Mumtahanah', ayahCount: 13, revelationType: 'MEDINAN' },
  { number: 61, nameAr: 'الصف', transliteration: 'As-Saff', ayahCount: 14, revelationType: 'MEDINAN' },
  { number: 62, nameAr: 'الجمعة', transliteration: 'Al-Jumuah', ayahCount: 11, revelationType: 'MEDINAN' },
  { number: 63, nameAr: 'المنافقون', transliteration: 'Al-Munafiqun', ayahCount: 11, revelationType: 'MEDINAN' },
  { number: 64, nameAr: 'التغابن', transliteration: 'At-Taghabun', ayahCount: 18, revelationType: 'MEDINAN' },
  { number: 65, nameAr: 'الطلاق', transliteration: 'At-Talaq', ayahCount: 12, revelationType: 'MEDINAN' },
  { number: 66, nameAr: 'التحريم', transliteration: 'At-Tahrim', ayahCount: 12, revelationType: 'MEDINAN' },
  { number: 67, nameAr: 'الملك', transliteration: 'Al-Mulk', ayahCount: 30, revelationType: 'MECCAN' },
  { number: 68, nameAr: 'القلم', transliteration: 'Al-Qalam', ayahCount: 52, revelationType: 'MECCAN' },
  { number: 69, nameAr: 'الحاقة', transliteration: 'Al-Haqqah', ayahCount: 52, revelationType: 'MECCAN' },
  { number: 70, nameAr: 'المعارج', transliteration: 'Al-Maarij', ayahCount: 44, revelationType: 'MECCAN' },
  { number: 71, nameAr: 'نوح', transliteration: 'Nuh', ayahCount: 28, revelationType: 'MECCAN' },
  { number: 72, nameAr: 'الجن', transliteration: 'Al-Jinn', ayahCount: 28, revelationType: 'MECCAN' },
  { number: 73, nameAr: 'المزمل', transliteration: 'Al-Muzzammil', ayahCount: 20, revelationType: 'MECCAN' },
  { number: 74, nameAr: 'المدثر', transliteration: 'Al-Muddaththir', ayahCount: 56, revelationType: 'MECCAN' },
  { number: 75, nameAr: 'القيامة', transliteration: 'Al-Qiyamah', ayahCount: 40, revelationType: 'MECCAN' },
  { number: 76, nameAr: 'الإنسان', transliteration: 'Al-Insan', ayahCount: 31, revelationType: 'MEDINAN' },
  { number: 77, nameAr: 'المرسلات', transliteration: 'Al-Mursalat', ayahCount: 50, revelationType: 'MECCAN' },
  { number: 78, nameAr: 'النبأ', transliteration: 'An-Naba', ayahCount: 40, revelationType: 'MECCAN' },
  { number: 79, nameAr: 'النازعات', transliteration: 'An-Naziat', ayahCount: 46, revelationType: 'MECCAN' },
  { number: 80, nameAr: 'عبس', transliteration: 'Abasa', ayahCount: 42, revelationType: 'MECCAN' },
  { number: 81, nameAr: 'التكوير', transliteration: 'At-Takwir', ayahCount: 29, revelationType: 'MECCAN' },
  { number: 82, nameAr: 'الانفطار', transliteration: 'Al-Infitar', ayahCount: 19, revelationType: 'MECCAN' },
  { number: 83, nameAr: 'المطففين', transliteration: 'Al-Mutaffifin', ayahCount: 36, revelationType: 'MECCAN' },
  { number: 84, nameAr: 'الانشقاق', transliteration: 'Al-Inshiqaq', ayahCount: 25, revelationType: 'MECCAN' },
  { number: 85, nameAr: 'البروج', transliteration: 'Al-Buruj', ayahCount: 22, revelationType: 'MECCAN' },
  { number: 86, nameAr: 'الطارق', transliteration: 'At-Tariq', ayahCount: 17, revelationType: 'MECCAN' },
  { number: 87, nameAr: 'الأعلى', transliteration: 'Al-Ala', ayahCount: 19, revelationType: 'MECCAN' },
  { number: 88, nameAr: 'الغاشية', transliteration: 'Al-Ghashiyah', ayahCount: 26, revelationType: 'MECCAN' },
  { number: 89, nameAr: 'الفجر', transliteration: 'Al-Fajr', ayahCount: 30, revelationType: 'MECCAN' },
  { number: 90, nameAr: 'البلد', transliteration: 'Al-Balad', ayahCount: 20, revelationType: 'MECCAN' },
  { number: 91, nameAr: 'الشمس', transliteration: 'Ash-Shams', ayahCount: 15, revelationType: 'MECCAN' },
  { number: 92, nameAr: 'الليل', transliteration: 'Al-Layl', ayahCount: 21, revelationType: 'MECCAN' },
  { number: 93, nameAr: 'الضحى', transliteration: 'Ad-Duha', ayahCount: 11, revelationType: 'MECCAN' },
  { number: 94, nameAr: 'الشرح', transliteration: 'Ash-Sharh', ayahCount: 8, revelationType: 'MECCAN' },
  { number: 95, nameAr: 'التين', transliteration: 'At-Tin', ayahCount: 8, revelationType: 'MECCAN' },
  { number: 96, nameAr: 'العلق', transliteration: 'Al-Alaq', ayahCount: 19, revelationType: 'MECCAN' },
  { number: 97, nameAr: 'القدر', transliteration: 'Al-Qadr', ayahCount: 5, revelationType: 'MECCAN' },
  { number: 98, nameAr: 'البينة', transliteration: 'Al-Bayyinah', ayahCount: 8, revelationType: 'MEDINAN' },
  { number: 99, nameAr: 'الزلزلة', transliteration: 'Az-Zalzalah', ayahCount: 8, revelationType: 'MEDINAN' },
  { number: 100, nameAr: 'العاديات', transliteration: 'Al-Adiyat', ayahCount: 11, revelationType: 'MECCAN' },
  { number: 101, nameAr: 'القارعة', transliteration: 'Al-Qariah', ayahCount: 11, revelationType: 'MECCAN' },
  { number: 102, nameAr: 'التكاثر', transliteration: 'At-Takathur', ayahCount: 8, revelationType: 'MECCAN' },
  { number: 103, nameAr: 'العصر', transliteration: 'Al-Asr', ayahCount: 3, revelationType: 'MECCAN' },
  { number: 104, nameAr: 'الهمزة', transliteration: 'Al-Humazah', ayahCount: 9, revelationType: 'MECCAN' },
  { number: 105, nameAr: 'الفيل', transliteration: 'Al-Fil', ayahCount: 5, revelationType: 'MECCAN' },
  { number: 106, nameAr: 'قريش', transliteration: 'Quraysh', ayahCount: 4, revelationType: 'MECCAN' },
  { number: 107, nameAr: 'الماعون', transliteration: 'Al-Maun', ayahCount: 7, revelationType: 'MECCAN' },
  { number: 108, nameAr: 'الكوثر', transliteration: 'Al-Kawthar', ayahCount: 3, revelationType: 'MECCAN' },
  { number: 109, nameAr: 'الكافرون', transliteration: 'Al-Kafirun', ayahCount: 6, revelationType: 'MECCAN' },
  { number: 110, nameAr: 'النصر', transliteration: 'An-Nasr', ayahCount: 3, revelationType: 'MEDINAN' },
  { number: 111, nameAr: 'المسد', transliteration: 'Al-Masad', ayahCount: 5, revelationType: 'MECCAN' },
  { number: 112, nameAr: 'الإخلاص', transliteration: 'Al-Ikhlas', ayahCount: 4, revelationType: 'MECCAN' },
  { number: 113, nameAr: 'الفلق', transliteration: 'Al-Falaq', ayahCount: 5, revelationType: 'MECCAN' },
  { number: 114, nameAr: 'الناس', transliteration: 'An-Nas', ayahCount: 6, revelationType: 'MECCAN' },
];

export const QURAN_SURAH_COUNT = 114;

const BY_NUMBER: ReadonlyMap<number, QuranSurah> = new Map(
  QURAN_SURAHS.map((s) => [s.number, s]),
);

export function findSurah(number: number): QuranSurah | undefined {
  return BY_NUMBER.get(number);
}

/** Total ayahs in the mushaf — 6,236 in the Hafs count. A cheap, well-known
 * checksum over the table above: if a single entry is mistyped this changes. */
export const QURAN_TOTAL_AYAHS = QURAN_SURAHS.reduce((n, s) => n + s.ayahCount, 0);

/** The second checksum: 28 Medinan, therefore 86 Meccan. */
export const MEDINAN_SURAH_COUNT = QURAN_SURAHS.filter((s) => s.revelationType === 'MEDINAN').length;

/** The 30 ajzaa. Used by the `QURAN_MEMORIZE_JUZ` activity's target spec. */
export const QURAN_JUZ_COUNT = 30;

/**
 * Is `[fromAyah..toAyah]` a real range inside this surah? The single predicate
 * every caller uses, so "ayah 300 of Al-Mulk" is rejected by the REAL count in
 * the table above and never by an arbitrary upper bound.
 */
export function isAyahRangeInSurah(surahNumber: number, fromAyah: number, toAyah: number): boolean {
  const surah = findSurah(surahNumber);
  if (!surah) return false;
  if (!Number.isInteger(fromAyah) || !Number.isInteger(toAyah)) return false;
  if (fromAyah < 1 || toAyah < 1) return false;
  if (toAyah < fromAyah) return false;
  return toAyah <= surah.ayahCount;
}
