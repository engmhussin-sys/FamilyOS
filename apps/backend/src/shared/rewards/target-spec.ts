/**
 * `targetSpec` VALIDATION — per activity, not per category.
 *
 * The brief's acceptance criterion is concrete: «surah 115» and «ayah 300 of
 * Al-Mulk» must be rejected. Both are rejected here, by two different rules:
 * the first by the 1..114 bound, the second by looking the real ayah count up
 * in `QURAN_SURAHS` — 67 has 30 ayahs, so `toAyah: 300` cannot be inside it.
 *
 * Returns a LIST of errors rather than throwing on the first one, so a parent
 * fixing a form sees everything wrong with it at once. The HTTP layer turns a
 * non-empty list into a 400; nothing here knows about HTTP.
 */
import {
  activityBelongsToCategory,
  isProgramActivity,
  isProgramCategory,
  type ProgramActivity,
  type ProgramCategory,
} from './program-taxonomy';
import { QURAN_JUZ_COUNT, QURAN_SURAH_COUNT, findSurah } from './quran';

export interface TargetSpecError {
  readonly field: string;
  readonly code: string;
  readonly messageAr: string;
}

/** The Quran shape. `isReview` is the review flag the brief requires. */
export interface QuranTargetSpec {
  readonly surahNumber?: number;
  readonly fromAyah?: number;
  readonly toAyah?: number;
  readonly juzNumber?: number;
  readonly isReview?: boolean;
  readonly repetitions?: number;
}

export interface GenericTargetSpec {
  readonly quantity?: number;
  readonly unit?: string;
  readonly reference?: string;
}

export type TargetSpec = QuranTargetSpec & GenericTargetSpec & Record<string, unknown>;

const err = (field: string, code: string, messageAr: string): TargetSpecError => ({
  field,
  code,
  messageAr,
});

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * The single entry point. `category`/`activity` are validated first because a
 * target spec is only meaningful relative to an activity — validating the spec
 * of an unknown activity would be validating nothing.
 */
export function validateTargetSpec(
  category: string,
  activity: string,
  spec: unknown,
): TargetSpecError[] {
  const errors: TargetSpecError[] = [];

  if (!isProgramCategory(category)) {
    return [err('category', 'UNKNOWN_CATEGORY', 'التصنيف غير معروف.')];
  }
  if (!isProgramActivity(activity)) {
    return [err('activity', 'UNKNOWN_ACTIVITY', 'النشاط غير معروف.')];
  }
  if (!activityBelongsToCategory(category as ProgramCategory, activity as ProgramActivity)) {
    return [
      err('activity', 'ACTIVITY_NOT_IN_CATEGORY', 'هذا النشاط لا ينتمي إلى هذا التصنيف.'),
    ];
  }

  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return [err('targetSpec', 'TARGET_SPEC_NOT_OBJECT', 'مواصفات الهدف يجب أن تكون كائنًا.')];
  }

  const s = spec as TargetSpec;

  switch (activity as ProgramActivity) {
    case 'QURAN_MEMORIZE_AYAH':
    case 'QURAN_MEMORIZE_AYAH_RANGE':
    case 'QURAN_REVIEW':
    case 'QURAN_RECITATION':
    case 'QURAN_TAFSIR':
      errors.push(...validateAyahRange(s, activity as ProgramActivity));
      break;

    case 'QURAN_MEMORIZE_SURAH':
      errors.push(...validateSurahOnly(s));
      break;

    case 'QURAN_MEMORIZE_JUZ':
      if (!isPositiveInt(s.juzNumber) || (s.juzNumber as number) > QURAN_JUZ_COUNT) {
        errors.push(
          err('targetSpec.juzNumber', 'JUZ_OUT_OF_RANGE', `رقم الجزء يجب أن يكون بين 1 و ${QURAN_JUZ_COUNT}.`),
        );
      }
      break;

    default:
      errors.push(...validateGeneric(s));
      break;
  }

  if (s.repetitions !== undefined && !isPositiveInt(s.repetitions)) {
    errors.push(err('targetSpec.repetitions', 'REPETITIONS_INVALID', 'عدد التكرارات يجب أن يكون عددًا صحيحًا موجبًا.'));
  }
  if (s.isReview !== undefined && typeof s.isReview !== 'boolean') {
    errors.push(err('targetSpec.isReview', 'IS_REVIEW_INVALID', 'حقل المراجعة يجب أن يكون قيمة منطقية.'));
  }

  return errors;
}

