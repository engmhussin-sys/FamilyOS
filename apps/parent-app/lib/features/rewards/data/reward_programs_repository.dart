import '../../../core/errors/api_failure.dart';
import '../../../core/network/api_exception.dart';
import '../../life_intelligence/api/life_intelligence_api.dart';
// ONE MODEL FOR THE GRANT ROW, and it lives on the screen-time surface — see
// `ScreenTimeGrant`'s own header for why there is no longer a second one here.
import '../../screen_time/domain/screen_time_policy.dart';
import '../api/reward_programs_api.dart';
import '../domain/achievement.dart';
import '../domain/fulfilment.dart';
import '../domain/program_catalogue.dart';
import '../domain/reward_program.dart';

/// THE DATA LAYER BOUNDARY.
///
/// Two jobs, both of which stop leaking upward:
///   1. JSON → domain types. Above this line nothing touches a
///      `Map<String, dynamic>` that came off a socket.
///   2. [ApiException] → [ApiFailure]. Above this line nothing imports the
///      network layer, so no controller and no widget can accidentally
///      depend on Dio or on the transport's error shape.
///
/// It holds no state and caches nothing — controllers own state.
class RewardProgramsRepository {
  RewardProgramsRepository(this._api, this._lifeIntelligence);

  final RewardProgramsApi _api;

  /// Reused, not rebuilt: the child's points balance already has a live
  /// endpoint and a live client (`/life-intelligence/rewards/:childId/account`),
  /// and F4's `POINTS` writes to that same ledger via `REWARD_TYPE_TO_LEDGER`.
  /// Adding a second balance surface would be exactly the duplicate economy
  /// audit PA-M-006 warned about.
  final LifeIntelligenceApi _lifeIntelligence;

  // --- catalogue ----------------------------------------------------------

  Future<ProgramCatalogue> loadCatalogue() =>
      _guard(() async => ProgramCatalogue.fromJson(await _api.getCatalogue()));

  Future<List<QuranSurah>> loadSurahs() => _guard(() async {
        final body = await _api.getSurahs();
        final list = body['surahs'] as List<dynamic>? ?? const [];
        return list
            .whereType<Map<String, dynamic>>()
            .map(QuranSurah.fromJson)
            .toList();
      });

  // --- programs -----------------------------------------------------------

  Future<RewardProgram> createProgram(Map<String, dynamic> body) =>
      _guard(() async => RewardProgram.fromJson(await _api.createProgram(body)));

  Future<List<RewardProgram>> listPrograms({String? childId}) => _guard(() async {
        final rows = await _api.listPrograms(childId: childId);
        return rows.whereType<Map<String, dynamic>>().map(RewardProgram.fromJson).toList();
      });

  Future<RewardProgram> getProgram(String programId) =>
      _guard(() async => RewardProgram.fromJson(await _api.getProgram(programId)));

  Future<RewardProgram> setProgramStatus(String programId, String status) => _guard(
        () async => RewardProgram.fromJson(
          await _api.updateProgram(programId, {'status': status}),
        ),
      );

  Future<RewardProgram> updateProgramRules(
    String programId, {
    int? maxPerDay,
    int? maxPerWeek,
    bool? requiresParentApproval,
    String? difficulty,
  }) =>
      _guard(() async => RewardProgram.fromJson(await _api.updateProgram(programId, {
            if (maxPerDay != null) 'maxPerDay': maxPerDay,
            if (maxPerWeek != null) 'maxPerWeek': maxPerWeek,
            if (requiresParentApproval != null) 'requiresParentApproval': requiresParentApproval,
            if (difficulty != null) 'difficulty': difficulty,
          })));

  Future<void> archiveProgram(String programId) => _guard(() => _api.archiveProgram(programId));

  // --- achievements --------------------------------------------------------

  Future<List<AchievementRequest>> listPendingAchievements() => _guard(() async {
        final rows = await _api.listPendingAchievements();
        return rows.whereType<Map<String, dynamic>>().map(AchievementRequest.fromJson).toList();
      });

