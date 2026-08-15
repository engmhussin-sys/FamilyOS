import 'program_catalogue.dart';
import 'reward_program.dart';

/// THE WIZARD'S DRAFT — an immutable value the create flow carries from
/// step 1 to step 8, plus the LOCAL form checks.
///
/// WHERE THE LINE IS, because this is the one file in B6 that could
/// plausibly be accused of holding business logic:
///
///   * The SERVER decides everything that matters. `validateTargetSpec`
///     re-runs on every field below and rejects surah 115 and ayah 300 of
///     Al-Mulk against the real `QURAN_SURAHS` table. `validateRewardSpec`
///     re-checks the screen-time ceilings. `CreateRewardProgramDto`
///     re-checks every bound. Nothing here can create a program the server
///     would not have accepted, and nothing here can block one it would.
///   * What this file does is stop a parent from making a ROUND TRIP to
///     learn they typed 300 instead of 30 — audit P3b asks for exactly
///     that ("يجب فرض `toAyah ≤ ayahCount` **محليًا** أيضًا — رحلة ذهاب
///     وعودة لخطأ إملائي تجربة سيئة").
///
/// It is form validation mirrored from a published contract, it lives in
/// the domain layer and not in a widget, and every rule it states is
/// enforced again by the authority that owns it.
class ProgramDraft {
  const ProgramDraft({
    this.childId,
    this.childName,
    this.category,
    this.activity,
    this.surah,
    this.fromAyah,
    this.toAyah,
    this.juzNumber,
    this.quantity,
    this.unit,
    this.reference,
    this.isReview = false,
    this.repetitions,
    this.durationMinutes = 20,
    this.verification,
    this.passScorePercent,
    this.rewardType = 'POINTS',
    this.rewardAmount = 20,
    this.rewardDescription,
    this.screenTimeExpiresInHours,
    this.frequency = 'DAILY',
    this.maxPerDay = 1,
    this.maxPerWeek = 7,
    this.minAge,
    this.difficulty = 'MEDIUM',
    this.requiresParentApproval = false,
    this.expiresAt,
    this.streakMultiplierBps,
  });

  // --- step 0: who -----------------------------------------------------
  final String? childId;
  final String? childName;

  // --- steps 1-2: what -------------------------------------------------
  final ProgramCategory? category;
  final ProgramActivity? activity;

  // --- step 3: the target ----------------------------------------------
  final QuranSurah? surah;
  final int? fromAyah;
  final int? toAyah;
  final int? juzNumber;
  final int? quantity;
  final String? unit;
  final String? reference;
  final bool isReview;
  final int? repetitions;

  // --- step 4: how long ------------------------------------------------
  final int durationMinutes;

  // --- step 5: how it is verified --------------------------------------
  final VerificationLevel? verification;
  final int? passScorePercent;

  // --- step 6: the reward ----------------------------------------------
  final String rewardType;
  final int rewardAmount;
  final String? rewardDescription;
  final int? screenTimeExpiresInHours;

  // --- step 7: the rules -----------------------------------------------
  final String frequency;
  final int maxPerDay;
  final int maxPerWeek;
  final int? minAge;
  final String difficulty;
  final bool requiresParentApproval;
  final DateTime? expiresAt;
  final int? streakMultiplierBps;

