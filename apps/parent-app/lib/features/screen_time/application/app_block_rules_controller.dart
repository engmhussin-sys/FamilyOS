import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/screen_time_repository.dart';
import '../domain/app_block_rule.dart';

class AppBlockRulesState {
  const AppBlockRulesState({
    this.rules = const UiState<List<AppBlockRule>>.loading(),
    this.busyRuleId,
    this.creating = false,
    this.actionFailure,
    this.lastCreatedTarget,
    this.lastStoppedTarget,
  });

  final UiState<List<AppBlockRule>> rules;

  /// The rule currently being deactivated, so one row spins and the rest stay
  /// tappable.
  final String? busyRuleId;

  final bool creating;

  /// A FAILED ACTION MUST NOT DESTROY THE LOADED LIST. Kept beside the data so
  /// a failed create shows a banner over a still-readable screen — the same
  /// discipline `ProgramDetailController` applies.
  final ApiFailure? actionFailure;

  /// The package or category of the rule just added / just stopped, for the
  /// success banner. The raw identifier, rendered LTR by the screen — never
  /// translated, because it is the string the device enforces on.
  final String? lastCreatedTarget;
  final String? lastStoppedTarget;

  AppBlockRulesState copyWith({
    UiState<List<AppBlockRule>>? rules,
    String? busyRuleId,
    bool clearBusy = false,
    bool? creating,
    ApiFailure? actionFailure,
    bool clearActionFailure = false,
    String? lastCreatedTarget,
    String? lastStoppedTarget,
    bool clearBanners = false,
  }) =>
      AppBlockRulesState(
        rules: rules ?? this.rules,
        busyRuleId: clearBusy ? null : (busyRuleId ?? this.busyRuleId),
        creating: creating ?? this.creating,
        actionFailure:
            clearActionFailure ? null : (actionFailure ?? this.actionFailure),
        lastCreatedTarget:
            clearBanners ? null : (lastCreatedTarget ?? this.lastCreatedTarget),
        lastStoppedTarget:
            clearBanners ? null : (lastStoppedTarget ?? this.lastStoppedTarget),
      );
}

/// THE ACTIVE BLOCK RULES FOR ONE CHILD, AND THE TWO WRITES THAT CHANGE THEM.
///
/// `GET /children/:childId/app-block-rules` returns ACTIVE rules only, so this
/// list is «what is being enforced right now» and never a history — which is
/// why removing a rule here is called «stop», not «delete»: the server
/// deactivates the row and keeps it, together with its audit entry.
class AppBlockRulesController extends StateNotifier<AppBlockRulesState> {
  AppBlockRulesController(this._repository, this.childId)
      : super(const AppBlockRulesState()) {
    load();
  }

  final ScreenTimeRepository _repository;
  final String childId;

  Future<void> load() async {
    state = state.copyWith(
      rules: const UiState<List<AppBlockRule>>.loading(),
      clearActionFailure: true,
    );
    try {
      state = state.copyWith(
        rules: UiState.fromList(await _repository.listAppBlockRules(childId)),
      );
    } on ApiFailure catch (failure) {
      state = state.copyWith(rules: UiState<List<AppBlockRule>>.error(failure));
    }
  }

  /// Adds a rule for ONE package, chosen from the catalogue. `TIME_LIMIT`
  /// carries [limitMinutes]; the service refuses that rule type without one,
  /// so the caller supplies it and this method does not silently drop it.
  Future<void> blockPackage(
    String packageName, {
    String ruleType = AppRuleTypes.block,
    int? limitMinutes,
  }) async {
    if (state.creating) return;
    state = state.copyWith(creating: true, clearActionFailure: true, clearBanners: true);
    try {
      await _repository.blockPackage(
        childId,
        packageName: packageName,
        ruleType: ruleType,
        limitMinutes: limitMinutes,
      );
      state = state.copyWith(creating: false);
      await load();
      state = state.copyWith(lastCreatedTarget: packageName);
    } on ApiFailure catch (failure) {
      state = state.copyWith(creating: false, actionFailure: failure);
    }
  }

  /// DEACTIVATES the rule — the server flips `isActive` and keeps the row.
  /// Named for what it does, so no confirmation dialog can honestly say
  /// «delete».
  Future<void> stopRule(AppBlockRule rule) async {
    if (state.busyRuleId != null) return;
    state = state.copyWith(
      busyRuleId: rule.id,
      clearActionFailure: true,
      clearBanners: true,
    );
    try {
      await _repository.deactivateAppBlockRule(childId, rule.id);
      state = state.copyWith(clearBusy: true);
      await load();
      state = state.copyWith(lastStoppedTarget: rule.target);
    } on ApiFailure catch (failure) {
      state = state.copyWith(clearBusy: true, actionFailure: failure);
    }
  }

  void clearActionFailure() => state = state.copyWith(clearActionFailure: true);

  void clearBanners() => state = state.copyWith(clearBanners: true);
}

/// THE CATALOGUE BEHIND THE PICKER — `GET /children/:childId/apps`.
///
/// AN EMPTY LIST IS THE INTERESTING CASE, not an edge case. It means the
/// child's device has not reported an inventory yet, or no device is paired at
/// all, and a picker that shows an empty sheet without saying so is the exact
/// failure this catalogue was built to remove. [UiState.fromList] makes that a
/// first-class `empty` rather than `data(<empty list>)`, so the screen cannot
/// forget to word it.
///
/// NOTHING IS FABRICATED WHEN IT IS EMPTY. No placeholder apps, no «popular
/// apps» list — a suggestion this app invented would be a package name the
/// parent could block that their child may not even have.
class ChildAppCatalogueController extends StateNotifier<UiState<List<AppCatalogEntry>>> {
  ChildAppCatalogueController(this._repository, this.childId)
      : super(const UiState<List<AppCatalogEntry>>.loading()) {
    load();
  }

  final ScreenTimeRepository _repository;
  final String childId;

  Future<void> load() async {
    state = const UiState<List<AppCatalogEntry>>.loading();
    try {
      state = UiState.fromList(await _repository.listChildApps(childId));
    } on ApiFailure catch (failure) {
      state = UiState<List<AppCatalogEntry>>.error(failure);
    }
  }
}
