import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/screen_time_repository.dart';
import '../domain/screen_time_policy.dart';

/// A CLIENT-SIDE VIOLATION OF A BOUND THE DTO ACTUALLY DECLARES.
///
/// One member per real `SetScreenTimePolicyDto` constraint and NOT ONE MORE.
/// An enum rather than a message string because the message is the SCREEN's to
/// resolve through `t('...')` with a literal key — a controller that stored the
/// localisation key would put it beyond `verify_l10n_parity.py`, which only
/// sees literal `t('…')` call sites.
///
/// Mirroring these does not move the decision: the server still validates and
/// still explains itself in Arabic through the B3 envelope. It only means the
/// common typo is answered in the parent's own language without a round trip.
enum PolicyFormProblem {
  /// `@Min(0) @Max(1440)` on `dailyLimitMinutes`.
  dailyLimitOutOfRange,

  /// The field was typed but is not an integer at all.
  dailyLimitNotANumber,

  /// `@Matches(/^([01]\d|2[0-3]):([0-5]\d)$/)` on `bedtimeStart`.
  bedtimeStartFormat,

  /// The same pattern on `bedtimeEnd`.
  bedtimeEndFormat,
}

class PolicyEditorState {
  const PolicyEditorState({
    this.initial = const UiState<ScreenTimePolicy?>.loading(),
    this.dailyLimitText = '',
    this.bedtimeStart = '',
    this.bedtimeEnd = '',
    this.focusModeEnabled = false,
    this.hadWeekdaySchedule = false,
    this.busy = false,
    this.saveFailure,
    this.saved = false,
  });

  /// The policy the form was seeded from. `UiState` because the seed is itself
  /// a network read that can be loading, absent (`data(null)` — a family that
  /// has never set one, which is a legitimate starting point for a NEW policy)
  /// or failed.
  final UiState<ScreenTimePolicy?> initial;

  /// Kept as TEXT, not `int?`. A half-typed «14» must not be indistinguishable
  /// from «the parent cleared the field», and only the raw text can tell those
  /// apart.
  final String dailyLimitText;

  final String bedtimeStart;
  final String bedtimeEnd;
  final bool focusModeEnabled;

  /// The policy being replaced carried per-weekday overrides. `POST` REPLACES
  /// the row (the server soft-deletes the old one and creates a new one from
  /// exactly what arrives), and this app sends no `weekdaySchedule`, so saving
  /// DROPS them. The screen warns before the save rather than after it.
  final bool hadWeekdaySchedule;

  final bool busy;

  /// A FAILED SAVE MUST NOT DESTROY THE TYPED FORM. Held beside the fields
  /// rather than replacing them, so the parent sees a banner over their own
  /// input instead of an error page and a lost draft.
  final ApiFailure? saveFailure;

  final bool saved;

  /// `null` when the field is blank — «do not send `dailyLimitMinutes` at
  /// all», which the DTO treats as absent rather than as zero.
  int? get dailyLimitMinutes =>
      dailyLimitText.trim().isEmpty ? null : int.tryParse(dailyLimitText.trim());

  /// EVERY problem at once, not the first one. A parent fixing a form should
  /// see everything wrong with it in one pass — the same reason the backend's
  /// own `details.errors` is a list.
  List<PolicyFormProblem> get problems {
    final out = <PolicyFormProblem>[];
    final text = dailyLimitText.trim();
    if (text.isNotEmpty) {
      final parsed = int.tryParse(text);
      if (parsed == null) {
        out.add(PolicyFormProblem.dailyLimitNotANumber);
      } else if (!ScreenTimePolicyLimits.isValidDailyLimit(parsed)) {
        out.add(PolicyFormProblem.dailyLimitOutOfRange);
      }
    }
    if (!ScreenTimePolicyLimits.isValidTime(bedtimeStart)) {
      out.add(PolicyFormProblem.bedtimeStartFormat);
    }
    if (!ScreenTimePolicyLimits.isValidTime(bedtimeEnd)) {
      out.add(PolicyFormProblem.bedtimeEndFormat);
    }
    return out;
  }

  bool get isValid => problems.isEmpty;

