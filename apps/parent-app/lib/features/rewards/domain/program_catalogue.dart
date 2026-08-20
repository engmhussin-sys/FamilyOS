/// THE CATALOGUE — reference data the SERVER owns.
///
/// Every label in this file arrives from `GET /reward-programs/catalogue`
/// and `GET /reward-programs/catalogue/surahs`. Nothing here is a client
/// constant: the backend's `PROGRAM_CATEGORY_LABEL_AR`,
/// `VERIFICATION_MATRIX` and `QURAN_SURAHS` are the single source of truth
/// (CONTEXT §3 principle 1), and a second copy in Dart would drift the
/// first time someone adds a category — which the backend explicitly
/// supports doing with an INSERT and no migration.
///
/// THE ONE EXCEPTION, stated openly: [ProgramActivity.isQuranAyahRange]
/// and friends branch on the activity CODE to decide which target form to
/// show. That is a presentation routing decision (which four fields to
/// render), not a business rule — the server re-validates every one of
/// them in `validateTargetSpec` and rejects anything the form let through.
library;

class ProgramActivity {
  const ProgramActivity({required this.code, required this.labelAr});

  final String code;
  final String labelAr;

  factory ProgramActivity.fromJson(Map<String, dynamic> json) => ProgramActivity(
        code: json['code']?.toString() ?? '',
        labelAr: json['labelAr']?.toString() ?? json['code']?.toString() ?? '',
      );

  /// Needs surah + fromAyah + toAyah.
  bool get isQuranAyahRange => const {
        'QURAN_MEMORIZE_AYAH',
        'QURAN_MEMORIZE_AYAH_RANGE',
        'QURAN_REVIEW',
        'QURAN_RECITATION',
        'QURAN_TAFSIR',
      }.contains(code);

  /// Needs surah only.
  bool get isQuranSurahOnly => code == 'QURAN_MEMORIZE_SURAH';

  /// Needs juz 1..30.
  bool get isQuranJuz => code == 'QURAN_MEMORIZE_JUZ';

  /// `QURAN_MEMORIZE_AYAH` accepts a single ayah, not a range — the
  /// server rejects `toAyah != fromAyah` with `AYAH_RANGE_NOT_SINGLE`.
  bool get isSingleAyah => code == 'QURAN_MEMORIZE_AYAH';

  bool get isQuran => isQuranAyahRange || isQuranSurahOnly || isQuranJuz;

  /// Everything else: quantity / unit / reference.
  bool get isGeneric => !isQuran;
}

class ProgramCategory {
  const ProgramCategory({
    required this.code,
    required this.labelAr,
    required this.activities,
  });

  final String code;
  final String labelAr;

  /// `CATEGORY_ACTIVITIES` server-side. The wizard renders exactly this
  /// list at step 2, so an illegal category/activity pair is not something
  /// the parent can express — rather than something they discover via a
  /// 400 (audit P3's note: "الواجهة يجب أن تعكسه لا أن تكتشفه بـ 400").
  final List<ProgramActivity> activities;

  factory ProgramCategory.fromJson(Map<String, dynamic> json) => ProgramCategory(
        code: json['code']?.toString() ?? '',
        labelAr: json['labelAr']?.toString() ?? json['code']?.toString() ?? '',
        activities: (json['activities'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(ProgramActivity.fromJson)
            .toList(),
      );
}

/// One row of the server's `VERIFICATION_MATRIX`.
class VerificationLevel {
  const VerificationLevel({
    required this.code,
    required this.labelAr,
    required this.rationaleAr,
    required this.strength,
    required this.canAutoApprove,
    required this.requiresExplicitChoice,
  });

  final String code;
  final String labelAr;

  /// Shown under the option, always. F4 wrote a real explanation for each
  /// of the nine methods and a parent choosing between "مدة العمل الفعلية"
  /// and "تسميع مُسجَّل" without reading them is choosing blind.
  final String rationaleAr;

  /// WEAK | MODERATE | STRONG.
  final String strength;
  final bool canAutoApprove;

  /// `DURATION` sets this. The wizard never pre-selects such a method and
  /// requires an explicit tap — the server enforces the same rule, this
  /// only stops the parent from being surprised by it.
  final bool requiresExplicitChoice;

  factory VerificationLevel.fromJson(Map<String, dynamic> json) => VerificationLevel(
        code: json['code']?.toString() ?? '',
        labelAr: json['labelAr']?.toString() ?? '',
        rationaleAr: json['rationaleAr']?.toString() ?? '',
        strength: json['strength']?.toString() ?? 'WEAK',
        canAutoApprove: json['canAutoApprove'] == true,
        requiresExplicitChoice: json['requiresExplicitChoice'] == true,
      );

  /// Needs `verificationConfig.passScorePercent`.
  bool get needsPassScore => const {
        'QUIZ',
        'ASSESSMENT_SCORE',
        'CODE_CHALLENGE',
        'DURATION_PLUS_QUIZ',
      }.contains(code);
}

class QuranSurah {
  const QuranSurah({
    required this.number,
    required this.nameAr,
    required this.transliteration,
    required this.ayahCount,
    required this.revelationType,
  });

  final int number;
  final String nameAr;
  final String transliteration;

  /// The Hafs count. The local ayah-range check uses THIS, exactly as the
  /// server's `validateAyahRange` does — same number, two enforcement
  /// points, one source.
  final int ayahCount;
  final String revelationType;

  factory QuranSurah.fromJson(Map<String, dynamic> json) => QuranSurah(
        number: (json['number'] as num?)?.toInt() ?? 0,
        nameAr: json['nameAr']?.toString() ?? '',
        transliteration: json['transliteration']?.toString() ?? '',
        ayahCount: (json['ayahCount'] as num?)?.toInt() ?? 0,
        revelationType: json['revelationType']?.toString() ?? '',
      );

  bool matches(String query) {
    final q = query.trim();
    if (q.isEmpty) return true;
    return nameAr.contains(q) ||
        transliteration.toLowerCase().contains(q.toLowerCase()) ||
        number.toString() == q;
  }
}

/// The whole first screen of the create flow, in one object, from one call.
class ProgramCatalogue {
  const ProgramCatalogue({
    required this.categories,
    required this.verificationLevels,
    required this.rewardTypes,
  });

  final List<ProgramCategory> categories;
  final List<VerificationLevel> verificationLevels;

  /// `PROGRAM_REWARD_TYPES` — plain codes; the Arabic label is a client
  /// localisation key (`rewardType.<CODE>`), because the server does not
  /// ship labels for these and inventing server labels for them would be a
  /// backend change this phase is not allowed to make.
  final List<String> rewardTypes;

  factory ProgramCatalogue.fromJson(Map<String, dynamic> json) => ProgramCatalogue(
        categories: (json['categories'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(ProgramCategory.fromJson)
            .toList(),
        verificationLevels: (json['verificationLevels'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(VerificationLevel.fromJson)
            .toList(),
        rewardTypes: (json['rewardTypes'] as List<dynamic>? ?? const [])
            .map((e) => e.toString())
            .toList(),
      );

  bool get isEmpty => categories.isEmpty;
}
