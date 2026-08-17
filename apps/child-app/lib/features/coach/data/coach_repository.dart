import '../../../core/errors/api_failure.dart';
import '../../../core/network/api_exception.dart';
import '../api/coach_api.dart';
import '../domain/coach_models.dart';

/// JSON → domain, and [ApiException] → [ApiFailure]. Same boundary
/// `ChildAchievementsRepository` draws, for the same reason: above this line
/// nothing imports Dio and nothing loses `messageAr`.
class ChildCoachRepository {
  ChildCoachRepository(this._api);

  final ChildCoachApi _api;

  Future<ChildEncouragement> today() =>
      _guard(() async => ChildEncouragement.fromJson(await _api.today()));

  /// Unwraps `{topics: [...]}` and DROPS any row missing a code or a
  /// question. A button with no code cannot be answered and a button with no
  /// question is a blank tap target — neither belongs on a child's screen,
  /// and silently omitting one is better than rendering a broken row.
  Future<List<CoachTopic>> topics() => _guard(() async {
        final body = await _api.topics();
        final rows = body['topics'];
        if (rows is! List) return const <CoachTopic>[];
        return rows
            .whereType<Map<String, dynamic>>()
            .map(CoachTopic.fromJson)
            .where((topic) => topic.isRenderable)
            .toList(growable: false);
      });

  Future<CoachAnswer> answer(String topicCode) =>
      _guard(() async => CoachAnswer.fromJson(await _api.answer(topicCode)));

  Future<CheckinOutcome> checkin(String feeling) =>
      _guard(() async => CheckinOutcome.fromJson(await _api.checkin(feeling)));

  Future<T> _guard<T>(Future<T> Function() call) async {
    try {
      return await call();
    } on ApiException catch (e) {
      throw ApiFailure.from(e);
    }
  }
}
