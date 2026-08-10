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