  ProgramDraft copyWith({
    String? childId,
    String? childName,
    bool clearChild = false,
    ProgramCategory? category,
    ProgramActivity? activity,
    bool clearActivity = false,
    QuranSurah? surah,
    int? fromAyah,
    int? toAyah,
    int? juzNumber,
    int? quantity,
    String? unit,
    String? reference,
    bool? isReview,
    int? repetitions,
    int? durationMinutes,
    VerificationLevel? verification,
    int? passScorePercent,
    String? rewardType,
    int? rewardAmount,
    String? rewardDescription,
    int? screenTimeExpiresInHours,
    String? frequency,
    int? maxPerDay,
    int? maxPerWeek,
    int? minAge,
    String? difficulty,
    bool? requiresParentApproval,
    DateTime? expiresAt,
    int? streakMultiplierBps,
  }) {
    return ProgramDraft(
      childId: clearChild ? null : (childId ?? this.childId),
      childName: clearChild ? null : (childName ?? this.childName),
      category: category ?? this.category,
      activity: clearActivity ? null : (activity ?? this.activity),
      surah: surah ?? this.surah,
      fromAyah: fromAyah ?? this.fromAyah,
      toAyah: toAyah ?? this.toAyah,
      juzNumber: juzNumber ?? this.juzNumber,
      quantity: quantity ?? this.quantity,
      unit: unit ?? this.unit,
      reference: reference ?? this.reference,
      isReview: isReview ?? this.isReview,
      repetitions: repetitions ?? this.repetitions,
      durationMinutes: durationMinutes ?? this.durationMinutes,
      verification: verification ?? this.verification,
      passScorePercent: passScorePercent ?? this.passScorePercent,
      rewardType: rewardType ?? this.rewardType,
      rewardAmount: rewardAmount ?? this.rewardAmount,
      rewardDescription: rewardDescription ?? this.rewardDescription,
      screenTimeExpiresInHours: screenTimeExpiresInHours ?? this.screenTimeExpiresInHours,
      frequency: frequency ?? this.frequency,
      maxPerDay: maxPerDay ?? this.maxPerDay,
      maxPerWeek: maxPerWeek ?? this.maxPerWeek,
      minAge: minAge ?? this.minAge,
      difficulty: difficulty ?? this.difficulty,
      requiresParentApproval: requiresParentApproval ?? this.requiresParentApproval,
      expiresAt: expiresAt ?? this.expiresAt,
      streakMultiplierBps: streakMultiplierBps ?? this.streakMultiplierBps,
    );
  }

  /// The `targetSpec` object, shaped per activity exactly as
  /// `validateTargetSpec` expects it.
  Map<String, dynamic> buildTargetSpec() {
    final a = activity;
    if (a == null) return const {};

    if (a.isQuranAyahRange) {
      return {
        if (surah != null) 'surahNumber': surah!.number,
        if (fromAyah != null) 'fromAyah': fromAyah,
        // A single-ayah activity sends `toAyah == fromAyah`; the server
        // rejects anything else with AYAH_RANGE_NOT_SINGLE.
        if (fromAyah != null) 'toAyah': a.isSingleAyah ? fromAyah : (toAyah ?? fromAyah),
        if (isReview) 'isReview': true,
        if (repetitions != null) 'repetitions': repetitions,
      };
    }
    if (a.isQuranSurahOnly) {
      return {
        if (surah != null) 'surahNumber': surah!.number,
        if (isReview) 'isReview': true,
        if (repetitions != null) 'repetitions': repetitions,
      };
    }
    if (a.isQuranJuz) {
      return {
        if (juzNumber != null) 'juzNumber': juzNumber,
        if (isReview) 'isReview': true,
        if (repetitions != null) 'repetitions': repetitions,
      };
    }
    return {
      if (quantity != null) 'quantity': quantity,
      if (unit != null && unit!.isNotEmpty) 'unit': unit,
      if (reference != null && reference!.isNotEmpty) 'reference': reference,
      if (repetitions != null) 'repetitions': repetitions,
    };
  }

  RewardSpec buildRewardSpec() => RewardSpec(
        type: rewardType,
        amount: rewardAmount,
        description: rewardDescription,
        expiresInHours: rewardType == 'SCREEN_TIME' ? screenTimeExpiresInHours : null,
      );

  /// The exact body `POST /reward-programs` accepts. Optional fields are
  /// OMITTED rather than sent as null — the DTO's `@IsOptional()` treats an
  /// explicit null as a value and would reject it.
  Map<String, dynamic> toCreateBody() => {
        if (childId != null && childId!.isNotEmpty) 'childId': childId,
        'category': category?.code ?? '',
        'activity': activity?.code ?? '',
        'targetSpec': buildTargetSpec(),
        'durationMinutes': durationMinutes,
        'verificationLevel': verification?.code ?? '',
        if (verification?.needsPassScore == true && passScorePercent != null)
          'verificationConfig': {'passScorePercent': passScorePercent},
        'rewardSpec': buildRewardSpec().toJson(),
        'frequency': frequency,
        'maxPerDay': maxPerDay,
        'maxPerWeek': maxPerWeek,
        if (minAge != null) 'minAge': minAge,
        'difficulty': difficulty,
        'requiresParentApproval': requiresParentApproval,
        if (expiresAt != null) 'expiresAt': expiresAt!.toUtc().toIso8601String(),
        if (streakMultiplierBps != null) 'streakMultiplierBps': streakMultiplierBps,
      };

