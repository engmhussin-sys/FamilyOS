import '../../../core/network/api_client.dart';

/// "Create Family" reuses `PATCH /settings` (Sprint 8, real) rather than
/// inventing a new endpoint — `AuthService.register` already creates a
/// `Family` row for every new parent; there is no separate "create
/// family" concept on the backend to call. This screen's job is filling
/// in the name/timezone the backend defaulted at registration, via the
/// existing settings-update path — per the explicit "no duplicate
/// endpoints" rule. "Country" and "number of children" are not real
/// backend fields (`Family` has no `country` column, and child count is
/// derived from actual `Child` rows, not declared upfront) — collected
/// client-side only for onboarding UX, not sent to the backend as-is;
/// `country` informs the locale/timezone default, `numberOfChildren` is
/// purely a UI expectation-setter, not persisted anywhere.
class FamilyApi {
  FamilyApi(this._client);

  final ApiClient _client;

  Future<Map<String, dynamic>> setupFamily({required String name, String? timezone}) {
    return _client.patch('/settings', data: {
      'name': name,
      if (timezone != null) 'timezone': timezone,
    });
  }
}
