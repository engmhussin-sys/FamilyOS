import '../../../core/network/api_client.dart';

/// THE TRANSPORT LAYER FOR THE F4 CHILD SURFACE — six endpoints, all of
/// which had zero consumers before B6.
///
/// SECURITY SHAPE, restated because it is what makes this class so small:
/// **no method here sends a `childId`**. The backend derives it from the
/// DEVICE in the verified token, via `getChildAndFamilyIdForDevice`. A
/// device that posted another child's id would gain nothing, because the
/// value is never read. That is why there is no child identifier anywhere
/// in this file and why there must never be one.
///
/// Extends the app's existing central [ApiClient] — device-token auth, the
/// coordinated single refresh on 401, and the B3 error-envelope parsing all
/// come from there untouched.
class ChildAchievementsApi {
  ChildAchievementsApi(this._client);

  final ApiClient _client;

  static const String _base = '/self/achievements';

  /// Today's programs, each with `available` and — when it is not — the
  /// Arabic reason, so the app explains instead of failing on tap.
  Future<List<dynamic>> today() => _client.getList('$_base/today');

  /// Creates an `AchievementRequest`. Never a grant.
  Future<Map<String, dynamic>> start(String programId) =>
      _client.post('$_base/start', body: {'programId': programId});

  /// SUBMIT EVIDENCE — not a result.
  ///
  /// There is deliberately no `result` parameter and there never will be:
  /// `SubmitAchievementDto` has no field by which a child can state an
  /// outcome. Everything below is evidence the server weighs
  /// (`verification-strategies.ts`), including [foregroundMinutes], which
  /// is bounded by the server's own wall clock before it counts.
  ///
  /// B5 CONTRACT CHANGE, TRACKED: `quizCorrect`/`quizTotal` were DELETED
  /// from the DTO — not deprecated — and the backend runs
  /// `forbidNonWhitelisted`, so a client still sending them is rejected with
  /// a named field rather than silently getting the old behaviour. They are
  /// therefore absent here too, replaced by [quizAnswers]: a sheet of chosen
  /// indices, positionally aligned with the order
  /// `GET /self/achievements/:id/quiz` served. A wrong answer sheet scores
  /// badly; a wrong score used to score whatever it liked.
  Future<Map<String, dynamic>> submit(
    String achievementId, {
    bool? selfConfirmed,
    List<int>? quizAnswers,
    int? testsPassed,
    int? testsTotal,
    String? submissionRef,
    int? foregroundMinutes,
    String? note,
  }) =>
      _client.post('$_base/$achievementId/submit', body: {
        if (selfConfirmed != null) 'selfConfirmed': selfConfirmed,
        if (quizAnswers != null && quizAnswers.isNotEmpty) 'quizAnswers': quizAnswers,
        if (testsPassed != null) 'testsPassed': testsPassed,
        if (testsTotal != null) 'testsTotal': testsTotal,
        if (submissionRef != null && submissionRef.isNotEmpty) 'submissionRef': submissionRef,
        if (foregroundMinutes != null) 'foregroundMinutes': foregroundMinutes,
        if (note != null && note.isNotEmpty) 'note': note,
      });

  /// THE QUESTIONS, WITHOUT THE ANSWERS — B5's new route.
  ///
  /// Returns `{achievementId, attemptNo, totalCount, questions:[{id,
  /// promptAr, choices, difficulty}]}`. `correctChoiceIndex` is not merely
  /// omitted by this client; the repository behind the route selects four
  /// columns and the key is not one of them, so it is unreachable.
  ///
  /// 409 `PROGRAM_HAS_NO_QUIZ` when the goal is not a quiz goal, and 409
  /// `QUIZ_BANK_EMPTY` — «لا توجد أسئلة جاهزة لهذا النشاط بعد. أخبر ولي
  /// أمرك ليضيفها.» — when no questions have been authored yet. Both carry
  /// `messageAr` and both are rendered as coaching, not as errors.
  Future<Map<String, dynamic>> quiz(String achievementId) =>
      _client.get('$_base/$achievementId/quiz');

  Future<List<dynamic>> mine() => _client.getList('$_base/mine');

  /// The child's earned badges — B5's new route, closing audit C10 (⛔),
  /// where `ChildBadgeAward` had been written since Sprint 13 and read by
  /// no client at all.
  Future<List<dynamic>> badges() => _client.getList('$_base/badges');

  /// Five buckets, recomputed from verified rows on every call.
  Future<Map<String, dynamic>> streaks() => _client.get('$_base/streaks');

  /// `{activeBonusMinutes, screenTimeGrants, fulfilments}`.
  Future<Map<String, dynamic>> rewards() => _client.get('$_base/rewards');

  /// The points/level account. A DIFFERENT module's endpoint, reused rather
  /// than duplicated — F4 `POINTS` grants land in this same ledger.
  Future<Map<String, dynamic>> account() =>
      _client.get('/life-intelligence/self/rewards/account');
}
