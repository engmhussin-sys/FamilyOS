import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/reward_programs_repository.dart';
import '../domain/achievement.dart';
import '../domain/fulfilment.dart';

/// What one child has EARNED, assembled from three real endpoints.
class ChildRewardsSnapshot {
  const ChildRewardsSnapshot({
    required this.account,
    required this.grants,
    required this.fulfilments,
    this.achievements = const [],
    this.streaks = const {},
  });

  /// From the pre-existing ledger endpoint. `xp` IS the product's «نقطة»
  /// (`REWARD_TYPE_TO_LEDGER: POINTS -> XP`) — one number, not two.
  final RewardsAccount? account;

  final List<ScreenTimeGrant> grants;

  /// Every fulfilment row this child produced. A fulfilment only exists
  /// because an achievement was VERIFIED, which is what makes this list a
  /// truthful "completed goals" record even though no
  /// `GET /achievements?status=VERIFIED` route exists yet.
  final List<RewardFulfilment> fulfilments;

  /// B5: the child's full achievement history, from the parent route that
  /// did not exist when B6's first pass was written. THIS is the truthful
  /// "completed goals" source — the earlier version had to infer it from
  /// fulfilment rows, which only exist for fulfillable reward types.
  final List<AchievementRequest> achievements;

  /// B5: the same five buckets the child sees.
  final Map<String, int> streaks;

  List<AchievementRequest> get verifiedAchievements =>
      achievements.where((a) => a.isVerified).toList();

  int activeBonusMinutes(DateTime now) => grants
      .where((g) => g.isActiveAt(now))
      .fold<int>(0, (sum, g) => sum + g.minutes);

  bool get isEmpty =>
      account == null && grants.isEmpty && fulfilments.isEmpty && achievements.isEmpty;
}

class ChildRewardsState {
  const ChildRewardsState({
    this.snapshot = const UiState<ChildRewardsSnapshot>.loading(),
    this.busyGrantId,
    this.actionFailure,
    this.revoked = false,
  });

  final UiState<ChildRewardsSnapshot> snapshot;
  final String? busyGrantId;
  final ApiFailure? actionFailure;
  final bool revoked;

  ChildRewardsState copyWith({
    UiState<ChildRewardsSnapshot>? snapshot,
    String? busyGrantId,
    bool clearBusy = false,
    ApiFailure? actionFailure,
    bool clearFailure = false,
    bool? revoked,
  }) =>
      ChildRewardsState(
        snapshot: snapshot ?? this.snapshot,
        busyGrantId: clearBusy ? null : (busyGrantId ?? this.busyGrantId),
        actionFailure: clearFailure ? null : (actionFailure ?? this.actionFailure),
        revoked: revoked ?? this.revoked,
      );
}

/// PARTIAL-FAILURE DISCIPLINE, the same one `dashboard_home_screen.dart`
/// already applies: the three sources are fetched independently and one
/// failing does not blank the other two. Only a failure of ALL THREE is an
/// error state — anything else is data with a hole in it, which is the
/// truthful rendering.
class ChildRewardsController extends StateNotifier<ChildRewardsState> {
  ChildRewardsController(this._repository, this.childId) : super(const ChildRewardsState()) {
    load();
  }

  final RewardProgramsRepository _repository;
  final String childId;

  Future<void> load() async {
    state = state.copyWith(
      snapshot: const UiState<ChildRewardsSnapshot>.loading(),
      clearFailure: true,
    );

    RewardsAccount? account;
    ApiFailure? accountFailure;
    try {
      account = await _repository.loadAccount(childId);
    } on ApiFailure catch (f) {
      accountFailure = f;
    }

    List<ScreenTimeGrant> grants = const [];
    ApiFailure? grantsFailure;
    try {
      grants = await _repository.listScreenTimeGrants(childId);
    } on ApiFailure catch (f) {
      grantsFailure = f;
    }

    List<RewardFulfilment> fulfilments = const [];
    ApiFailure? fulfilmentsFailure;
    try {
      final all = await _repository.listFulfilments();
      fulfilments = all.where((f) => f.childId == childId).toList();
    } on ApiFailure catch (f) {
      fulfilmentsFailure = f;
    }

    List<AchievementRequest> achievements = const [];
    ApiFailure? achievementsFailure;
    try {
      achievements = await _repository.listAchievementsForChild(childId);
    } on ApiFailure catch (f) {
      achievementsFailure = f;
    }

    Map<String, int> streaks = const {};
    try {
      streaks = await _repository.getStreaks(childId);
    } on ApiFailure catch (_) {
      // Best-effort; streaks are a nice-to-have next to the ledger.
    }

    if (accountFailure != null &&
        grantsFailure != null &&
        fulfilmentsFailure != null &&
        achievementsFailure != null) {
      state = state.copyWith(snapshot: UiState<ChildRewardsSnapshot>.error(accountFailure));
      return;
    }

    final snapshot = ChildRewardsSnapshot(
      account: account,
      grants: grants,
      fulfilments: fulfilments,
      achievements: achievements,
      streaks: streaks,
    );
    state = state.copyWith(
      snapshot: snapshot.isEmpty
          ? const UiState<ChildRewardsSnapshot>.empty()
          : UiState<ChildRewardsSnapshot>.data(snapshot),
    );
  }

  /// Revoking a screen-time grant does NOT touch the ledger row that paid
  /// for it — the reward was earned and stays earned. It withdraws the
  /// bonus minutes only, which is why the confirmation copy says «سحب
  /// المنحة» and not «إلغاء المكافأة».
  Future<void> revokeGrant(String grantId) async {
    if (state.busyGrantId != null) return;
    state = state.copyWith(busyGrantId: grantId, clearFailure: true);
    try {
      await _repository.revokeScreenTimeGrant(grantId);
      state = state.copyWith(clearBusy: true, revoked: true);
      await load();
    } on ApiFailure catch (failure) {
      state = state.copyWith(clearBusy: true, actionFailure: failure);
    }
  }

  void clearFailure() => state = state.copyWith(clearFailure: true);
}
