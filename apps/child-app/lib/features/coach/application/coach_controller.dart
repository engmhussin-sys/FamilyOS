import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../../../core/state/ui_state.dart';
import '../data/coach_repository.dart';
import '../domain/coach_models.dart';

/// What the coach tab shows once its first load succeeds: today's card and
/// the closed question list. Both come from the server; neither is derived
/// on the device.
class CoachHome {
  const CoachHome({required this.encouragement, required this.topics});

  final ChildEncouragement encouragement;
  final List<CoachTopic> topics;

  CoachHome copyWith({ChildEncouragement? encouragement}) => CoachHome(
        encouragement: encouragement ?? this.encouragement,
        topics: topics,
      );
}

/// THE COACH TAB'S STATE.
///
/// The initial fetch is a normal four-state [UiState]. Everything a child can
/// do afterwards — open a question, send a check-in — is tracked separately,
/// so a failed answer never blanks the card the child is already reading.
class CoachState {
  const CoachState({
    required this.home,
    this.openTopicCode,
    this.answers = const {},
    this.answerLoadingCode,
    this.answerFailure,
    this.safetyCard,
    this.checkinSubmitting = false,
    this.checkinFailure,
  });

  const CoachState.loading() : this(home: const UiState<CoachHome>.loading());

  final UiState<CoachHome> home;

  /// The question currently expanded, or `null` when the list is collapsed.
  /// Exactly one may be open — a child reading two answers at once is a
  /// child reading neither.
  final String? openTopicCode;

  /// Answers already fetched, keyed by topic code. Cached because the server
  /// answer for a (code, band) pair is a table lookup that cannot change
  /// while the screen is open, and a child re-tapping a question should not
  /// re-hit a throttled endpoint.
  final Map<String, CoachAnswer> answers;

  final String? answerLoadingCode;
  final ApiFailure? answerFailure;

  /// Non-null only after an escalated check-in. Never derived on the device.
  final DistressCard? safetyCard;

  final bool checkinSubmitting;
  final ApiFailure? checkinFailure;

  CoachState copyWith({
    UiState<CoachHome>? home,
    String? openTopicCode,
    bool clearOpenTopic = false,
    Map<String, CoachAnswer>? answers,
    String? answerLoadingCode,
    bool clearAnswerLoading = false,
    ApiFailure? answerFailure,
    bool clearAnswerFailure = false,
    DistressCard? safetyCard,
    bool clearSafetyCard = false,
    bool? checkinSubmitting,
    ApiFailure? checkinFailure,
    bool clearCheckinFailure = false,
  }) {
    return CoachState(
      home: home ?? this.home,
      openTopicCode: clearOpenTopic ? null : (openTopicCode ?? this.openTopicCode),
      answers: answers ?? this.answers,
      answerLoadingCode: clearAnswerLoading ? null : (answerLoadingCode ?? this.answerLoadingCode),
      answerFailure: clearAnswerFailure ? null : (answerFailure ?? this.answerFailure),
      safetyCard: clearSafetyCard ? null : (safetyCard ?? this.safetyCard),
      checkinSubmitting: checkinSubmitting ?? this.checkinSubmitting,
      checkinFailure: clearCheckinFailure ? null : (checkinFailure ?? this.checkinFailure),
    );
  }
}

/// THE COACH CONTROLLER.
///
/// Note what is NOT here: no message list, no conversation history, no
/// composer that sends arbitrary text to an answer endpoint. That is not an
/// omission to be filled in later — the product decision is that this app has
/// no open-ended child chat, and the server enforces it at the route layer
/// (`GET answer/:topicCode` validates against a nine-value enum). This class
/// is shaped to match, so a future "just add a text field" change has to
/// argue with the backend rather than slip past this file.
class CoachController extends StateNotifier<CoachState> {
  CoachController(this._repository) : super(const CoachState.loading()) {
    load();
  }

  final ChildCoachRepository _repository;

  /// The 500-character ceiling on the check-in field, matching
  /// `ChildCheckinDto`'s `@Length(1, 500)`. Enforced in the UI so a child
  /// meets a counter instead of a rejected request.
  static const int checkinMaxLength = 500;

  Future<void> load() async {
    state = const CoachState.loading();
    try {
      // Both are independent reads; fetching them in parallel keeps the tab
      // to one round-trip's latency rather than two.
      final results = await Future.wait([
        _repository.today(),
        _repository.topics(),
      ]);
      final encouragement = results[0] as ChildEncouragement;
      final topics = results[1] as List<CoachTopic>;

      if (encouragement.isEmpty && topics.isEmpty) {
        state = const CoachState(home: UiState<CoachHome>.empty());
        return;
      }
      state = CoachState(
        home: UiState<CoachHome>.data(
          CoachHome(encouragement: encouragement, topics: topics),
        ),
      );
    } on ApiFailure catch (failure) {
      state = CoachState(home: UiState<CoachHome>.error(failure));
    }
  }

  /// Tapping a question. Tapping the OPEN one closes it.
  Future<void> openTopic(String code) async {
    if (state.openTopicCode == code) {
      state = state.copyWith(clearOpenTopic: true, clearAnswerFailure: true);
      return;
    }
    if (state.answers.containsKey(code)) {
      state = state.copyWith(openTopicCode: code, clearAnswerFailure: true);
      return;
    }

    state = state.copyWith(
      openTopicCode: code,
      answerLoadingCode: code,
      clearAnswerFailure: true,
    );
    try {
      final answer = await _repository.answer(code);
      state = state.copyWith(
        answers: {...state.answers, code: answer},
        clearAnswerLoading: true,
      );
    } on ApiFailure catch (failure) {
      state = state.copyWith(clearAnswerLoading: true, answerFailure: failure);
    }
  }

  /// «كيف تشعر اليوم؟».
  ///
  /// THE BRANCH BELOW IS THE SAFETY CONTRACT AND IT IS INTENTIONALLY BLAND.
  /// On `escalated: false` this replaces the encouragement card with the one
  /// the server returned and does nothing else — no confirmation, no toast,
  /// no state a screen could style differently. That is what makes the
  /// classifier unobservable to the child: both branches of a check-in look
  /// like the tab looked before it, unless the child needs help.
  Future<void> submitCheckin(String feeling) async {
    final text = feeling.trim();
    if (text.isEmpty || state.checkinSubmitting) return;

    state = state.copyWith(
      checkinSubmitting: true,
      clearCheckinFailure: true,
      clearSafetyCard: true,
    );
    try {
      final outcome = await _repository.checkin(text);
      if (outcome.escalated) {
        state = state.copyWith(checkinSubmitting: false, safetyCard: outcome.card);
        return;
      }

      final encouragement = outcome.encouragement;
      final home = state.home;
      final current = home.valueOrNull;
      state = state.copyWith(
        checkinSubmitting: false,
        home: (encouragement != null && current != null)
            ? UiState<CoachHome>.data(current.copyWith(encouragement: encouragement))
            : home,
      );
    } on ApiFailure catch (failure) {
      state = state.copyWith(checkinSubmitting: false, checkinFailure: failure);
    }
  }

  /// Dismissing the safety card. Deliberately does NOT clear anything on the
  /// server: the parent alert was already written and is not the child's to
  /// withdraw.
  void dismissSafetyCard() => state = state.copyWith(clearSafetyCard: true);
}