  /// ONE END OF A BEDTIME WINDOW WITHOUT THE OTHER. Advisory, never blocking:
  /// the DTO accepts each independently, so refusing to send it would be this
  /// client inventing a rule the server does not have. The screen shows a note.
  bool get bedtimeIncomplete =>
      bedtimeStart.trim().isEmpty != bedtimeEnd.trim().isEmpty;

  PolicyEditorState copyWith({
    UiState<ScreenTimePolicy?>? initial,
    String? dailyLimitText,
    String? bedtimeStart,
    String? bedtimeEnd,
    bool? focusModeEnabled,
    bool? hadWeekdaySchedule,
    bool? busy,
    ApiFailure? saveFailure,
    bool clearSaveFailure = false,
    bool? saved,
  }) =>
      PolicyEditorState(
        initial: initial ?? this.initial,
        dailyLimitText: dailyLimitText ?? this.dailyLimitText,
        bedtimeStart: bedtimeStart ?? this.bedtimeStart,
        bedtimeEnd: bedtimeEnd ?? this.bedtimeEnd,
        focusModeEnabled: focusModeEnabled ?? this.focusModeEnabled,
        hadWeekdaySchedule: hadWeekdaySchedule ?? this.hadWeekdaySchedule,
        busy: busy ?? this.busy,
        saveFailure: clearSaveFailure ? null : (saveFailure ?? this.saveFailure),
        saved: saved ?? this.saved,
      );
}

class ScreenTimePolicyEditorController extends StateNotifier<PolicyEditorState> {
  ScreenTimePolicyEditorController(this._repository, this.childId)
      : super(const PolicyEditorState()) {
    load();
  }

  final ScreenTimeRepository _repository;
  final String childId;

  /// Seeds the form from the CONFIGURED policy, not the effective one. Editing
  /// against the effective allowance would let a parent silently bake their
  /// child's earned bonus into the base limit — the bonus would then be
  /// counted twice, once inside the new base and once again as a live grant.
  Future<void> load() async {
    state = state.copyWith(initial: const UiState<ScreenTimePolicy?>.loading());
    try {
      final policy = await _repository.getPolicy(childId);
      state = state.copyWith(
        initial: UiState<ScreenTimePolicy?>.data(policy),
        dailyLimitText: policy?.dailyLimitMinutes?.toString() ?? '',
        bedtimeStart: policy?.bedtimeStart ?? '',
        bedtimeEnd: policy?.bedtimeEnd ?? '',
        focusModeEnabled: policy?.focusModeEnabled ?? false,
        hadWeekdaySchedule: policy?.hasWeekdaySchedule ?? false,
      );
    } on ApiFailure catch (failure) {
      state = state.copyWith(initial: UiState<ScreenTimePolicy?>.error(failure));
    }
  }

  void setDailyLimitText(String value) =>
      state = state.copyWith(dailyLimitText: value, clearSaveFailure: true);

  void setBedtimeStart(String value) =>
      state = state.copyWith(bedtimeStart: value, clearSaveFailure: true);

  void setBedtimeEnd(String value) =>
      state = state.copyWith(bedtimeEnd: value, clearSaveFailure: true);

  void setFocusMode(bool value) =>
      state = state.copyWith(focusModeEnabled: value, clearSaveFailure: true);

  void clearSaveFailure() => state = state.copyWith(clearSaveFailure: true);

  /// Refuses to send a body the DTO would reject — the parent reads their own
  /// language instead of collecting a 400 — and otherwise lets the SERVER be
  /// the authority. A save that the server refuses lands in [state.saveFailure]
  /// with the envelope's own Arabic sentence, never a transport string.
  Future<void> save() async {
    if (state.busy || !state.isValid) return;
    state = state.copyWith(busy: true, clearSaveFailure: true);
    try {
      await _repository.setPolicy(
        childId,
        dailyLimitMinutes: state.dailyLimitMinutes,
        bedtimeStart: state.bedtimeStart,
        bedtimeEnd: state.bedtimeEnd,
        focusModeEnabled: state.focusModeEnabled,
      );
      state = state.copyWith(busy: false, saved: true);
    } on ApiFailure catch (failure) {
      state = state.copyWith(busy: false, saveFailure: failure);
    }
  }
}
