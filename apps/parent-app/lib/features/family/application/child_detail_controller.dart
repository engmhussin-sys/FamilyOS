import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/child_profile_repository.dart';

/// ONE CHILD, IN THE FOUR STATES.
///
/// `empty` is deliberately UNREACHABLE here and that is a statement rather than
/// an oversight: `GET /children/:childId` either returns a child or answers
/// 404, so «loaded, and there is nothing» is not a case this route can produce.
/// [UiState] still requires the branch to be handled, and the screen handles it
/// with the same honest copy as a missing child — which is the correct answer
/// if the server ever starts returning a body this build reads as nothing.
class ChildDetailController extends StateNotifier<UiState<ChildProfile>> {
  ChildDetailController(this._repository, this._childId)
      : super(const UiState<ChildProfile>.loading()) {
    load();
  }

  final ChildProfileRepository _repository;
  final String _childId;

  Future<void> load() async {
    state = const UiState<ChildProfile>.loading();
    try {
      final profile = await _repository.getChild(_childId);
      if (!mounted) return;
      state = UiState<ChildProfile>.data(profile);
    } on ApiFailure catch (failure) {
      if (!mounted) return;
      state = UiState<ChildProfile>.error(failure);
    }
  }
}
