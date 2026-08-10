import '../../../core/network/api_client.dart';

/// Every method here calls a real, already-built backend endpoint
/// (Sprints 13/15-18's life-intelligence module) — zero duplicate
/// endpoints, matching DashboardApi's own stated discipline.
class LifeIntelligenceApi {
  LifeIntelligenceApi(this._client);

  final ApiClient _client;

  /// GET /life-intelligence/digital-twin/:childId returns a JSON
  /// object (DigitalTwin) — ApiClient._unwrap returns Map responses
  /// as-is, no {'data': ...} wrapping.
  Future<Map<String, dynamic>> getDigitalTwin(String childId) {
    return _client.get('/life-intelligence/digital-twin/$childId');
  }

  Future<List<dynamic>> getTimeline(String childId, {String? category}) async {
    final query = category != null ? {'category': category} : null;
    final result = await _client.get('/life-intelligence/timeline/$childId', queryParameters: query);
    return result['data'] as List<dynamic>;
  }

  Future<List<dynamic>> getHabits(String childId) async {
    final result = await _client.get('/life-intelligence/habits/$childId');
    return result['data'] as List<dynamic>;
  }

  Future<void> completeHabit(String childId, String habitId) {
    return _client.post('/life-intelligence/habits/$childId/$habitId/complete', data: <String, dynamic>{});
  }

  Future<List<dynamic>> getCoachingRecommendations(String childId) async {
    final result = await _client.get('/life-intelligence/coaching/$childId');
    return result['data'] as List<dynamic>;
  }

  Future<Map<String, dynamic>> getRewardsAccount(String childId) {
    return _client.get('/life-intelligence/rewards/$childId/account');
  }

  Future<List<dynamic>> getFaithPractices(String childId) async {
    final result = await _client.get('/life-intelligence/faith/$childId/practices');
    return result['data'] as List<dynamic>;
  }

  Future<void> logFaithPractice(String childId, String practiceId) {
    return _client.post('/life-intelligence/faith/$childId/$practiceId/log', data: <String, dynamic>{});
  }

  Future<Map<String, dynamic>> getHealthScore(String childId) {
    return _client.get('/life-intelligence/health/$childId/score');
  }

  Future<void> logHydration(String childId, int amountMl) {
    return _client.post('/life-intelligence/health/$childId/hydration-logs', data: {'amountMl': amountMl});
  }

  Future<List<dynamic>> getFamilyStore(String familyId) async {
    final result = await _client.get('/life-intelligence/rewards/store/$familyId');
    return result['data'] as List<dynamic>;
  }

  Future<Map<String, dynamic>?> getWellbeingSnapshot(String childId) async {
    final result = await _client.get('/life-intelligence/wellbeing/$childId/snapshot');
    // ApiClient._unwrap() wraps a raw `null` JSON body as {'data': null}
    // (its own fallback for any non-Map response) — the backend
    // genuinely returns null when no snapshot data exists yet
    // (an honest absence, not a fabricated zero-average), so this
    // checks for that wrapped-null shape specifically.
    if (result.containsKey('data') && result['data'] == null && result.length == 1) return null;
    return result;
  }

  Future<List<dynamic>> getTopApps(String childId, String deviceId) async {
    final result = await _client.get('/life-intelligence/wellbeing/$childId/top-apps/$deviceId');
    return result['data'] as List<dynamic>;
  }
}
