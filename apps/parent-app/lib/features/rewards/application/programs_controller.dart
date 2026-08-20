import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/reward_programs_repository.dart';
import '../domain/reward_program.dart';

/// The assigned-goals list. `childId == null` = the whole family.
class ProgramsController extends StateNotifier<UiState<List<RewardProgram>>> {
  ProgramsController(this._repository, this.childId) : super(const UiState.loading()) {
    load();
  }

  final RewardProgramsRepository _repository;
  final String? childId;

  Future<void> load() async {
    state = const UiState.loading();
    try {
      state = UiState.fromList(await _repository.listPrograms(childId: childId));
    } on ApiFailure catch (failure) {
      state = UiState<List<RewardProgram>>.error(failure);
    }
  }
}

/// A single program plus the in-flight state of the three lifecycle
/// actions (pause / resume / archive).
class ProgramDetailState {
  const ProgramDetailState({
    this.program = const UiState<RewardProgram>.loading(),
    this.busy = false,
    this.actionFailure,
    this.archived = false,
  });

  final UiState<RewardProgram> program;
  final bool busy;

  /// A FAILED ACTION MUST NOT DESTROY THE LOADED PROGRAM. Kept beside the
  /// data rather than replacing it, so a failed pause shows a banner over
  /// a still-readable screen instead of an error page.
  final ApiFailure? actionFailure;

  final bool archived;

  ProgramDetailState copyWith({
    UiState<RewardProgram>? program,
    bool? busy,
    ApiFailure? actionFailure,
    bool clearActionFailure = false,
    bool? archived,
  }) =>
      ProgramDetailState(
        program: program ?? this.program,
        busy: busy ?? this.busy,
        actionFailure: clearActionFailure ? null : (actionFailure ?? this.actionFailure),
        archived: archived ?? this.archived,
      );
}

class ProgramDetailController extends StateNotifier<ProgramDetailState> {
  ProgramDetailController(this._repository, this.programId) : super(const ProgramDetailState()) {
    load();
  }

  final RewardProgramsRepository _repository;
  final String programId;

  Future<void> load() async {
    state = state.copyWith(program: const UiState<RewardProgram>.loading());
    try {
      final program = await _repository.getProgram(programId);
      state = state.copyWith(program: UiState<RewardProgram>.data(program));
    } on ApiFailure catch (failure) {
      state = state.copyWith(program: UiState<RewardProgram>.error(failure));
    }
  }

  Future<void> pause() => _setStatus(ProgramStatuses.paused);

  Future<void> resume() => _setStatus(ProgramStatuses.active);

  Future<void> _setStatus(String status) async {
    if (state.busy) return;
    state = state.copyWith(busy: true, clearActionFailure: true);
    try {
      final updated = await _repository.setProgramStatus(programId, status);
      state = state.copyWith(busy: false, program: UiState<RewardProgram>.data(updated));
    } on ApiFailure catch (failure) {
      state = state.copyWith(busy: false, actionFailure: failure);
    }
  }

  /// ARCHIVE — never a hard delete. History and the ledger rows a program
  /// produced stay exactly where they are.
  Future<void> archive() async {
    if (state.busy) return;
    state = state.copyWith(busy: true, clearActionFailure: true);
    try {
      await _repository.archiveProgram(programId);
      state = state.copyWith(busy: false, archived: true);
    } on ApiFailure catch (failure) {
      state = state.copyWith(busy: false, actionFailure: failure);
    }
  }

  Future<void> updateRules({
    int? maxPerDay,
    int? maxPerWeek,
    bool? requiresParentApproval,
    String? difficulty,
  }) async {
    if (state.busy) return;
    state = state.copyWith(busy: true, clearActionFailure: true);
    try {
      final updated = await _repository.updateProgramRules(
        programId,
        maxPerDay: maxPerDay,
        maxPerWeek: maxPerWeek,
        requiresParentApproval: requiresParentApproval,
        difficulty: difficulty,
      );
      state = state.copyWith(busy: false, program: UiState<RewardProgram>.data(updated));
    } on ApiFailure catch (failure) {
      state = state.copyWith(busy: false, actionFailure: failure);
    }
  }

  void clearActionFailure() => state = state.copyWith(clearActionFailure: true);
}
