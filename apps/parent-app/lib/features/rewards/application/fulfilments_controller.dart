import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/reward_programs_repository.dart';
import '../domain/fulfilment.dart';

class FulfilmentsState {
  const FulfilmentsState({
    this.items = const UiState<List<RewardFulfilment>>.loading(),
    this.statusFilter,
    this.busyId,
    this.actionFailure,
    this.lastMovedTo,
  });

  final UiState<List<RewardFulfilment>> items;

  /// `null` = every status. The server accepts `?status=` and applies the
  /// tenant scope itself.
  final String? statusFilter;

  /// Which row is mid-transition, so only that card shows a spinner.
  final String? busyId;

  final ApiFailure? actionFailure;

  /// The status the last successful transition landed on — drives the
  /// success banner's wording.
  final String? lastMovedTo;

  FulfilmentsState copyWith({
    UiState<List<RewardFulfilment>>? items,
    String? statusFilter,
    bool clearFilter = false,
    String? busyId,
    bool clearBusy = false,
    ApiFailure? actionFailure,
    bool clearFailure = false,
    String? lastMovedTo,
    bool clearMoved = false,
  }) =>
      FulfilmentsState(
        items: items ?? this.items,
        statusFilter: clearFilter ? null : (statusFilter ?? this.statusFilter),
        busyId: clearBusy ? null : (busyId ?? this.busyId),
        actionFailure: clearFailure ? null : (actionFailure ?? this.actionFailure),
        lastMovedTo: clearMoved ? null : (lastMovedTo ?? this.lastMovedTo),
      );
}

/// THE FULFILMENT QUEUE — «سلّمتُ المكافأة».
///
/// The one product rule worth naming: a transition is only ever offered
/// when `FULFILMENT_TRANSITIONS` permits it (audit P17). The button set
/// comes from [RewardFulfilment.allowedTransitions], which is a mirror of
/// the server's table; the server's conditional UPDATE is what actually
/// decides, and a lost race returns a 400 whose `messageAr` this controller
/// surfaces unchanged.
class FulfilmentsController extends StateNotifier<FulfilmentsState> {
  FulfilmentsController(this._repository) : super(const FulfilmentsState()) {
    load();
  }

  final RewardProgramsRepository _repository;

  Future<void> load() async {
    state = state.copyWith(
      items: const UiState<List<RewardFulfilment>>.loading(),
      clearFailure: true,
    );
    try {
      final rows = await _repository.listFulfilments(status: state.statusFilter);
      state = state.copyWith(items: UiState.fromList(rows));
    } on ApiFailure catch (failure) {
      state = state.copyWith(items: UiState<List<RewardFulfilment>>.error(failure));
    }
  }

  Future<void> setFilter(String? status) async {
    state = status == null
        ? state.copyWith(clearFilter: true)
        : state.copyWith(statusFilter: status);
    await load();
  }

  Future<void> move(String fulfilmentId, String to, {String? note}) async {
    if (state.busyId != null) return;
    state = state.copyWith(busyId: fulfilmentId, clearFailure: true, clearMoved: true);
    try {
      await _repository.moveFulfilment(fulfilmentId, to: to, note: note);
      state = state.copyWith(clearBusy: true, lastMovedTo: to);
      await load();
    } on ApiFailure catch (failure) {
      state = state.copyWith(clearBusy: true, actionFailure: failure);
    }
  }

  void clearFailure() => state = state.copyWith(clearFailure: true);

  void clearMoved() => state = state.copyWith(clearMoved: true);
}
