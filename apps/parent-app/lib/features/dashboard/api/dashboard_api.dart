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

  /// `GET /children/:childId` — `ChildrenController.getOne`
  /// (`apps/backend/src/modules/children/presentation/controllers/children.controller.ts:47`),
  /// `@ParentSurface()`, and scoped to `user.familyId` taken from the verified
  /// access token rather than from the path. An id belonging to another family
  /// answers `ChildNotFoundException` — a 404 carrying a server-authored Arabic
  /// sentence — instead of leaking a row, which is what makes it safe to open
  /// this route from an id that arrived on a deep link.
  ///
  /// It sits beside [getChildren] because it is the same resource on the same
  /// controller; a separate `ChildrenApi` for one route would give `/children`
  /// two clients inside one app.
  ///
  /// Returns the raw body on purpose. `ChildProfileRepository.getChild` is what
  /// turns it into a typed value: the row carries columns this app has no
  /// business rendering (`pinCodeHash`, `familyId`), and a screen holding the
  /// raw map is a screen one line away from putting one of them on a label.
  Future<Map<String, dynamic>> getChild(String childId) {
    return _client.get('/children/$childId');
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

  /// CLOSES A REAL GAP found while wiring Sprint 1's consent
  /// enforcement: zero screen anywhere in this app ever called
  /// `POST /children` — AddChildScreen only ever assumed a child
  /// already existed (it generates a PAIRING code for an existing
  /// one). A brand-new parent had no path to create their first
  /// child's profile at all.
  Future<Map<String, dynamic>> createChild({
    required String firstName,
    required String dateOfBirth,
    String? lastName,
  }) {
    return _client.post('/children', data: {
      'firstName': firstName,
      'dateOfBirth': dateOfBirth,
      if (lastName != null && lastName.isNotEmpty) 'lastName': lastName,
    });
  }
}
