import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/achievements_repository.dart';
import '../domain/child_achievement.dart';
import '../domain/child_goal.dart';

/// TODAY'S GOALS — the child app's first screen, as of B7.
///
/// The controller does exactly three things: fetch, hold four states, and
/// expose a refresh. It sorts available goals before unavailable ones —
/// a presentation ordering, not an eligibility decision; `available` was
/// decided by `checkProgramEligibility` on the server and is only read here.
class TodayGoalsController extends StateNotifier<UiState<List<TodayGoal>>> {
  TodayGoalsController(this._repository) : super(const UiState.loading()) {
    load();
  }

  final ChildAchievementsRepository _repository;

  Future<void> load() async {
    state = const UiState.loading();
    try {
      final goals = await _repository.today();
      // Ready-now first. A child scanning a list should not have to scroll
      // past three greyed cards to find the one they can actually do.
      final sorted = [...goals]..sort((a, b) {
          if (a.available == b.available) return 0;
          return a.available ? -1 : 1;
        });
      state = UiState.fromList(sorted);
    } on ApiFailure catch (failure) {
      state = UiState<List<TodayGoal>>.error(failure);
    }
  }
}

/// «محاولاتي» — the child's own history, `GET /self/achievements/mine`.
class MyAttemptsController extends StateNotifier<UiState<List<MyAttempt>>> {
  MyAttemptsController(this._repository) : super(const UiState.loading()) {
    load();
  }

  final ChildAchievementsRepository _repository;

  Future<void> load() async {
    state = const UiState.loading();
    try {
      state = UiState.fromList(await _repository.mine());
    } on ApiFailure catch (failure) {
      state = UiState<List<MyAttempt>>.error(failure);
    }
  }
}
