import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../data/reward_programs_repository.dart';
import '../domain/program_catalogue.dart';
import '../domain/program_draft.dart';
import '../domain/reward_program.dart';

/// The wizard's eight steps, in order. Declared as data so the header can
/// say «الخطوة ٣ من ٨» without any screen counting by hand.
enum WizardStep {
  child,
  category,
  activity,
  target,
  duration,
  verification,
  reward,
  rules,
  review,
}

/// The submit state — separate from the draft itself so a failed save does
/// not lose eight steps of the parent's input.
class ProgramSubmitState {
  const ProgramSubmitState({this.busy = false, this.failure, this.created});

  final bool busy;
  final ApiFailure? failure;
  final RewardProgram? created;

  bool get isSuccess => created != null;

  ProgramSubmitState copyWith({bool? busy, ApiFailure? failure, RewardProgram? created, bool clearFailure = false}) =>
      ProgramSubmitState(
        busy: busy ?? this.busy,
        failure: clearFailure ? null : (failure ?? this.failure),
        created: created ?? this.created,
      );
}

class ProgramWizardState {
  const ProgramWizardState({
    this.step = WizardStep.child,
    this.draft = const ProgramDraft(),
    this.submit = const ProgramSubmitState(),
  });

  final WizardStep step;
  final ProgramDraft draft;
  final ProgramSubmitState submit;

  int get stepNumber => step.index + 1;
  int get totalSteps => WizardStep.values.length;

  ProgramWizardState copyWith({
    WizardStep? step,
    ProgramDraft? draft,
    ProgramSubmitState? submit,
  }) =>
      ProgramWizardState(
        step: step ?? this.step,
        draft: draft ?? this.draft,
        submit: submit ?? this.submit,
      );
}

/// THE CREATE FLOW'S STATE MACHINE.
///
/// The flagship journey this whole phase exists for lives here:
/// «حفظ سورة الملك، الآيات ١–٥، ٢٠ دقيقة، ٢٠ نقطة» — a parent picks
/// قرآن → حفظ مجموعة آيات → الملك → 1..5 → 20 دقيقة → طريقة تحقق →
/// 20 نقطة → قواعد، and presses save. Nine taps and two numbers, with no
/// screen that looks like configuration.
class ProgramWizardController extends StateNotifier<ProgramWizardState> {
  ProgramWizardController(this._repository) : super(const ProgramWizardState());

  final RewardProgramsRepository _repository;

  // --- navigation ---------------------------------------------------------

  void goTo(WizardStep step) => state = state.copyWith(step: step);

  void next() {
    final steps = WizardStep.values;
    var index = state.step.index;
    // Skip the target step entirely when the chosen activity has no target
    // form worth showing — a GENERIC_SESSION with no quantity is a legal
    // program and making the parent look at an empty step is noise.
    while (index < steps.length - 1) {
      index++;
      if (_isRelevant(steps[index])) break;
    }
    state = state.copyWith(step: steps[index]);
  }

  void back() {
    final steps = WizardStep.values;
    var index = state.step.index;
    while (index > 0) {
      index--;
      if (_isRelevant(steps[index])) break;
    }
    state = state.copyWith(step: steps[index]);
  }

  bool _isRelevant(WizardStep step) => true;

  // --- step 0: child ------------------------------------------------------

  void setChild({String? childId, String? childName}) {
    state = state.copyWith(
      draft: childId == null
          ? state.draft.copyWith(clearChild: true)
          : state.draft.copyWith(childId: childId, childName: childName),
    );
  }

  // --- steps 1-2: category / activity -------------------------------------

  /// Changing the category CLEARS the activity. The server's
  /// `CATEGORY_ACTIVITIES` would reject the stale pair with
  /// `ACTIVITY_NOT_IN_CATEGORY`; clearing it locally means the parent never
  /// gets that far.
  void setCategory(ProgramCategory category) {
    state = state.copyWith(
      draft: state.draft.copyWith(category: category, clearActivity: true),
    );
  }

  void setActivity(ProgramActivity activity) {
    state = state.copyWith(draft: state.draft.copyWith(activity: activity));
  }

  // --- step 3: the target -------------------------------------------------

