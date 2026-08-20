/// TODAY'S GOALS, as the child's own device sees them.
///
/// `GET /self/achievements/today` returns one row per program with
/// `available` already decided SERVER-SIDE by `checkProgramEligibility`,
/// and, when it is false, the reason — including the Arabic sentence the
/// child should read. Nothing in this file decides availability; it reads
/// an answer.
library;

/// Why a goal is not available right now.
///
/// THIS IS THE MOST IMPORTANT SMALL CLASS IN THE CHILD APP. Its
/// [messageAr] is where CONTEXT §3 principle 7 (NO PUNITIVE UX) actually
/// lands: the server does not say «ممنوع» or «تم حظرك», it says
/// «أكملت هذا البرنامج مرة اليوم — وهذا هو الحد اليومي. نراك غدًا!». The
/// client's entire job is to render that sentence and not improve on it.
class UnavailableReason {
  const UnavailableReason({required this.code, required this.messageAr, this.message});

  /// `MAX_PER_DAY_REACHED`, `ATTEMPT_ALREADY_OPEN`, `PROGRAM_EXPIRED`,
  /// `CHILD_BELOW_MIN_AGE`, … — branch on this, never on the sentence.
  final String code;

  final String messageAr;
  final String? message;

  factory UnavailableReason.fromJson(Map<String, dynamic> json) => UnavailableReason(
        code: json['code']?.toString() ?? 'UNAVAILABLE',
        messageAr: json['messageAr']?.toString() ?? '',
        message: json['message']?.toString(),
      );

  /// A goal already completed today is a DIFFERENT feeling from one that
  /// expired or that a younger sibling is not old enough for. The card uses
  /// this only to pick a warm icon, never to change the words.
  bool get isDoneForToday =>
      code == 'MAX_PER_DAY_REACHED' ||
      code == 'MAX_PER_WEEK_REACHED' ||
      code == 'PROGRAM_ALREADY_COMPLETED';

  bool get hasOpenAttempt => code == 'ATTEMPT_ALREADY_OPEN';
}

/// `{type, amount, description?}` — what this goal pays.
class GoalReward {
  const GoalReward({required this.type, required this.amount, this.description});

  final String type;
  final int amount;
  final String? description;

  bool get isPoints => type == 'POINTS';
  bool get isScreenTime => type == 'SCREEN_TIME';

  factory GoalReward.fromJson(Map<String, dynamic> json) => GoalReward(
        type: json['type']?.toString() ?? 'POINTS',
        amount: (json['amount'] as num?)?.toInt() ?? 0,
        description: json['description']?.toString(),
      );
}

class TodayGoal {
  const TodayGoal({
    required this.programId,
    required this.category,
    required this.activity,
    required this.targetSummaryAr,
    required this.durationMinutes,
    required this.reward,
    required this.verificationLevel,
    required this.available,
    this.unavailableReason,
  });

  final String programId;
  final String category;
  final String activity;

  /// «الآيات 1–5 من سورة الملك» — derived server-side by
  /// `describeTargetSpec`, so the child app never assembles Arabic from
  /// numbers and never has to know what a `targetSpec` is.
  final String targetSummaryAr;

  final int durationMinutes;
  final GoalReward reward;
  final String verificationLevel;

  /// Decided by the server's `checkProgramEligibility`. The child app has
  /// no opinion — it greys a card and shows the reason.
  final bool available;

  final UnavailableReason? unavailableReason;

  /// The evidence this goal's verification method expects from the child.
  /// A ROUTING decision (which control to render), not a verification
  /// decision — the server runs the strategy and decides the outcome.
  bool get needsSelfConfirmation => verificationLevel == 'SELF_CHECK';

  bool get needsQuiz =>
      verificationLevel == 'QUIZ' || verificationLevel == 'DURATION_PLUS_QUIZ';

  bool get needsUpload =>
      verificationLevel == 'RECITATION_SUBMISSION' ||
      verificationLevel == 'COMPLETION_ARTIFACT';

  bool get needsForegroundTime =>
      verificationLevel == 'DURATION' || verificationLevel == 'DURATION_PLUS_QUIZ';

  /// A method that CANNOT auto-approve always ends with a parent. Used only
  /// to set expectations in the submit copy («هيوصل لولي أمرك»), never to
  /// change what is sent.
  bool get endsWithParent =>
      verificationLevel == 'PARENT_CONFIRMATION' ||
      verificationLevel == 'RECITATION_SUBMISSION' ||
      verificationLevel == 'COMPLETION_ARTIFACT';

  factory TodayGoal.fromJson(Map<String, dynamic> json) {
    final reason = json['unavailableReason'];
    return TodayGoal(
      programId: json['id']?.toString() ?? '',
      category: json['category']?.toString() ?? '',
      activity: json['activity']?.toString() ?? '',
      targetSummaryAr: json['targetSummaryAr']?.toString() ?? '',
      durationMinutes: (json['durationMinutes'] as num?)?.toInt() ?? 0,
      reward: GoalReward.fromJson(
        (json['rewardSpec'] as Map?)?.cast<String, dynamic>() ?? const {},
      ),
      verificationLevel: json['verificationLevel']?.toString() ?? '',
      available: json['available'] == true,
      unavailableReason: reason is Map
          ? UnavailableReason.fromJson(reason.cast<String, dynamic>())
          : null,
    );
  }
}