/** surah + [fromAyah..toAyah] inside the surah's REAL ayah count. */
function validateAyahRange(s: TargetSpec, activity: ProgramActivity): TargetSpecError[] {
  const errors = validateSurahOnly(s);
  const surah = isPositiveInt(s.surahNumber) ? findSurah(s.surahNumber as number) : undefined;

  const singleAyah = activity === 'QURAN_MEMORIZE_AYAH';

  if (!isPositiveInt(s.fromAyah)) {
    errors.push(err('targetSpec.fromAyah', 'AYAH_REQUIRED', 'رقم الآية الأولى مطلوب.'));
  }
  const to = s.toAyah ?? s.fromAyah;
  if (!isPositiveInt(to)) {
    errors.push(err('targetSpec.toAyah', 'AYAH_REQUIRED', 'رقم الآية الأخيرة مطلوب.'));
  }

  if (isPositiveInt(s.fromAyah) && isPositiveInt(to)) {
    if ((to as number) < (s.fromAyah as number)) {
      errors.push(
        err('targetSpec.toAyah', 'AYAH_RANGE_INVERTED', 'الآية الأخيرة يجب ألا تسبق الآية الأولى.'),
      );
    }
    if (singleAyah && (to as number) !== (s.fromAyah as number)) {
      errors.push(
        err('targetSpec.toAyah', 'AYAH_RANGE_NOT_SINGLE', 'نشاط «حفظ آية» يقبل آية واحدة فقط.'),
      );
    }
    if (surah) {
      // THE RULE THE BRIEF NAMES: ayah 300 of Al-Mulk (30 ayahs) is rejected
      // here, by the real table, not by an arbitrary upper bound.
      if ((s.fromAyah as number) > surah.ayahCount || (to as number) > surah.ayahCount) {
        errors.push(
          err(
            'targetSpec.toAyah',
            'AYAH_OUT_OF_SURAH',
            `سورة ${surah.nameAr} تحتوي على ${surah.ayahCount} آية فقط.`,
          ),
        );
      }
    }
  }

  return errors;
}

function validateSurahOnly(s: TargetSpec): TargetSpecError[] {
  if (!isPositiveInt(s.surahNumber) || (s.surahNumber as number) > QURAN_SURAH_COUNT) {
    return [
      err(
        'targetSpec.surahNumber',
        'SURAH_OUT_OF_RANGE',
        `رقم السورة يجب أن يكون بين 1 و ${QURAN_SURAH_COUNT}.`,
      ),
    ];
  }
  return [];
}

function validateGeneric(s: TargetSpec): TargetSpecError[] {
  const errors: TargetSpecError[] = [];
  if (s.quantity !== undefined && !isPositiveInt(s.quantity)) {
    errors.push(err('targetSpec.quantity', 'QUANTITY_INVALID', 'الكمية يجب أن تكون عددًا صحيحًا موجبًا.'));
  }
  if (s.unit !== undefined && typeof s.unit !== 'string') {
    errors.push(err('targetSpec.unit', 'UNIT_INVALID', 'الوحدة يجب أن تكون نصًا.'));
  }
  if (s.reference !== undefined && typeof s.reference !== 'string') {
    errors.push(err('targetSpec.reference', 'REFERENCE_INVALID', 'المرجع يجب أن يكون نصًا.'));
  }
  return errors;
}

/** A short, human-readable Arabic description of the target — used in the
 * achievement row so a parent's pending-verification list is readable without
 * re-deriving it in three clients. */
export function describeTargetSpec(activity: string, spec: TargetSpec): string {
  const surah = isPositiveInt(spec.surahNumber) ? findSurah(spec.surahNumber as number) : undefined;
  if (surah && isPositiveInt(spec.fromAyah)) {
    const to = spec.toAyah ?? spec.fromAyah;
    const range = to === spec.fromAyah ? `الآية ${spec.fromAyah}` : `الآيات ${spec.fromAyah}–${to}`;
    return `${range} من سورة ${surah.nameAr}`;
  }
  if (surah) return `سورة ${surah.nameAr}`;
  if (isPositiveInt(spec.juzNumber)) return `الجزء ${spec.juzNumber}`;
  if (isPositiveInt(spec.quantity)) return `${spec.quantity} ${spec.unit ?? ''}`.trim();
  return activity;
}
