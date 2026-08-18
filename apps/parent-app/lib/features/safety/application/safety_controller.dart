import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/safety_repository.dart';
import '../domain/safety_event.dart';

/// THE SAFETY SCREEN'S STATE — the four cases of [UiState] for the events, plus
/// one decoration map that is allowed to be missing.
class SafetyState {
  const SafetyState({
    this.events = const UiState<List<SafetyEvent>>.loading(),
    this.childNames = const <String, String>{},
  });

  final UiState<List<SafetyEvent>> events;

  /// `childId -> firstName`. EMPTY IS A LEGITIMATE VALUE, not an error: it
  /// means the names could not be fetched, and an alert without a name beside
  /// it is still a true alert. Nothing on the screen branches on «is this map
  /// complete» — each card asks for its own child and renders the name only if
  /// one came back.
  final Map<String, String> childNames;

  SafetyState copyWith({
    UiState<List<SafetyEvent>>? events,
    Map<String, String>? childNames,
  }) =>
      SafetyState(
        events: events ?? this.events,
        childNames: childNames ?? this.childNames,
      );
}

/// TWO FETCHES, ONE OF WHICH IS ALLOWED TO FAIL.
///
/// The discipline is `dashboard_home_screen.dart`'s and it is stated there:
/// «one section's failure never blocks another». The events ARE the screen, so
/// their failure is the screen's error state and carries the server's own
/// Arabic sentence. The child names are decoration, so their failure is
/// swallowed after the boundary has already logged it — a parent must not be
/// told «something went wrong» about a protection alert that arrived perfectly
/// well, merely because a second call for a display name did not.
///
/// NO TIMERS, NO POLLING. A safety surface that refreshed itself on a timer
/// would need that timer cancelled in `dispose()`, and it would also mean the
/// list silently changing under a parent who is reading it. Refresh is a
/// pull-to-refresh and a retry button, both explicit.
class SafetyController extends StateNotifier<SafetyState> {
  SafetyController(this._repository) : super(const SafetyState()) {
    load();
  }

  final SafetyRepository _repository;

  Future<void> load() async {
    state = state.copyWith(events: const UiState<List<SafetyEvent>>.loading());
    try {
      final events = await _repository.listSafetyEvents();
      if (!mounted) return;
      state = state.copyWith(events: UiState.fromList(events));
    } on ApiFailure catch (failure) {
      if (!mounted) return;
      state = state.copyWith(events: UiState<List<SafetyEvent>>.error(failure));
    }
    await _loadChildNames();
  }

  Future<void> _loadChildNames() async {
    try {
      final names = await _repository.childNamesById();
      if (!mounted) return;
      state = state.copyWith(childNames: names);
    } on ApiFailure catch (_) {
      // Already recorded by the repository's FailureBoundary, with the original
      // exception and its stack. Nothing is shown: the alerts above are what
      // this screen is for, and they are already on screen.
    }
  }
}
