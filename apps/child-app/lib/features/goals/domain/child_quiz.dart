/// THE QUIZ — questions WITHOUT the answers.
///
/// `GET /self/achievements/:id/quiz` was added by B5 (backend) after B7's
/// first pass was written against a world where no question bank existed.
/// The change it made is the whole point of the feature: the child's device
/// used to send `quizCorrect`/`quizTotal` — a SCORE it computed itself, on
/// a `canAutoApprove: true` method, with no answer key anywhere in the
/// product. B5 deleted those two fields from the DTO and replaced them with
/// `quizAnswers: number[]`, an ANSWER SHEET.
///
/// The client-side consequence, stated plainly: **there is no field on this
/// model that could hold a correct answer, and no method on it that could
/// compute a score.** [ServedQuiz] carries prompts and choices; the sheet
/// the child fills is a list of chosen indices; the server holds the key
/// (`quiz_questions.correct_choice_index`, never selected into a response)
/// and grades positionally against the order it served.
library;

class QuizQuestion {
  const QuizQuestion({
    required this.id,
    required this.promptAr,
    required this.choices,
    required this.difficulty,
  });

  final String id;
  final String promptAr;
  final List<String> choices;
  final String difficulty;

  factory QuizQuestion.fromJson(Map<String, dynamic> json) => QuizQuestion(
        id: json['id']?.toString() ?? '',
        promptAr: json['promptAr']?.toString() ?? '',
        choices: (json['choices'] as List<dynamic>? ?? const [])
            .map((e) => e.toString())
            .toList(),
        difficulty: json['difficulty']?.toString() ?? '',
      );
}

class ServedQuiz {
  const ServedQuiz({
    required this.achievementId,
    required this.attemptNo,
    required this.totalCount,
    required this.questions,
  });

  final String achievementId;

  /// The server draws ONE set per `(achievementId, attemptNo)` and records
  /// it. Re-opening the quiz inside the same attempt returns the identical
  /// set — enforced by a unique index, not by a check — so a child cannot
  /// re-roll into an easier draw by backing out.
  final int attemptNo;

  final int totalCount;
  final List<QuizQuestion> questions;

  bool get isEmpty => questions.isEmpty;

  factory ServedQuiz.fromJson(Map<String, dynamic> json) => ServedQuiz(
        achievementId: json['achievementId']?.toString() ?? '',
        attemptNo: (json['attemptNo'] as num?)?.toInt() ?? 1,
        totalCount: (json['totalCount'] as num?)?.toInt() ?? 0,
        questions: (json['questions'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(QuizQuestion.fromJson)
            .toList(),
      );
}

/// One earned badge — `GET /self/achievements/badges`.
///
/// `ChildBadgeAward` has been written server-side since Sprint 13 and read
/// by nobody; audit C10 marked it ⛔ («`ChildBadgeAward` يُكتب خادميًا ولا
/// يقرؤه أحد»). B5 added the read route; this is the model behind the
/// child's badge shelf.
class ChildBadge {
  const ChildBadge({
    required this.id,
    required this.badgeId,
    this.key,
    this.title,
    this.description,
    this.awardedAt,
    this.isGroupAchievement = false,
  });

  final String id;
  final String badgeId;
  final String? key;

  /// Authored server-side. Rendered verbatim — the client has no badge
  /// catalogue of its own and must not invent titles for ids it does not
  /// recognise.
  final String? title;

  final String? description;
  final DateTime? awardedAt;

  /// A badge the whole family earned together, not one child alone.
  final bool isGroupAchievement;

  factory ChildBadge.fromJson(Map<String, dynamic> json) => ChildBadge(
        id: json['id']?.toString() ?? '',
        badgeId: json['badgeId']?.toString() ?? '',
        key: json['key']?.toString(),
        title: json['title']?.toString(),
        description: json['description']?.toString(),
        awardedAt: DateTime.tryParse(json['awardedAt']?.toString() ?? ''),
        isGroupAchievement: json['isGroupAchievement'] == true,
      );
}
