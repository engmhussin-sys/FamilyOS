import '../../../core/network/api_client.dart';

/// THE TRANSPORT LAYER FOR THE F4 PARENT SURFACE — 17 endpoints, all of
/// which had zero consumers before B6 (audit PA-M-001, ⛔ Critical:
/// "المنتج المميِّز غير موجود لدى المستخدم").
///
/// This class knows PATHS and nothing else. It does not map JSON to domain
/// types (that is `RewardProgramsRepository`), it does not decide what an
/// error means (that is `ApiFailure`), and it does not hold state. It
/// extends the app's ONE central [ApiClient] — auth header, the coordinated
/// single-refresh-on-401, the retry, and the B3 error envelope parsing all
/// come from there untouched.
///
/// ROUTE PREFIX: `main.ts` sets the global prefix `api/v1` and
/// `AppConfig.apiBaseUrl` already ends in it, exactly as every other `*_api`
/// file in this app assumes.
class RewardProgramsApi {
  RewardProgramsApi(this._client);

  final ApiClient _client;

  static const String _base = '/reward-programs';

  // --- catalogue (reference data) -----------------------------------------

  /// Categories + activities + verification levels + reward types, in ONE
  /// call — the controller composes them deliberately so the create flow's
  /// first screen does not make three round trips.
  Future<Map<String, dynamic>> getCatalogue() => _client.get('$_base/catalogue');

  /// The 114 surahs with `nameAr`, `transliteration`, `ayahCount`,
  /// `revelationType`.
  Future<Map<String, dynamic>> getSurahs() => _client.get('$_base/catalogue/surahs');

  // --- programs ------------------------------------------------------------

  Future<Map<String, dynamic>> createProgram(Map<String, dynamic> body) =>
      _client.post(_base, data: body);

  /// `childId` omitted = every program in the family.
  Future<List<dynamic>> listPrograms({String? childId}) => _client.getList(
        _base,
        queryParameters: (childId == null || childId.isEmpty) ? null : {'childId': childId},
      );

  Future<Map<String, dynamic>> getProgram(String programId) => _client.get('$_base/$programId');

  Future<Map<String, dynamic>> updateProgram(String programId, Map<String, dynamic> body) =>
      _client.patch('$_base/$programId', data: body);

  /// ARCHIVE, not delete. The route is `DELETE` but the service sets
  /// `archivedAt` — history is never destroyed, which is why the UI says
  /// «أرشفة» and not «حذف».
  Future<Map<String, dynamic>> archiveProgram(String programId) =>
      _client.delete('$_base/$programId');

  // --- achievement queue ---------------------------------------------------

  /// `SUBMITTED` + `PENDING_PARENT` — the parent's real review queue.
  ///
  /// NOTE FOR ANY READER COMING FROM `pending_approvals_screen.dart`: that
  /// screen is NOT this. It lists `/life-intelligence/communication/pending`
  /// (messages awaiting approval). Audit P12 called out the confusion.
  Future<List<dynamic>> listPendingAchievements() =>
      _client.getList('$_base/achievements/pending');

  Future<List<dynamic>> listAttempts(String achievementId) =>
      _client.getList('$_base/achievements/$achievementId/attempts');

  /// B5 ADDITION — `{attempts, evidence}` in ONE call.
  ///
  /// A parent deciding on a recitation needs the attempt log AND the
  /// uploaded evidence metadata, and three round trips on a mobile network
  /// is a worse review than one. The evidence entries carry ids, types and
  /// sizes — never a `storageKey`; the bytes come from the separate
  /// authenticated stream route.
  Future<Map<String, dynamic>> getAchievementDetail(String achievementId) =>
      _client.get('$_base/achievements/$achievementId');

  /// B5 ADDITION — the parent's read of a child's achievement HISTORY.
  ///
  /// The audit's exact words about this gap: «`listForChild` موجودة بلا
  /// route والد». Until B5 only the child's own device could see its record,
  /// so the parent app had no truthful "completed goals" source at all.
  Future<List<dynamic>> listAchievementsForChild(String childId) =>
      _client.getList('$_base/achievements', queryParameters: {'childId': childId});

  /// B5 ADDITION — the same `streaksForChild` the child route calls.
  /// «الـ streaks كانت قابلة للحساب وغير مقروءة من الشخص الذي يدفع الاشتراك».
  Future<Map<String, dynamic>> getStreaks(String childId) =>
      _client.get('$_base/streaks/$childId');

  Future<Map<String, dynamic>> approveAchievement(String achievementId, {String? note}) =>
      _client.post('$_base/achievements/$achievementId/approve', data: {
        if (note != null && note.isNotEmpty) 'note': note,
      });

  Future<Map<String, dynamic>> rejectAchievement(String achievementId, {String? note}) =>
      _client.post('$_base/achievements/$achievementId/reject', data: {
        if (note != null && note.isNotEmpty) 'note': note,
      });

  // --- fulfilment ----------------------------------------------------------

  Future<List<dynamic>> listFulfilments({String? status}) => _client.getList(
        '$_base/fulfilments',
        queryParameters: (status == null || status.isEmpty) ? null : {'status': status},
      );

  /// `to` must be a LEGAL transition from the row's current status; the
  /// server's conditional UPDATE is what actually enforces it.
  Future<Map<String, dynamic>> transitionFulfilment(
    String fulfilmentId, {
    required String to,
    String? note,
  }) =>
      _client.patch('$_base/fulfilments/$fulfilmentId', data: {
        'to': to,
        if (note != null && note.isNotEmpty) 'note': note,
      });

  // --- screen-time grants --------------------------------------------------

  Future<List<dynamic>> listScreenTimeGrants(String childId) =>
      _client.getList('$_base/screen-time-grants/$childId');

  Future<Map<String, dynamic>> revokeScreenTimeGrant(String grantId) =>
      _client.delete('$_base/screen-time-grants/$grantId');

  // --- AI, advisory only ---------------------------------------------------

  /// Returns DRAFTS — an ARRAY of `{suggestionId, rationaleAr, draft,
  /// previewAr}`. This call creates nothing (CONTEXT §3 principle 2).
  Future<List<dynamic>> getSuggestions(String childId) =>
      _client.getList('$_base/suggestions/$childId');

  /// The parent's EXPLICIT accept — the only path from a suggestion to a row.
  Future<Map<String, dynamic>> acceptSuggestion({
    required String childId,
    required String suggestionId,
  }) =>
      _client.post('$_base/suggestions/accept', data: {
        'childId': childId,
        'suggestionId': suggestionId,
      });
}
