import '../../../core/network/api_client.dart';

/// Every method here calls a real, already-built backend endpoint
/// (Sprint 8's billing module, `/billing/*`, JWT-authenticated) —
/// zero invented endpoints. `_client.get()` on a raw-array response
/// gets wrapped as `{'data': [...]}` by ApiClient._unwrap (same
/// pattern LifeIntelligenceApi.getFamilyStore already relies on).
class BillingApi {
  BillingApi(this._client);

  final ApiClient _client;

  Future<List<dynamic>> getPlans() async {
    final result = await _client.get('/billing/plans');
    return result['data'] as List<dynamic>;
  }

  Future<Map<String, dynamic>> getSubscription() {
    return _client.get('/billing/subscription');
  }

  Future<void> startTrial() {
    return _client.post('/billing/trial/start');
  }

  Future<Map<String, dynamic>> subscribe(String planTier, String provider) {
    return _client.post('/billing/subscribe', data: {'planTier': planTier, 'provider': provider});
  }

  Future<void> cancel() {
    return _client.post('/billing/cancel');
  }

  Future<List<dynamic>> getBillingHistory() async {
    final result = await _client.get('/billing/history');
    return result['data'] as List<dynamic>;
  }
}
