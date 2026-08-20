import '../../../core/errors/api_failure.dart';
import '../../../core/network/api_exception.dart';
import '../api/achievements_api.dart';
import '../domain/child_achievement.dart';
import '../domain/child_goal.dart';
import '../domain/child_quiz.dart';
import '../domain/child_rewards.dart';
import '../domain/evidence.dart';

/// THE DATA LAYER BOUNDARY, child side.
///
/// JSON → domain, and [ApiException] → [ApiFailure]. Above this line no
/// controller and no widget imports the network layer, so nothing in the
/// child's UI can accidentally depend on Dio or on the transport's error
/// shape — and, more importantly, `messageAr` is carried across the
/// boundary as a first-class field rather than being flattened into a
/// generic English string.
class ChildAchievementsRepository {
  ChildAchievementsRepository(this._api);

  final ChildAchievementsApi _api;

  Future<List<TodayGoal>> today() => _guard(() async {
        final rows = await _api.today();
        return rows.whereType<Map<String, dynamic>>().map(TodayGoal.fromJson).toList();
      });

  Future<StartedAchievement> start(String programId) =>
      _guard(() async => StartedAchievement.fromJson(await _api.start(programId)));

  /// F1 — [submissionRef] IS NEW, AND ITS ABSENCE WAS HALF THE DEFECT.
  ///
  /// `ChildAchievementsApi.submit` has accepted a `submissionRef` since B6.
  /// This layer never passed one, because nothing in the app could produce
  /// one — so the parameter existed, compiled, and was structurally
  /// unreachable. That is the client half of what made every
  /// `RECITATION_SUBMISSION` and `COMPLETION_ARTIFACT` program impossible to
  /// complete.
  ///
  /// The value comes from [uploadEvidence] below and from nowhere else.
  /// `AchievementService.submit` re-resolves it against THIS achievement via
  /// `assertBelongsToAchievement`, so an invented or borrowed ref is refused
  /// with `EVIDENCE_REF_INVALID` — «الملف المرفق غير مرتبط بهذه المحاولة.»
  Future<SubmitOutcome> submit(
    String achievementId, {
    bool? selfConfirmed,
    List<int>? quizAnswers,
    String? submissionRef,
    int? foregroundMinutes,
    String? note,
  }) =>
      _guard(() async => SubmitOutcome.fromJson(await _api.submit(
            achievementId,
            selfConfirmed: selfConfirmed,
            quizAnswers: quizAnswers,
            submissionRef: submissionRef,
            foregroundMinutes: foregroundMinutes,
            note: note,
          )));

  /// F1 — sends the file and returns the receipt.
  ///
  /// A RECEIPT, NOT A VERDICT: [EvidenceRef] says the bytes were stored and
  /// says nothing else at all. Read that class's docstring before rendering
  /// any part of it.
  Future<EvidenceRef> uploadEvidence(
    String achievementId, {
    required String filePath,
    required String filename,
    required String mimeType,
  }) =>
      _guard(() async => EvidenceRef.fromJson(await _api.uploadEvidence(
            achievementId,
            filePath: filePath,
            filename: filename,
            mimeType: mimeType,
          )));

  Future<ServedQuiz> quiz(String achievementId) =>
      _guard(() async => ServedQuiz.fromJson(await _api.quiz(achievementId)));

  Future<List<ChildBadge>> badges() => _guard(() async {
        final rows = await _api.badges();
        return rows.whereType<Map<String, dynamic>>().map(ChildBadge.fromJson).toList();
      });

  Future<List<MyAttempt>> mine() => _guard(() async {
        final rows = await _api.mine();
        return rows.whereType<Map<String, dynamic>>().map(MyAttempt.fromJson).toList();
      });

  Future<StreakSet> streaks() => _guard(() async => StreakSet.fromJson(await _api.streaks()));

  Future<ChildRewardsSnapshot> rewards() =>
      _guard(() async => ChildRewardsSnapshot.fromJson(await _api.rewards()));

  Future<ChildAccount> account() =>
      _guard(() async => ChildAccount.fromJson(await _api.account()));

  Future<T> _guard<T>(Future<T> Function() call) async {
    try {
      return await call();
    } on ApiException catch (e) {
      throw ApiFailure.from(e);
    }
  }
}
