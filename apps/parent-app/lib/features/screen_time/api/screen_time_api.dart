import '../../../core/network/api_client.dart';

/// THE TRANSPORT LAYER FOR THE PARENT'S SCREEN-TIME SURFACE.
///
/// Seven routes, every one of which had ZERO consumers in this app before this
/// feature existed: the backend has shipped a complete Screen Time API and the
/// parent app had no screen for it at all, so a headline feature of this
/// product was unreachable from the phone the parent actually holds.
///
/// Same shape as `RewardProgramsApi`, deliberately: this class knows PATHS and
/// nothing else. It does not map JSON to domain types (that is
/// `ScreenTimeRepository`), it does not decide what an error means (that is
/// `ApiFailure`), and it holds no state. It extends the app's ONE central
/// [ApiClient], so the auth header, the coordinated single-refresh-on-401, the
/// retry and the B3 error-envelope parsing all come from there untouched.
///
/// ROUTE PREFIX: `main.ts` sets the global prefix `api/v1` and
/// `AppConfig.apiBaseUrl` already ends in it, exactly as every other `*_api`
/// file in this app assumes.
class ScreenTimeApi {
  ScreenTimeApi(this._client);

  final ApiClient _client;

  // --- policy --------------------------------------------------------------

  /// `ScreenTimeController.getPolicy`. Returns the CONFIGURED policy, or a
  /// `null` body when this child has never had one — which `ApiClient._unwrap`
  /// hands over as `{'data': null}` rather than throwing.
  Future<Map<String, dynamic>> getPolicy(String childId) =>
      _client.get('/children/$childId/screen-time-policy');

  /// `ScreenTimeController.getEffectivePolicy` — the allowance a device should
  /// actually enforce today: base policy PLUS unspent earned bonus minutes.
  /// A SEPARATE ROUTE, not a flag on the one above, and the two answers are
  /// different numbers on any day the child has earned something.
  Future<Map<String, dynamic>> getEffectivePolicy(String childId) =>
      _client.get('/children/$childId/screen-time-policy/effective');

  /// `ScreenTimeController.setPolicy`. REPLACES the active policy — the server
  /// soft-deletes the previous row rather than editing it in place, so the
  /// history of «what changed and when» survives. The body's field names and
  /// bounds are `SetScreenTimePolicyDto`'s; the repository builds it.
  Future<Map<String, dynamic>> setPolicy(String childId, Map<String, dynamic> body) =>
      _client.post('/children/$childId/screen-time-policy', data: body);

  // --- app block rules -----------------------------------------------------

  /// `AppBlockRuleController.listRules` — ACTIVE rules only
  /// (`listActiveByChild`), returned as a bare JSON array.
  Future<List<dynamic>> listAppBlockRules(String childId) =>
      _client.getList('/children/$childId/app-block-rules');

  /// `AppBlockRuleController.createRule`. `CreateAppBlockRuleDto`.
  Future<Map<String, dynamic>> createAppBlockRule(
    String childId,
    Map<String, dynamic> body,
  ) =>
      _client.post('/children/$childId/app-block-rules', data: body);

  /// `AppBlockRuleController.deactivateRule` — `DELETE
  /// /children/:childId/app-block-rules/:ruleId`.
  ///
  /// DEACTIVATES, IT DOES NOT DELETE. The service calls
  /// `appBlockRuleRepository.deactivate(ruleId)`, which flips `isActive`; the
  /// row and its audit entry (`screenTime.appBlockRule.deactivated`) stay. The
  /// method name here says `deactivate` for that reason, and the UI copy says
  /// «إيقاف» rather than «حذف».
  Future<Map<String, dynamic>> deactivateAppBlockRule(String childId, String ruleId) =>
      _client.delete('/children/$childId/app-block-rules/$ruleId');

  // --- app catalogue -------------------------------------------------------

  /// `ChildAppCatalogController.listApps` — the apps actually observed on this
  /// child's devices, most-recently-used first, capped at 500.
  ///
  /// Returns the WHOLE body rather than a list, because the shape is
  /// `{ "items": [...] }` and not a bare array — the one route on this surface
  /// that is wrapped. The repository unpacks `items`.
  Future<Map<String, dynamic>> listChildApps(String childId) =>
      _client.get('/children/$childId/apps');
}
