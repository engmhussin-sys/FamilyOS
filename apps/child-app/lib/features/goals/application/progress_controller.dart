import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/achievements_repository.dart';
import '../domain/child_quiz.dart';
import '../domain/child_rewards.dart';

/// «تقدّمي» — points, level, the five streaks and the earned badges, in one
/// snapshot assembled from three independent endpoints.
class ProgressSnapshot {
  const ProgressSnapshot({
    required this.account,
    required this.streaks,
    this.badges = const [],
  });

  final ChildAccount? account;
  final StreakSet? streaks;

  /// `GET /self/achievements/badges`. Audit C10 marked this ⛔ — the awards
  /// were written server-side and no client could read one. B5 added the
  /// route; this is the client half.
  final List<ChildBadge> badges;

  bool get isEmpty =>
      account == null && (streaks == null || streaks!.isEmpty) && badges.isEmpty;
}

class ProgressController extends StateNotifier<UiState<ProgressSnapshot>> {
  ProgressController(this._repository) : super(const UiState.loading()) {
    load();
  }

  final ChildAchievementsRepository _repository;

  /// PARTIAL FAILURE IS NOT TOTAL FAILURE. Points and streaks come from two
  /// different modules; one being down must not blank the other. Only both
  /// failing is an error state — and even then the child sees a warm
  /// "let's try again", not a stack of red.
  Future<void> load() async {
    state = const UiState.loading();

    ChildAccount? account;
    ApiFailure? accountFailure;
    try {
      account = await _repository.account();
    } on ApiFailure catch (f) {
      accountFailure = f;
    }

    StreakSet? streaks;
    ApiFailure? streakFailure;
    try {
      streaks = await _repository.streaks();
    } on ApiFailure catch (f) {
      streakFailure = f;
    }

    List<ChildBadge> badges = const [];
    ApiFailure? badgeFailure;
    try {
      badges = await _repository.badges();
    } on ApiFailure catch (f) {
      badgeFailure = f;
    }

    if (accountFailure != null && streakFailure != null && badgeFailure != null) {
      state = UiState<ProgressSnapshot>.error(accountFailure);
      return;
    }

    final snapshot = ProgressSnapshot(account: account, streaks: streaks, badges: badges);
    state = snapshot.isEmpty
        ? const UiState<ProgressSnapshot>.empty()
        : UiState<ProgressSnapshot>.data(snapshot);
  }
}

/// «جوايزي» — `GET /self/achievements/rewards`.
class ChildRewardsController extends StateNotifier<UiState<ChildRewardsSnapshot>> {
  ChildRewardsController(this._repository) : super(const UiState.loading()) {
    load();
  }

  final ChildAchievementsRepository _repository;

  Future<void> load() async {
    state = const UiState.loading();
    try {
      final snapshot = await _repository.rewards();
      state = snapshot.isEmpty
          ? const UiState<ChildRewardsSnapshot>.empty()
          : UiState<ChildRewardsSnapshot>.data(snapshot);
    } on ApiFailure catch (failure) {
      state = UiState<ChildRewardsSnapshot>.error(failure);
    }
  }
}