  Future<List<VerificationAttempt>> listAttempts(String achievementId) => _guard(() async {
        final rows = await _api.listAttempts(achievementId);
        return rows.whereType<Map<String, dynamic>>().map(VerificationAttempt.fromJson).toList();
      });

  /// B5: the parent's read of a child's full achievement history — the
  /// truthful source for "completed goals", which had none before.
  Future<List<AchievementRequest>> listAchievementsForChild(String childId) => _guard(() async {
        final rows = await _api.listAchievementsForChild(childId);
        return rows.whereType<Map<String, dynamic>>().map(AchievementRequest.fromJson).toList();
      });

  /// B5: `{attempts, evidence}` in one call.
  Future<AchievementDetail> getAchievementDetail(String achievementId) =>
      _guard(() async => AchievementDetail.fromJson(await _api.getAchievementDetail(achievementId)));

  /// B5: the same five streak buckets the child sees, now readable by the
  /// person who pays for the subscription.
  Future<Map<String, int>> getStreaks(String childId) => _guard(() async {
        final body = await _api.getStreaks(childId);
        return {
          for (final entry in body.entries)
            entry.key: (entry.value as num?)?.toInt() ?? 0,
        };
      });

  Future<AchievementRequest> approve(String achievementId, {String? note}) => _guard(
        () async => AchievementRequest.fromJson(
          await _api.approveAchievement(achievementId, note: note),
        ),
      );

  Future<AchievementRequest> reject(String achievementId, {String? note}) => _guard(
        () async => AchievementRequest.fromJson(
          await _api.rejectAchievement(achievementId, note: note),
        ),
      );

  // --- fulfilment ----------------------------------------------------------

  Future<List<RewardFulfilment>> listFulfilments({String? status}) => _guard(() async {
        final rows = await _api.listFulfilments(status: status);
        return rows.whereType<Map<String, dynamic>>().map(RewardFulfilment.fromJson).toList();
      });

  Future<RewardFulfilment> moveFulfilment(String id, {required String to, String? note}) => _guard(
        () async => RewardFulfilment.fromJson(
          await _api.transitionFulfilment(id, to: to, note: note),
        ),
      );

  // --- screen-time grants --------------------------------------------------

  Future<List<ScreenTimeGrant>> listScreenTimeGrants(String childId) => _guard(() async {
        final rows = await _api.listScreenTimeGrants(childId);
        return rows.whereType<Map<String, dynamic>>().map(ScreenTimeGrant.fromJson).toList();
      });

  Future<void> revokeScreenTimeGrant(String grantId) =>
      _guard(() => _api.revokeScreenTimeGrant(grantId));

  // --- suggestions (advisory) ----------------------------------------------

  Future<List<ProgramSuggestion>> listSuggestions(String childId) => _guard(() async {
        final rows = await _api.getSuggestions(childId);
        return rows.whereType<Map<String, dynamic>>().map(ProgramSuggestion.fromJson).toList();
      });

  Future<RewardProgram> acceptSuggestion({
    required String childId,
    required String suggestionId,
  }) =>
      _guard(() async => RewardProgram.fromJson(
            await _api.acceptSuggestion(childId: childId, suggestionId: suggestionId),
          ));

  // --- points (reused endpoint) --------------------------------------------

  Future<RewardsAccount> loadAccount(String childId) => _guard(() async =>
      RewardsAccount.fromJson(await _lifeIntelligence.getRewardsAccount(childId)));

  /// The ONE place [ApiException] is converted. Every public method above
  /// goes through it, which is what makes "presentation never sees a
  /// transport error" a property of this file rather than a convention.
  Future<T> _guard<T>(Future<T> Function() call) async {
    try {
      return await call();
    } on ApiException catch (e) {
      throw ApiFailure.from(e);
    }
  }
}
