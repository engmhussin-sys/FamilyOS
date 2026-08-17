import '../../../core/errors/api_failure.dart';
import '../../../core/observability/failure_logger.dart';
import '../api/life_intelligence_api.dart';

/// THE MISSING BOUNDARY.
///
/// The ten Life Intelligence screens called [LifeIntelligenceApi] directly
/// and each ended its `_load()` with `catch (e) { _errorMessage =
/// e.toString(); }`. Two things were wrong with that and this file fixes
/// both in one place rather than ten:
///
///   1. `e.toString()` on an `ApiException` is its `message` — for a proxy
///      502 or a dropped socket that is Dio's own English, complete with an
///      HTTP status code. `ApiFailure.from` is the conversion that turns
///      that into a sentence a parent can read, and it lives on THIS side of
///      the boundary so no screen has to remember to call it.
///   2. the original error was then unreachable. `_guard` hands it to a
///      [FailureLogger] with its stack trace BEFORE converting, so the
///      diagnostic outlives the sanitised message.
///
/// It is deliberately thin. `RewardProgramsRepository` also maps JSON onto
/// domain types; doing that here would mean writing ten model classes and
/// rewriting ten screens' render code, which is a different change from the
/// one this is. The shapes returned below are exactly the shapes the API
/// returns, so every screen body is untouched.
class LifeIntelligenceRepository {
  LifeIntelligenceRepository(this._api, {FailureLogger? logger})
      : _logger = logger ?? const SentryFailureLogger();

  final LifeIntelligenceApi _api;
  final FailureLogger _logger;

  // --- digital twin --------------------------------------------------------

  Future<Map<String, dynamic>> getDigitalTwin(String childId) =>
      _guard('getDigitalTwin', () => _api.getDigitalTwin(childId));

  // --- timeline ------------------------------------------------------------

  Future<List<dynamic>> getTimeline(String childId, {String? category}) =>
      _guard('getTimeline', () => _api.getTimeline(childId, category: category));

  // --- habits --------------------------------------------------------------

  Future<List<dynamic>> getHabits(String childId) =>
      _guard('getHabits', () => _api.getHabits(childId));

  Future<void> completeHabit(String childId, String habitId) =>
      _guard('completeHabit', () => _api.completeHabit(childId, habitId));

  // --- coaching ------------------------------------------------------------

  Future<List<dynamic>> getCoachingRecommendations(String childId) =>
      _guard('getCoachingRecommendations', () => _api.getCoachingRecommendations(childId));

  // --- faith ---------------------------------------------------------------

  Future<List<dynamic>> getFaithPractices(String childId) =>
      _guard('getFaithPractices', () => _api.getFaithPractices(childId));

  Future<void> logFaithPractice(String childId, String practiceId) =>
      _guard('logFaithPractice', () => _api.logFaithPractice(childId, practiceId));

  // --- health --------------------------------------------------------------

  Future<Map<String, dynamic>> getHealthScore(String childId) =>
      _guard('getHealthScore', () => _api.getHealthScore(childId));

  Future<void> logHydration(String childId, int amountMl) =>
      _guard('logHydration', () => _api.logHydration(childId, amountMl));

  // --- store ---------------------------------------------------------------

  Future<List<dynamic>> getFamilyStore(String familyId) =>
      _guard('getFamilyStore', () => _api.getFamilyStore(familyId));

  // --- wellbeing -----------------------------------------------------------

  /// `null` is a real answer here, not an error: the backend returns it when
  /// no snapshot exists yet. The screen's own "no data" branch depends on
  /// that distinction, so it is preserved rather than collapsed into an
  /// empty map.
  Future<Map<String, dynamic>?> getWellbeingSnapshot(String childId) =>
      _guard('getWellbeingSnapshot', () => _api.getWellbeingSnapshot(childId));

  Future<Map<String, dynamic>?> getWellbeingInsight(String childId, {String? date}) =>
      _guard('getWellbeingInsight', () => _api.getWellbeingInsight(childId, date: date));

  // --- learning ------------------------------------------------------------

  Future<Map<String, dynamic>> getLearningProgress(String childId) =>
      _guard('getLearningProgress', () => _api.getLearningProgress(childId));

  // --- message approvals ---------------------------------------------------

  Future<List<dynamic>> getPendingMessages() =>
      _guard('getPendingMessages', () => _api.getPendingMessages());

  Future<void> approveMessage(String childId, String messageId) =>
      _guard('approveMessage', () => _api.approveMessage(childId, messageId));

  Future<void> rejectMessage(String childId, String messageId) =>
      _guard('rejectMessage', () => _api.rejectMessage(childId, messageId));

  /// THE ONLY PLACE THIS FEATURE CONVERTS AN ERROR.
  ///
  /// Catches everything, not just an `ApiException`: a backend that renames a
  /// field turns into a `TypeError` inside a cast, and a parent must not read
  /// that either. Whatever it was, it is logged with its stack and rethrown
  /// as an [ApiFailure] — so `catch (e) { ApiFailure.from(e) }` in a screen
  /// still behaves, and `on ApiFailure catch` works too.
  Future<T> _guard<T>(String operation, Future<T> Function() call) async {
    try {
      return await call();
    } catch (error, stackTrace) {
      final failure = ApiFailure.from(error);
      _logger.record(error, stackTrace, operation: operation, failure: failure);
      throw failure;
    }
  }
}
