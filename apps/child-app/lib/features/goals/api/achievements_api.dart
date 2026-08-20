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

  /// F1 — THE UPLOAD. `POST /self/achievements/:achievementId/evidence`.
  ///
  /// THE ROUTE THIS CLIENT COULD NOT CALL. It has existed since B5 and no
  /// version of this app ever sent it a byte, so `RECITATION_SUBMISSION` and
  /// `COMPLETION_ARTIFACT` could only ever reach `submit` without a
  /// `submissionRef` — which fails, and after `MAX_VERIFICATION_ATTEMPTS`
  /// escalates to a parent. Every Quran memorisation program in the product
  /// was unreachable through that one gap.
  ///
  /// ONE PART, NAMED `file`, matching `FileInterceptor('file', ...)`. Any
  /// other field name arrives as no file at all.
  ///
  /// NO `kind` IS SENT, AND NONE CAN BE. The server derives RECITATION vs
  /// ARTIFACT from the program's own `verificationLevel`
  /// (`evidenceKindForMethod`). If a client could state it, the server's type
  /// check would be comparing one claim against another.
  ///
  /// Answers `{submissionRef, kind, mimeType, byteSize}`. A 201 here means
  /// THE BYTES WERE STORED — nothing more, and no screen may say otherwise:
  /// both methods that reach this route have `canAutoApprove: false`.
  ///
  /// The 4xx bodies are the B3 envelope and every one carries a written
  /// Arabic sentence — `EVIDENCE_TOO_LARGE`, `EVIDENCE_TOO_SMALL`,
  /// `EVIDENCE_TYPE_UNRECOGNISED`, `EVIDENCE_TYPE_WRONG_FOR_METHOD`,
  /// `EVIDENCE_MISSING`, `ACHIEVEMENT_NOT_SUBMITTABLE`,
  /// `PROGRAM_TAKES_NO_EVIDENCE` — and they are rendered verbatim.
  Future<Map<String, dynamic>> uploadEvidence(
    String achievementId, {
    required String filePath,
    required String filename,
    required String mimeType,
  }) =>
      _client.postMultipart(
        '$_base/$achievementId/evidence',
        fieldName: 'file',
        filePath: filePath,
        filename: filename,
        contentType: mimeType,
      );

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
  ///
  /// `activeBonusMinutes` is the server's LIVE total. `screenTimeGrants` is the
  /// unrevoked HISTORY — `revokedAt: null` and nothing else, so no expiry
  /// filter and no per-grant live flag. This route does not say which of those
  /// rows the total is made of, and the route that does
  /// (`…/screen-time-policy/effective`) is parent-only. See
  /// `ChildScreenTimeGrant`.
  Future<Map<String, dynamic>> rewards() => _client.get('$_base/rewards');

  /// The points/level account. A DIFFERENT module's endpoint, reused rather
  /// than duplicated — F4 `POINTS` grants land in this same ledger.
  Future<Map<String, dynamic>> account() =>
      _client.get('/life-intelligence/self/rewards/account');
}
