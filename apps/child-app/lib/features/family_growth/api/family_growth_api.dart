import '../../../core/network/api_client.dart';

/// Every method here calls the device-authenticated self-logging
/// endpoints added in Sprint 29 (`/life-intelligence/self/*`) \u2014 the
/// Child App has no parent JWT, only its own device session, so it
/// can never call the parent-facing `/life-intelligence/habits/...`
/// routes directly. The backend resolves this device's own paired
/// child server-side; nothing here ever sends a childId.
class FamilyGrowthApi {
  FamilyGrowthApi(this._client);

  final ApiClient _client;

  Future<Map<String, dynamic>> getProfile() {
    return _client.get('/life-intelligence/self/profile');
  }

  Future<List<dynamic>> getHabits() {
    return _client.getList('/life-intelligence/self/habits');
  }

  Future<void> completeHabit(String habitId) {
    return _client.post('/life-intelligence/self/habits/$habitId/complete', body: <String, dynamic>{});
  }

  Future<void> logHydration(int amountMl) {
    return _client.post('/life-intelligence/self/health/hydration-logs', body: {'amountMl': amountMl});
  }

  /// Sprint 16.4 — CLOSES A REAL GAP: getDailyProgress existed since
  /// Sprint 15/16.1 but had zero Child App consumer (or even a
  /// reachable endpoint) before this sprint's backend addition.
  Future<Map<String, dynamic>> getHealthProgress() {
    return _client.get('/life-intelligence/self/health/progress');
  }

  Future<void> logActivity({required String date, required String activityType, required int durationMinutes, required String socialContext}) {
    return _client.post('/life-intelligence/self/health/activity-logs', body: {
      'date': date,
      'activityType': activityType,
      'durationMinutes': durationMinutes,
      'socialContext': socialContext,
    });
  }

  /// Sprint 16.4 — CLOSES A REAL GAP: LearningEngineService had zero
  /// Child App consumer at all — Education had no path to the Child
  /// App whatsoever before this sprint.
  Future<Map<String, dynamic>> getLearningProgress() {
    return _client.get('/life-intelligence/self/learning/progress');
  }

  Future<void> logLearningSession({required String subject, required int durationMinutes, required String date}) {
    return _client.post('/life-intelligence/self/learning/sessions', body: {
      'subject': subject,
      'durationMinutes': durationMinutes,
      'date': date,
    });
  }

  /// CLOSES A REAL GAP: CoachingEngineService had zero Child App
  /// consumer at all. Server-side already filters to CHILD-track
  /// recommendations only (see the backend endpoint's own docstring
  /// for why this filtering can never happen client-side) — every
  /// item this returns is real, encouraging, child-appropriate text.
  Future<List<dynamic>> getCoaching() {
    return _client.getList('/life-intelligence/self/coaching');
  }

  /// CLOSES A REAL GAP: acknowledgeMessage existed in the backend
  /// service layer but had zero endpoint (and, until this same fix,
  /// zero ownership check — a real IDOR vulnerability closed before
  /// this endpoint was ever exposed). Best-effort from the caller's
  /// perspective — a failed acknowledge is never worth interrupting
  /// the child's experience over.
  Future<void> acknowledgeMessage(String messageId) {
    return _client.post('/life-intelligence/self/messages/$messageId/acknowledge', body: <String, dynamic>{});
  }

  /// CLOSES A REAL GAP: SmartTaskEngineService (context-aware,
  /// server-computed suggestions — e.g. "you missed sleep, try
  /// winding down early tonight") had zero Child App consumer, and
  /// until a real backend design flaw fix, no frontend could have
  /// used it meaningfully anyway (see the backend's own
  /// generateForTodayAuto docstring). Idempotent server-side — safe
  /// to call every time the screen loads, never creates duplicates.
  Future<List<dynamic>> generateSmartTasks() async {
    final result = await _client.post('/life-intelligence/self/smart-tasks/generate', body: <String, dynamic>{});
    return result['data'] as List<dynamic>;
  }

  Future<void> decideSmartTask(String taskId, String status) {
    return _client.post('/life-intelligence/self/smart-tasks/$taskId/decide', body: {'status': status});
  }

  Future<List<dynamic>> getFaithPractices() {
    return _client.getList('/life-intelligence/self/faith/practices');
  }

  Future<void> logFaithPractice(String practiceId) {
    return _client.post('/life-intelligence/self/faith/$practiceId/log', body: <String, dynamic>{});
  }

  /// Delivered-only inbox (Sprint 17/23) \u2014 a PENDING AI draft awaiting
  /// parent approval is structurally unreachable through this endpoint
  /// regardless of caller.
  Future<List<dynamic>> getMessages() {
    return _client.getList('/life-intelligence/self/messages');
  }

  Future<Map<String, dynamic>> getRewardsAccount() {
    return _client.get('/life-intelligence/self/rewards/account');
  }

  Future<List<dynamic>> getRewardsStore() {
    return _client.getList('/life-intelligence/self/rewards/store');
  }

  Future<void> redeemReward(String catalogItemId) {
    return _client.post('/life-intelligence/self/rewards/redeem/$catalogItemId', body: <String, dynamic>{});
  }
}