  // --- LOCAL FORM CHECKS ------------------------------------------------
  // Each returns a localisation KEY (never a sentence), so the wizard
  // renders Arabic through the same `t(...)` path as everything else and
  // the l10n parity script can see the key.

  String? get targetProblemKey {
    final a = activity;
    if (a == null) return 'wizard.error.activityRequired';

    if (a.isQuranJuz) {
      final j = juzNumber;
      if (j == null || j < 1 || j > ProgramLimits.juzCount) {
        return 'wizard.error.juzOutOfRange';
      }
      return null;
    }

    if (a.isQuran) {
      final s = surah;
      if (s == null) return 'wizard.error.surahRequired';
      if (a.isQuranSurahOnly) return null;

      final from = fromAyah;
      if (from == null || from < 1) return 'wizard.error.fromAyahRequired';
      final to = a.isSingleAyah ? from : (toAyah ?? from);
      if (to < from) return 'wizard.error.ayahRangeInverted';
      // THE RULE THE BRIEF NAMES, checked against the real ayah count the
      // catalogue endpoint returned — the same number the server uses.
      if (to > s.ayahCount || from > s.ayahCount) return 'wizard.error.ayahOutOfSurah';
      return null;
    }

    final q = quantity;
    if (q != null && q < 1) return 'wizard.error.quantityInvalid';
    return null;
  }

  String? get durationProblemKey {
    if (durationMinutes < ProgramLimits.minDurationMinutes ||
        durationMinutes > ProgramLimits.maxDurationMinutes) {
      return 'wizard.error.durationOutOfRange';
    }
    return null;
  }

  String? get verificationProblemKey {
    final v = verification;
    if (v == null) return 'wizard.error.verificationRequired';
    if (v.needsPassScore) {
      final score = passScorePercent;
      if (score == null || score < 1 || score > 100) {
        return 'wizard.error.passScoreRequired';
      }
    }
    return null;
  }

  String? get rewardProblemKey {
    if (rewardAmount < 1) return 'wizard.error.rewardAmountInvalid';
    if (rewardType == 'SCREEN_TIME') {
      if (rewardAmount > ProgramLimits.maxScreenTimeGrantMinutes) {
        return 'wizard.error.screenTimeAboveMax';
      }
      final ttl = screenTimeExpiresInHours;
      if (ttl != null && (ttl < 1 || ttl > ProgramLimits.maxScreenTimeTtlHours)) {
        return 'wizard.error.screenTimeTtlInvalid';
      }
    }
    return null;
  }

  String? get rulesProblemKey {
    if (maxPerDay < 1 || maxPerDay > ProgramLimits.maxPerDayCeiling) {
      return 'wizard.error.maxPerDayInvalid';
    }
    if (maxPerWeek < 1 || maxPerWeek > ProgramLimits.maxPerWeekCeiling) {
      return 'wizard.error.maxPerWeekInvalid';
    }
    if (maxPerWeek < maxPerDay) return 'wizard.error.weeklyBelowDaily';
    final age = minAge;
    if (age != null && (age < 0 || age > ProgramLimits.maxMinAge)) {
      return 'wizard.error.minAgeInvalid';
    }
    return null;
  }

  /// The first unresolved problem across all steps, or null when the draft
  /// is submittable. The review step shows this and disables save.
  String? get firstProblemKey =>
      (category == null ? 'wizard.error.categoryRequired' : null) ??
      targetProblemKey ??
      durationProblemKey ??
      verificationProblemKey ??
      rewardProblemKey ??
      rulesProblemKey;

  bool get isSubmittable => firstProblemKey == null;
}
