import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../data/achievements_repository.dart';
import '../domain/child_achievement.dart';
import '../domain/child_goal.dart';
import '../domain/child_quiz.dart';
import 'foreground_timer.dart';

/// The phase of one working session, from tapping «يلا نبدأ» to the moment
/// the server answers.
enum GoalSessionPhase {
  /// Nothing has been sent yet — the goal card's own detail view.
  idle,

  /// `POST /self/achievements/start` in flight.
  starting,

  /// Started. The timer is running and the child is working.
  running,

  /// `POST /self/achievements/:id/submit` in flight.
  submitting,

  /// The server answered. [GoalSessionState.outcome] holds what it said.
  answered,
}

class GoalSessionState {
  const GoalSessionState({
    this.phase = GoalSessionPhase.idle,
    this.achievement,
    this.outcome,
    this.failure,
    this.foregroundSeconds = 0,
    this.selfConfirmed = false,
    this.quiz,
    this.quizAnswers = const {},
    this.quizFailure,
    this.quizLoading = false,
  });

  final GoalSessionPhase phase;
  final StartedAchievement? achievement;
  final SubmitOutcome? outcome;

  /// The server's "no", carrying `messageAr`. Shown as coaching, never as
  /// an error page — see `KidErrorState`.
  final ApiFailure? failure;

  /// FOREGROUND seconds measured by [ForegroundStopwatch]. Evidence only.
  final int foregroundSeconds;

  final bool selfConfirmed;

  /// The set the SERVER drew for this attempt. Null until the child opens
  /// the quiz; identical on every re-open inside the same attempt.
  final ServedQuiz? quiz;

  /// question index -> chosen choice index. A Map, not a List, because a
  /// child may answer out of order and an unanswered question must stay
  /// distinguishable from "answered 0".
  final Map<int, int> quizAnswers;

  /// A quiz that could not be served — `PROGRAM_HAS_NO_QUIZ`, or
  /// `QUIZ_BANK_EMPTY` («لا توجد أسئلة جاهزة لهذا النشاط بعد. أخبر ولي أمرك
  /// ليضيفها.»). Rendered as coaching, kept separate from [failure] so a
  /// missing question bank does not look like a broken submit.
  final ApiFailure? quizFailure;

  final bool quizLoading;

  bool get isBusy =>
      phase == GoalSessionPhase.starting || phase == GoalSessionPhase.submitting;

  bool get isRunning => phase == GoalSessionPhase.running;

  GoalSessionState copyWith({
    GoalSessionPhase? phase,
    StartedAchievement? achievement,
    SubmitOutcome? outcome,
    ApiFailure? failure,
    bool clearFailure = false,
    int? foregroundSeconds,
    bool? selfConfirmed,
    ServedQuiz? quiz,
    Map<int, int>? quizAnswers,
    ApiFailure? quizFailure,
    bool clearQuizFailure = false,
    bool? quizLoading,
  }) =>
      GoalSessionState(
        phase: phase ?? this.phase,
        achievement: achievement ?? this.achievement,
        outcome: outcome ?? this.outcome,
        failure: clearFailure ? null : (failure ?? this.failure),
        foregroundSeconds: foregroundSeconds ?? this.foregroundSeconds,
        selfConfirmed: selfConfirmed ?? this.selfConfirmed,
        quiz: quiz ?? this.quiz,
        quizAnswers: quizAnswers ?? this.quizAnswers,
        quizFailure: clearQuizFailure ? null : (quizFailure ?? this.quizFailure),
        quizLoading: quizLoading ?? this.quizLoading,
      );

  /// How many of the served questions have an answer. A COUNT OF ANSWERS,
  /// not a score — the client has no key and cannot produce one.
  int get answeredCount => quizAnswers.length;

  bool get quizFullyAnswered =>
      quiz != null && quiz!.questions.isNotEmpty && answeredCount >= quiz!.questions.length;
}

/// THE HEART OF THE CHILD'S JOURNEY: start → timer → submit → answer.
///
/// WHAT THIS CONTROLLER DELIBERATELY CANNOT DO, and the reason the whole
/// product depends on it: it cannot decide that a goal was achieved. There
/// is no branch below that sets a reward, marks a pass, or triggers a
/// celebration on a timer reaching its target. [submit] sends EVIDENCE and
/// stores whatever the server sends back. The celebration in the UI is
/// gated on [SubmitOutcome.isVerified], which is the server's word.
///
/// This is not a stylistic preference. F4's own rule is that a child
/// completing a timer must NOT automatically earn the reward, and the only
/// way a client can honour a rule like that is by having no code path that
/// could break it.
class GoalSessionController extends StateNotifier<GoalSessionState> {
  GoalSessionController(this._repository, this.goal) : super(const GoalSessionState()) {
    _stopwatch = ForegroundStopwatch(onTick: _onTick);
  }

  final ChildAchievementsRepository _repository;
  final TodayGoal goal;
  late final ForegroundStopwatch _stopwatch;

  void _onTick() {
    if (!mounted) return;
    state = state.copyWith(foregroundSeconds: _stopwatch.elapsedSeconds);
  }