  void setSurah(QuranSurah surah) {
    var draft = state.draft.copyWith(surah: surah);
    // Clamp an already-typed range into the newly chosen surah rather than
    // leaving an invalid pair on screen.
    final from = draft.fromAyah;
    final to = draft.toAyah;
    if (from != null && from > surah.ayahCount) draft = draft.copyWith(fromAyah: surah.ayahCount);
    if (to != null && to > surah.ayahCount) draft = draft.copyWith(toAyah: surah.ayahCount);
    state = state.copyWith(draft: draft);
  }

  void setAyahRange({int? fromAyah, int? toAyah}) {
    state = state.copyWith(
      draft: state.draft.copyWith(fromAyah: fromAyah, toAyah: toAyah),
    );
  }

  void setJuz(int juzNumber) =>
      state = state.copyWith(draft: state.draft.copyWith(juzNumber: juzNumber));

  void setGenericTarget({int? quantity, String? unit, String? reference}) {
    state = state.copyWith(
      draft: state.draft.copyWith(quantity: quantity, unit: unit, reference: reference),
    );
  }

  void setIsReview(bool value) =>
      state = state.copyWith(draft: state.draft.copyWith(isReview: value));

  void setRepetitions(int? value) =>
      state = state.copyWith(draft: state.draft.copyWith(repetitions: value));

  // --- step 4: duration ---------------------------------------------------

  void setDuration(int minutes) =>
      state = state.copyWith(draft: state.draft.copyWith(durationMinutes: minutes));

  // --- step 5: verification -----------------------------------------------

  void setVerification(VerificationLevel level) =>
      state = state.copyWith(draft: state.draft.copyWith(verification: level));

  void setPassScore(int? percent) =>
      state = state.copyWith(draft: state.draft.copyWith(passScorePercent: percent));

  // --- step 6: reward -----------------------------------------------------

  void setRewardType(String type) =>
      state = state.copyWith(draft: state.draft.copyWith(rewardType: type));

  void setRewardAmount(int amount) =>
      state = state.copyWith(draft: state.draft.copyWith(rewardAmount: amount));

  void setRewardDescription(String? description) =>
      state = state.copyWith(draft: state.draft.copyWith(rewardDescription: description));

  void setScreenTimeTtl(int? hours) =>
      state = state.copyWith(draft: state.draft.copyWith(screenTimeExpiresInHours: hours));

  // --- step 7: rules ------------------------------------------------------

  void setFrequency(String frequency) =>
      state = state.copyWith(draft: state.draft.copyWith(frequency: frequency));

  void setMaxPerDay(int value) =>
      state = state.copyWith(draft: state.draft.copyWith(maxPerDay: value));

  void setMaxPerWeek(int value) =>
      state = state.copyWith(draft: state.draft.copyWith(maxPerWeek: value));

  void setMinAge(int? value) =>
      state = state.copyWith(draft: state.draft.copyWith(minAge: value));

  void setDifficulty(String value) =>
      state = state.copyWith(draft: state.draft.copyWith(difficulty: value));

  void setRequiresParentApproval(bool value) =>
      state = state.copyWith(draft: state.draft.copyWith(requiresParentApproval: value));

  void setExpiresAt(DateTime? value) =>
      state = state.copyWith(draft: state.draft.copyWith(expiresAt: value));

  void setStreakMultiplierBps(int? value) =>
      state = state.copyWith(draft: state.draft.copyWith(streakMultiplierBps: value));

  // --- submit -------------------------------------------------------------

  /// Sends the draft. On failure the DRAFT IS KEPT — the eight steps of
  /// input survive a 400, and `submit.failure` carries the server's Arabic
  /// sentence plus any per-field `details.errors` for the review screen to
  /// render inline.
  Future<void> submit() async {
    if (state.submit.busy) return;
    state = state.copyWith(submit: const ProgramSubmitState(busy: true));
    try {
      final created = await _repository.createProgram(state.draft.toCreateBody());
      state = state.copyWith(submit: ProgramSubmitState(created: created));
    } on ApiFailure catch (failure) {
      state = state.copyWith(submit: ProgramSubmitState(failure: failure));
    }
  }

  void clearSubmitFailure() =>
      state = state.copyWith(submit: state.submit.copyWith(clearFailure: true, busy: false));

  void reset() => state = const ProgramWizardState();
}
