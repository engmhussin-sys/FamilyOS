import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/screen_time_repository.dart';
import '../domain/screen_time_policy.dart';

/// THE TWO ANSWERS, SIDE BY SIDE.
///
/// [configured] is what the parent SET. [effective] is what the child's device
/// ENFORCES today — the same limit plus whatever bonus minutes were earned and
/// not used up. Keeping them as two fields rather than one is the whole point
/// of this screen: a single «today: 150 دقيقة» would silently attribute the
/// child's earned reward to the parent's setting, and a parent who then edits
/// the policy would be surprised by the number that comes back.
class ScreenTimeOverview {
  const ScreenTimeOverview({
    required this.effective,
    this.configured,
    this.configuredFailed = false,
  });

  /// From `GET /children/:childId/screen-time-policy`. `null` means the family
  /// has never set one — an answer, not a failure.
  final ScreenTimePolicy? configured;

  /// From `GET /children/:childId/screen-time-policy/effective`.
  final EffectiveScreenTimePolicy effective;

  /// The dedicated policy read failed while the effective read succeeded. The
  /// screen then falls back to the policy EMBEDDED in the effective response
  /// (the same row, from the same table) and says nothing false; this flag
  /// exists so it does not silently claim «no policy set» when the truth is
  /// «we could not read it».
  final bool configuredFailed;

  /// Prefers the dedicated read, falls back to the copy the effective response
  /// carries. Both are `ScreenTimePolicy` off the same row.
  ScreenTimePolicy? get policy => configured ?? effective.policy;

  /// NOTHING HAS EVER BEEN SET UP — no policy row, and no earned bonus either.
  /// Distinct from a failed load, which is why it is computed here and not
  /// from an empty-looking widget tree.
  bool get isEmpty => policy == null && !effective.hasBonus && !configuredFailed;
}

/// PARTIAL-FAILURE DISCIPLINE, the same one `ChildRewardsController` applies:
/// the two reads are independent and one failing does not blank the other.
/// Only a failure of the EFFECTIVE read is an error state — it is the number
/// the screen is for, and it carries a copy of the configured policy anyway,
/// so losing the configured read alone costs nothing a parent can see.
class ScreenTimeOverviewController extends StateNotifier<UiState<ScreenTimeOverview>> {
  ScreenTimeOverviewController(this._repository, this.childId)
      : super(const UiState<ScreenTimeOverview>.loading()) {
    load();
  }

  final ScreenTimeRepository _repository;
  final String childId;

  Future<void> load() async {
    state = const UiState<ScreenTimeOverview>.loading();

    ScreenTimePolicy? configured;
    bool configuredFailed = false;
    try {
      configured = await _repository.getPolicy(childId);
    } on ApiFailure catch (_) {
      configuredFailed = true;
    }

    EffectiveScreenTimePolicy effective;
    try {
      effective = await _repository.getEffectivePolicy(childId);
    } on ApiFailure catch (failure) {
      state = UiState<ScreenTimeOverview>.error(failure);
      return;
    }

    final overview = ScreenTimeOverview(
      configured: configured,
      effective: effective,
      configuredFailed: configuredFailed,
    );
    state = overview.isEmpty
        ? const UiState<ScreenTimeOverview>.empty()
        : UiState<ScreenTimeOverview>.data(overview);
  }
}
