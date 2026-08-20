import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/reward_programs_repository.dart';
import '../domain/achievement.dart';
import '../domain/reward_program.dart';

class SuggestionsState {
  const SuggestionsState({
    this.items = const UiState<List<ProgramSuggestion>>.loading(),
    this.busyId,
    this.actionFailure,
    this.accepted,
  });

  final UiState<List<ProgramSuggestion>> items;
  final String? busyId;
  final ApiFailure? actionFailure;

  /// The program the parent's explicit accept created. Non-null is the ONLY
  /// evidence anything was created from AI output.
  final RewardProgram? accepted;

  SuggestionsState copyWith({
    UiState<List<ProgramSuggestion>>? items,
    String? busyId,
    bool clearBusy = false,
    ApiFailure? actionFailure,
    bool clearFailure = false,
    RewardProgram? accepted,
    bool clearAccepted = false,
  }) =>
      SuggestionsState(
        items: items ?? this.items,
        busyId: clearBusy ? null : (busyId ?? this.busyId),
        actionFailure: clearFailure ? null : (actionFailure ?? this.actionFailure),
        accepted: clearAccepted ? null : (accepted ?? this.accepted),
      );
}

/// AI SUGGESTIONS — ADVISORY ONLY (CONTEXT §3 principle 2).
///
/// [load] fetches DRAFTS and creates nothing. [accept] is the only method
/// that can produce a row, it takes an explicit tap, and it sends only the
/// `suggestionId` — the server re-derives the draft from
/// `(childId, suggestionId)` rather than trusting a body, so a client
/// cannot post a "suggestion" the AI never made.
class SuggestionsController extends StateNotifier<SuggestionsState> {
  SuggestionsController(this._repository, this.childId) : super(const SuggestionsState()) {
    load();
  }

  final RewardProgramsRepository _repository;
  final String childId;

  Future<void> load() async {
    state = state.copyWith(
      items: const UiState<List<ProgramSuggestion>>.loading(),
      clearFailure: true,
      clearAccepted: true,
    );
    try {
      state = state.copyWith(items: UiState.fromList(await _repository.listSuggestions(childId)));
    } on ApiFailure catch (failure) {
      state = state.copyWith(items: UiState<List<ProgramSuggestion>>.error(failure));
    }
  }

  Future<void> accept(String suggestionId) async {
    if (state.busyId != null) return;
    state = state.copyWith(busyId: suggestionId, clearFailure: true);
    try {
      final program = await _repository.acceptSuggestion(
        childId: childId,
        suggestionId: suggestionId,
      );
      state = state.copyWith(clearBusy: true, accepted: program);
    } on ApiFailure catch (failure) {
      state = state.copyWith(clearBusy: true, actionFailure: failure);
    }
  }

  void clearFailure() => state = state.copyWith(clearFailure: true);

  void clearAccepted() => state = state.copyWith(clearAccepted: true);
}
