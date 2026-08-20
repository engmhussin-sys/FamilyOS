/// THE PROGRAM — the parent-authored goal, as the server returns it.
library;

/// `{type, amount, description?, expiresInHours?}`.
class RewardSpec {
  const RewardSpec({
    required this.type,
    required this.amount,
    this.description,
    this.expiresInHours,
  });

  final String type;
  final int amount;
  final String? description;
  final int? expiresInHours;

  factory RewardSpec.fromJson(Map<String, dynamic> json) => RewardSpec(
        type: json['type']?.toString() ?? 'POINTS',
        amount: (json['amount'] as num?)?.toInt() ?? 0,
        description: json['description']?.toString(),
        expiresInHours: (json['expiresInHours'] as num?)?.toInt(),
      );

  Map<String, dynamic> toJson() => {
        'type': type,
        'amount': amount,
        if (description != null && description!.isNotEmpty) 'description': description,
        if (expiresInHours != null) 'expiresInHours': expiresInHours,
      };

  /// The server's `FULFILLABLE_REWARD_TYPES`. Mirrored here for ONE
  /// purpose: deciding whether to show the parent a "this will appear in
  /// your fulfilment queue" hint at create time. No client decision
  /// depends on it — the fulfilment row is created server-side either way.
  bool get entersFulfilmentQueue => const {
        'PHYSICAL_REWARD',
        'DIGITAL_REWARD',
        'PRIVILEGE',
        'PARENT_APPROVAL_REWARD',
        'CUSTOM_REWARD',
      }.contains(type);

  bool get isScreenTime => type == 'SCREEN_TIME';
  bool get isPoints => type == 'POINTS';
}

/// The bounds the server enforces, restated so the FORM can enforce them
/// too. Every one of these is validated again in `validateRewardSpec` /
/// `CreateRewardProgramDto`; duplicating the number here buys a parent an
/// inline hint instead of a round trip, and nothing else.
class ProgramLimits {
  ProgramLimits._();

  static const int minDurationMinutes = 1;
  static const int maxDurationMinutes = 480;
  static const int maxScreenTimeGrantMinutes = 60;
  static const int maxScreenTimeTtlHours = 168;
  static const int maxPerDayCeiling = 20;
  static const int maxPerWeekCeiling = 140;
  static const int maxMinAge = 18;
  static const int surahCount = 114;
  static const int juzCount = 30;

  /// 10000 bps = 1.00x, 30000 bps = 3.00x.
  static const int minStreakMultiplierBps = 10000;
  static const int maxStreakMultiplierBps = 30000;
}

class ProgramStatuses {
  ProgramStatuses._();

  static const String draft = 'DRAFT';
  static const String active = 'ACTIVE';
  static const String paused = 'PAUSED';
  static const String archived = 'ARCHIVED';

  static const List<String> all = [draft, active, paused, archived];
}

class ProgramFrequencies {
  ProgramFrequencies._();

  static const List<String> all = ['DAILY', 'WEEKLY', 'ONCE'];
}

class ProgramDifficulties {
  ProgramDifficulties._();

  static const List<String> all = ['EASY', 'MEDIUM', 'HARD'];
}

class RewardProgram {
  const RewardProgram({
    required this.id,
    required this.category,
    required this.activity,
    required this.targetSummaryAr,
    required this.durationMinutes,
    required this.verificationLevel,
    required this.rewardSpec,
    required this.status,
    required this.frequency,
    required this.maxPerDay,
    required this.maxPerWeek,
    required this.requiresParentApproval,
    this.childId,
    this.minAge,
    this.difficulty,
    this.expiresAt,
    this.streakMultiplierBps,
    this.targetSpec = const {},
    this.createdAt,
  });

  final String id;

  /// NULL means "every child in this family" — a real, meaningful absence
  /// the backend models deliberately; the UI must say so rather than
  /// showing a blank child name.
  final String? childId;

  final String category;
  final String activity;

  /// Derived ONCE server-side by `describeTargetSpec` so three clients do
  /// not each re-derive it — «الآيات 1–5 من سورة الملك».
  final String targetSummaryAr;

  final int durationMinutes;
  final String verificationLevel;
  final RewardSpec rewardSpec;
  final String status;
  final String frequency;
  final int maxPerDay;
  final int maxPerWeek;
  final bool requiresParentApproval;
  final int? minAge;
  final String? difficulty;
  final DateTime? expiresAt;
  final int? streakMultiplierBps;
  final Map<String, dynamic> targetSpec;
  final DateTime? createdAt;

  bool get isActive => status == ProgramStatuses.active;
  bool get isPaused => status == ProgramStatuses.paused;
  bool get isArchived => status == ProgramStatuses.archived;

  /// Assigned to one child, rather than to the whole family.
  bool get isChildSpecific => childId != null && childId!.isNotEmpty;

  factory RewardProgram.fromJson(Map<String, dynamic> json) => RewardProgram(
        id: json['id']?.toString() ?? '',
        childId: json['childId']?.toString(),
        category: json['category']?.toString() ?? '',
        activity: json['activity']?.toString() ?? '',
        targetSummaryAr: json['targetSummaryAr']?.toString() ?? '',
        durationMinutes: (json['durationMinutes'] as num?)?.toInt() ?? 0,
        verificationLevel: json['verificationLevel']?.toString() ?? '',
        rewardSpec: RewardSpec.fromJson(
          (json['rewardSpec'] as Map?)?.cast<String, dynamic>() ?? const {},
        ),
        status: json['status']?.toString() ?? ProgramStatuses.active,
        frequency: json['frequency']?.toString() ?? 'DAILY',
        maxPerDay: (json['maxPerDay'] as num?)?.toInt() ?? 1,
        maxPerWeek: (json['maxPerWeek'] as num?)?.toInt() ?? 7,
        requiresParentApproval: json['requiresParentApproval'] == true,
        minAge: (json['minAge'] as num?)?.toInt(),
        difficulty: json['difficulty']?.toString(),
        expiresAt: _parseDate(json['expiresAt']),
        streakMultiplierBps: (json['streakMultiplierBps'] as num?)?.toInt(),
        targetSpec: (json['targetSpec'] as Map?)?.cast<String, dynamic>() ?? const {},
        createdAt: _parseDate(json['createdAt']),
      );
}

DateTime? _parseDate(Object? value) {
  if (value == null) return null;
  return DateTime.tryParse(value.toString());
}
