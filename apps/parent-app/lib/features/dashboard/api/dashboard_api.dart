import '../../../core/network/api_client.dart';

/// Composes THREE already-existing endpoints for the Dashboard Home
/// screen — no new backend aggregation endpoint was added. A future
/// optimization could add a single `/mobile/dashboard-summary` endpoint
/// if these three round-trips prove too slow on real networks (a real,
/// deferred decision, not attempted speculatively here).
class DashboardApi {
  DashboardApi(this._client);

  final ApiClient _client;

  Future<List<dynamic>> getChildren() async {
    final result = await _client.get('/children');
    // GET /children returns a raw JSON array; ApiClient._unwrap wraps
    // any non-Map response body as {'data': <body>} — see api_client.dart.
    return result['data'] as List<dynamic>;
  }

  Future<List<dynamic>> getDevices() async {
    final result = await _client.get('/pairing/devices');
    return result['data'] as List<dynamic>;
  }

  Future<int> getUnreadNotificationCount() async {
    final result = await _client.get('/notifications/unread-count');
    // GET /notifications/unread-count returns a bare JSON number.
    return result['data'] as int;
  }
}
