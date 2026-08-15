/// THE ATTEMPT — start, submit, and what came back.
library;

class ChildAchievementStatuses {
  ChildAchievementStatuses._();

  static const String requested = 'REQUESTED';
  static const String inProgress = 'IN_PROGRESS';
  static const String submitted = 'SUBMITTED';
  static const String pendingParent = 'PENDING_PARENT';
  static const String verified = 'VERIFIED';
  static const String rejected = 'REJECTED';
  static const String expired = 'EXPIRED';
}

/// What `POST /self/achievements/start` returns.
///
/// `startedAt` IS THE SERVER'S CLOCK. The timer on screen counts from it,
/// not from the moment the button was tapped, so a device with a wrong
/// clock or a child who kills the app cannot manufacture elapsed minutes —
/// the server recomputes elapsed time from this same value on submit.
class StartedAchievement {
  const StartedAchievement({
    required this.id,
    required this.programId,
    required this.status,
    required this.attemptNo,
    this.startedAt,
    this.localDate,
  });

  final String id;
  final String programId;
  final String status;
  final int attemptNo;
  final DateTime? startedAt;
  final String? localDate;

  factory StartedAchievement.fromJson(Map<String, dynamic> json) => StartedAchievement(
        id: json['id']?.toString() ?? '',
        programId: json['programId']?.toString() ?? '',
        status: json['status']?.toString() ?? ChildAchievementStatuses.inProgress,
        attemptNo: (json['attemptNo'] as num?)?.toInt() ?? 1,
        startedAt: DateTime.tryParse(json['startedAt']?.toString() ?? ''),
        localDate: json['localDate']?.toString(),
      );
}

/// The server's verdict, from `POST /self/achievements/:id/submit`.
///
/// `{ status, outcome: { result, scorePercent, reasonCode, messageAr },
///    attemptsLeft }`.
///
/// EVERY WORD THE CHILD READS AFTER SUBMITTING COMES FROM `outcome.messageAr`.
/// F4 wrote them all — «النتيجة 80% — اجتزت العتبة.»، «أرسلنا محاولتك إلى
/// ولي الأمر ليطّلع عليها.»، «النتيجة 40% والعتبة 70%. جرّب مرة أخرى.» —
/// and before B6 not one of them reached a screen.
class SubmitOutcome {
  const SubmitOutcome({
    required this.status,
    required this.result,
    required this.reasonCode,
    required this.messageAr,
    required this.attemptsLeft,
    this.scorePercent,
  });

  /// VERIFIED | PENDING_PARENT | IN_PROGRESS.
  final String status;

  /// PASSED | FAILED | ESCALATED.
  final String result;

  final String reasonCode;

  /// The sentence. Rendered verbatim.
  final String messageAr;

  /// How many automatic attempts remain. Zero does NOT mean "you failed" —
  /// it means the next submit escalates to a parent, which is the
  /// non-punitive design F4 chose deliberately.
  final int attemptsLeft;

  final int? scorePercent;

  /// THE CELEBRATION TRIGGER — and the only one. A child sees confetti
  /// because the SERVER granted a reward, never because a timer finished.
  bool get isVerified => status == ChildAchievementStatuses.verified || result == 'PASSED';

  /// Waiting on a parent. Warm, not a failure: nothing was lost.
  bool get isWaitingForParent =>
      status == ChildAchievementStatuses.pendingParent || result == 'ESCALATED';

  /// The attempt is still open and can be submitted again.
  bool get canTryAgain => !isVerified && !isWaitingForParent;

  factory SubmitOutcome.fromJson(Map<String, dynamic> json) {
    final outcome = (json['outcome'] as Map?)?.cast<String, dynamic>() ?? const {};
    return SubmitOutcome(
      status: json['status']?.toString() ?? '',
      result: outcome['result']?.toString() ?? '',
      reasonCode: outcome['reasonCode']?.toString() ?? '',
      messageAr: outcome['messageAr']?.toString() ?? '',
      attemptsLeft: (json['attemptsLeft'] as num?)?.toInt() ?? 0,
      scorePercent: (outcome['scorePercent'] as num?)?.toInt(),
    );
  }
}

/// One row of «محاولاتي» — `GET /self/achievements/mine`.
class MyAttempt {
  const MyAttempt({
    required this.id,
    required this.programId,
    required this.status,
    required this.attemptNo,
    this.localDate,
    this.elapsedMinutes,
    this.grantedAmount,
    this.streakDaysAtVerification,
  });

  final String id;
  final String programId;
  final String status;
  final int attemptNo;
  final String? localDate;
  final int? elapsedMinutes;
  final int? grantedAmount;
  final int? streakDaysAtVerification;

  bool get isVerified => status == ChildAchievementStatuses.verified;
  bool get isWaiting =>
      status == ChildAchievementStatuses.pendingParent ||
      status == ChildAchievementStatuses.submitted;
  bool get isOpen =>
      status == ChildAchievementStatuses.inProgress ||
      status == ChildAchievementStatuses.requested;

  factory MyAttempt.fromJson(Map<String, dynamic> json) => MyAttempt(
        id: json['id']?.toString() ?? '',
        programId: json['programId']?.toString() ?? '',
        status: json['status']?.toString() ?? '',
        attemptNo: (json['attemptNo'] as num?)?.toInt() ?? 1,
        localDate: _dateOnly(json['localDate']),
        elapsedMinutes: (json['elapsedMinutes'] as num?)?.toInt(),
        grantedAmount: (json['grantedAmount'] as num?)?.toInt(),
        streakDaysAtVerification: (json['streakDaysAtVerification'] as num?)?.toInt(),
      );
}

/// `local_date` is a `@db.Date` — a CALENDAR DAY serialised at UTC
/// midnight. Re-zoning it on the device would move a child's Tuesday to
/// Monday in a negative offset. Taking the first 10 characters is the only
/// correct read.
String? _dateOnly(Object? value) {
  if (value == null) return null;
  final text = value.toString();
  return text.length >= 10 ? text.substring(0, 10) : text;
}