  /// How far through the required duration the child is, 0..1. A DISPLAY
  /// fraction for the progress ring — it decides nothing.
  double get progress {
    final required = goal.durationMinutes * 60;
    if (required <= 0) return 0;
    return (state.foregroundSeconds / required).clamp(0.0, 1.0);
  }

  /// True once the on-device counter has reached the target. Used ONLY to
  /// change the encouraging caption under the ring — the submit button is
  /// enabled the whole time, because a child who finished early and wants a
  /// parent to look should not be held hostage by a stopwatch.
  bool get reachedTarget => state.foregroundSeconds >= goal.durationMinutes * 60;

  Future<void> start() async {
    if (state.isBusy || state.isRunning) return;
    state = state.copyWith(phase: GoalSessionPhase.starting, clearFailure: true);
    try {
      final achievement = await _repository.start(goal.programId);
      state = state.copyWith(phase: GoalSessionPhase.running, achievement: achievement);
      _stopwatch.start();
    } on ApiFailure catch (failure) {
      // A 409 here is the common, DESIGNED case — daily limit reached, an
      // attempt already open, the program paused. It carries the Arabic
      // sentence the child should read, and it is not an error page.
      state = state.copyWith(phase: GoalSessionPhase.idle, failure: failure);
    }
  }

  void setSelfConfirmed(bool value) => state = state.copyWith(selfConfirmed: value);

  /// Fetch the questions the server drew for this attempt. Idempotent by
  /// design on BOTH sides: this returns early if a set is already held, and
  /// the server returns the identical set for the same
  /// `(achievementId, attemptNo)` rather than re-rolling.
  Future<void> loadQuiz() async {
    final achievement = state.achievement;
    if (achievement == null || state.quizLoading || state.quiz != null) return;
    state = state.copyWith(quizLoading: true, clearQuizFailure: true);
    try {
      final quiz = await _repository.quiz(achievement.id);
      state = state.copyWith(quizLoading: false, quiz: quiz);
    } on ApiFailure catch (failure) {
      state = state.copyWith(quizLoading: false, quizFailure: failure);
    }
  }

  /// Record ONE chosen choice index for one question. There is deliberately
  /// no feedback here — no "correct!", no colour change, no running score —
  /// because the client does not know and must not appear to.
  void answerQuestion(int questionIndex, int choiceIndex) {
    final next = Map<int, int>.from(state.quizAnswers)..[questionIndex] = choiceIndex;
    state = state.copyWith(quizAnswers: next);
  }

  /// The answer sheet, positionally aligned with the server's own order.
  /// An unanswered question sends `-1`… no: the DTO bounds each entry to
  /// 0..5, so an unanswered question sends a deliberately-wrong 0 only if it
  /// is followed by an answered one; a trailing unanswered tail is simply
  /// omitted, which the grader treats as wrong. Both are "blank means
  /// wrong", which is what leaving a question blank means.
  List<int> _answerSheet() {
    final quiz = state.quiz;
    if (quiz == null) return const [];
    final answers = state.quizAnswers;
    var last = -1;
    for (var i = 0; i < quiz.questions.length; i += 1) {
      if (answers.containsKey(i)) last = i;
    }
    return [for (var i = 0; i <= last; i += 1) answers[i] ?? 0];
  }

  Future<void> submit({String? note}) async {
    final achievement = state.achievement;
    if (achievement == null || state.isBusy) return;
    _stopwatch.pause();
    state = state.copyWith(phase: GoalSessionPhase.submitting, clearFailure: true);
    try {
      final outcome = await _repository.submit(
        achievement.id,
        // Only send what this goal's method actually asks for. Sending a
        // `selfConfirmed: true` on a Quran memorisation program would be
        // meaningless noise — the server ignores it, and the request should
        // not have claimed it.
        selfConfirmed: goal.needsSelfConfirmation ? state.selfConfirmed : null,
        quizAnswers: goal.needsQuiz ? _answerSheet() : null,
        // EVIDENCE. The server clamps it against its own measured elapsed
        // time before it counts for anything.
        foregroundMinutes: _stopwatch.elapsedMinutes,
        note: note,
      );
      state = state.copyWith(phase: GoalSessionPhase.answered, outcome: outcome);
      _stopwatch.stop();
    } on ApiFailure catch (failure) {
      // The attempt is still open server-side; the child can try again.
      state = state.copyWith(phase: GoalSessionPhase.running, failure: failure);
      _stopwatch.start();
    }
  }

  /// After a FAILED (not escalated) outcome the attempt stays open and the
  /// child may submit again — F4 keeps the door open on purpose. This puts
  /// the screen back into the running phase without a second `start`.
  void tryAgain() {
    if (state.outcome?.canTryAgain != true) return;
    state = state.copyWith(phase: GoalSessionPhase.running, clearFailure: true);
    _stopwatch.start();
  }

  void clearFailure() => state = state.copyWith(clearFailure: true);

  @override
  void dispose() {
    _stopwatch.dispose();
    super.dispose();
  }
}
