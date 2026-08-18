import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/errors/api_failure.dart';
import '../data/achievements_repository.dart';
import '../data/evidence_capture_source.dart';
import '../domain/child_achievement.dart';
import '../domain/child_goal.dart';
import '../domain/child_quiz.dart';
import '../domain/evidence.dart';
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

/// WHERE THE FILE IS, and nothing about whether it is any good.
///
/// Read the names carefully, because the whole point of this enum is what it
/// refuses to model: there is no `accepted`, no `verified`, no `approved` and
/// there never may be. [uploaded] means BYTES ARRIVED AND WERE STORED. Both
/// verification methods that reach this path have `canAutoApprove: false`, so
/// a parent decides afterwards, and no state here entitles a screen to say
/// otherwise.
enum EvidencePhase {
  /// Nothing captured yet, or the last attempt was cleared.
  idle,

  /// The microphone is live right now.
  recording,

  /// The file is on its way to `POST /:id/evidence`.
  uploading,

  /// The server stored it and returned a `submissionRef`. NOT a verdict.
  uploaded,
}

/// The evidence half of one session's state, kept as one object rather than
/// as six more fields on [GoalSessionState] — every transition below replaces
/// it WHOLESALE, which is what makes "a failed upload leaves no
/// `submissionRef` behind" a property of the type rather than a discipline
/// about clearing fields in the right order.
class EvidenceAttachment {
  const EvidenceAttachment({
    this.phase = EvidencePhase.idle,
    this.filename,
    this.byteSize,
    this.submissionRef,
    this.noticeKey,
    this.failure,
    this.recordingSeconds = 0,
  });

  final EvidencePhase phase;

  /// What the child sees named on the card. From the device, never trusted
  /// for anything — the server stores it truncated and derives the type from
  /// the bytes regardless.
  final String? filename;

  final int? byteSize;

  /// THE ONLY OUTPUT OF THIS WHOLE FEATURE. Non-null exactly when the server
  /// answered with a usable ref, and [GoalSessionController.submit] passes it
  /// through unchanged. Null after any refusal or any failure, which is what
  /// stops a failed upload from being submitted as though it had worked.
  final String? submissionRef;

  /// A localisation key for a CLIENT-SIDE notice — the courtesy pre-checks
  /// (too large, wrong type) and the device-side failures (no microphone, the
  /// picker broke). Never used for anything the server said: a server "no"
  /// arrives in [failure] and is rendered from its own `messageAr`.
  final String? noticeKey;

  /// The server's own refusal or a transport failure, carrying the Arabic
  /// sentence the server wrote. Rendered verbatim, warm, never red.
  final ApiFailure? failure;

  final int recordingSeconds;

  bool get isRecording => phase == EvidencePhase.recording;

  bool get isUploading => phase == EvidencePhase.uploading;

  /// True when there is a ref to send. Named for the transport fact, not for
  /// an outcome.
  bool get hasStoredFile =>
      phase == EvidencePhase.uploaded && (submissionRef?.isNotEmpty ?? false);

  EvidenceAttachment withRecordingSeconds(int seconds) => EvidenceAttachment(
        phase: phase,
        filename: filename,
        byteSize: byteSize,
        submissionRef: submissionRef,
        noticeKey: noticeKey,
        failure: failure,
        recordingSeconds: seconds,
      );
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
    this.evidence = const EvidenceAttachment(),
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

  /// F1 — the recitation or the artifact. See [EvidenceAttachment].
  final EvidenceAttachment evidence;

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
    EvidenceAttachment? evidence,
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
        evidence: evidence ?? this.evidence,
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
  GoalSessionController(this._repository, this.goal, this._capture)
      : super(const GoalSessionState()) {
    _stopwatch = ForegroundStopwatch(onTick: _onTick);
  }

  final ChildAchievementsRepository _repository;
  final TodayGoal goal;

  /// F1 — the recorder and the pickers, behind a port. See
  /// [EvidenceCaptureSource] for why this is not the plugins directly.
  final EvidenceCaptureSource _capture;

  late final ForegroundStopwatch _stopwatch;

  /// Ticks the on-screen recording clock. Cancelled on stop, on discard and
  /// in [dispose] — a `Timer.periodic` that outlives this notifier would keep
  /// calling `state =` on a disposed StateNotifier once per second forever.
  Timer? _recordTicker;

  /// WHICH KIND OF EVIDENCE THIS GOAL NEEDS, derived from the SERVER'S
  /// `verificationLevel` through the mirror of `evidenceKindForMethod`. Null
  /// for the seven methods that take no file, and every capture entry point
  /// below returns immediately in that case — so a UI bug that drew a record
  /// button on a QUIZ goal would produce nothing rather than a bad upload.
  EvidenceKind? get _kind =>
      EvidenceContract.kindForVerificationLevel(goal.verificationLevel);

  /// A HARD STOP FOR THE RECORDER, and it is arithmetic rather than a
  /// preference. At the 64 kbps mono the recorder is configured with, the
  /// server's 15 MiB ceiling is reached at roughly 31 minutes. Cutting the
  /// recording at 25 leaves real margin AND — this is the part that matters —
  /// means a child can never discover the size limit by losing a recording
  /// they had already finished. The file is kept and offered; nothing is
  /// thrown away.
  static const int maxRecordingSeconds = 25 * 60;

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

  // -------------------------------------------------------------------------
  // F1 — EVIDENCE: CAPTURE -> COURTESY CHECK -> UPLOAD -> A REF.
  //
  // THE ONE RULE THIS SECTION ENFORCES: uploading is not submitting, and
  // neither of them is a verdict. Nothing below calls [submit]; the child
  // still presses the button. Nothing below sets [GoalSessionState.outcome];
  // only the server's answer to `submit` does that. And the only thing this
  // section can hand to `submit` is an opaque ref the server itself minted
  // and re-validates against this achievement.
  // -------------------------------------------------------------------------

  /// Starts the recitation. Asks for the microphone FIRST, because the answer
  /// changes what happens next and because the child has already read
  /// `session.evidence.micWhy` above the button that got them here.
  Future<void> startRecitation() async {
    if (_kind != EvidenceKind.recitation) return;
    final current = state.evidence;
    if (current.isRecording || current.isUploading) return;

    state = state.copyWith(evidence: const EvidenceAttachment());

    final granted = await _capture.requestMicrophonePermission();
    if (!mounted) return;
    if (!granted) {
      // NOT A FAILURE AND NOT A TELLING-OFF. The child (or the parent who set
      // the phone up) said no to the microphone, which is allowed. The
      // sentence names the way round it — recite to a grown-up — because
      // `RECITATION_SUBMISSION` ends with a parent deciding anyway.
      state = state.copyWith(
        evidence: const EvidenceAttachment(noticeKey: 'session.evidence.micDenied'),
      );
      return;
    }

    try {
      await _capture.startRecording();
    } on EvidenceCaptureException {
      state = state.copyWith(
        evidence: const EvidenceAttachment(noticeKey: 'session.evidence.captureFailed'),
      );
      return;
    }

    if (!mounted) {
      // The screen went away between the permission answer and the recorder
      // starting. Nothing is left running and nothing is left on disk.
      await _capture.discardRecording();
      return;
    }

    state = state.copyWith(
      evidence: const EvidenceAttachment(phase: EvidencePhase.recording),
    );
    _recordTicker?.cancel();
    _recordTicker = Timer.periodic(const Duration(seconds: 1), _onRecordTick);
  }

  void _onRecordTick(Timer timer) {
    if (!mounted) {
      timer.cancel();
      return;
    }
    final current = state.evidence;
    if (!current.isRecording) {
      timer.cancel();
      return;
    }
    final seconds = current.recordingSeconds + 1;
    state = state.copyWith(evidence: current.withRecordingSeconds(seconds));
    if (seconds >= maxRecordingSeconds) {
      // Stops it and KEEPS it. See [maxRecordingSeconds].
      stopRecitation();
    }
  }

  /// Ends the recitation and sends it.
  Future<void> stopRecitation() async {
    if (!state.evidence.isRecording) return;
    _recordTicker?.cancel();
    _recordTicker = null;

    CapturedEvidence? captured;
    try {
      captured = await _capture.stopRecording();
    } on EvidenceCaptureException {
      if (!mounted) return;
      state = state.copyWith(
        evidence: const EvidenceAttachment(noticeKey: 'session.evidence.captureFailed'),
      );
      return;
    }
    if (!mounted) return;
    await _attach(captured);
  }

  /// Abandons the recitation without sending it. The child's own «امسح».
  Future<void> cancelRecitation() async {
    _recordTicker?.cancel();
    _recordTicker = null;
    await _capture.discardRecording();
    if (!mounted) return;
    state = state.copyWith(evidence: const EvidenceAttachment());
  }

  Future<void> attachPhoto() => _pickThenAttach(() => _capture.pickImage(fromCamera: true));

  Future<void> attachFromGallery() =>
      _pickThenAttach(() => _capture.pickImage(fromCamera: false));

  Future<void> attachDocument() => _pickThenAttach(_capture.pickDocument);

  /// Clears whatever is attached so the child can send something else.
  ///
  /// DELETES NOTHING ON THE SERVER, and does not pretend to: an uploaded
  /// object stays until the retention sweep, and the ref simply stops being
  /// sent. Saying "removed" here would be a claim about the server that this
  /// client is in no position to make — the copy says «اختار حاجة تانية».
  void clearEvidence() {
    if (state.evidence.isRecording || state.evidence.isUploading) return;
    state = state.copyWith(evidence: const EvidenceAttachment());
  }

  Future<void> _pickThenAttach(Future<CapturedEvidence?> Function() pick) async {
    if (_kind != EvidenceKind.artifact) return;
    final current = state.evidence;
    if (current.isRecording || current.isUploading) return;

    state = state.copyWith(evidence: const EvidenceAttachment());

    CapturedEvidence? captured;
    try {
      captured = await pick();
    } on EvidenceCaptureException {
      if (!mounted) return;
      state = state.copyWith(
        evidence: const EvidenceAttachment(noticeKey: 'session.evidence.captureFailed'),
      );
      return;
    }
    if (!mounted) return;
    await _attach(captured);
  }

  /// THE COURTESY CHECK, THEN THE UPLOAD.
  ///
  /// `captured == null` is a CANCELLATION — the child backed out of the
  /// camera or the picker — and it produces no state change and no message at
  /// all. Telling a child something went wrong because they changed their
  /// mind is the small kind of punitive this app does not do.
  ///
  /// The checks that follow are `EvidenceContract.inspect`, which mirrors
  /// `inspectEvidence` on the server byte for byte. They exist to save a slow
  /// connection, NOT to decide anything: the server re-runs all of them on
  /// the bytes it receives, and its answer is the one that counts. A refusal
  /// here therefore never reaches the network and never sets a `submissionRef`.
  Future<void> _attach(CapturedEvidence? captured) async {
    final kind = _kind;
    if (captured == null || kind == null) return;

    final inspection = EvidenceContract.inspect(
      byteSize: captured.byteSize,
      header: captured.header,
      kind: kind,
    );
    final refusal = inspection.refusal;
    final mimeType = inspection.mimeType;
    if (refusal != null || mimeType == null) {
      state = state.copyWith(
        evidence: EvidenceAttachment(
          filename: captured.filename,
          byteSize: captured.byteSize,
          noticeKey: evidenceRefusalMessageKey(
            refusal ?? EvidenceRefusal.typeUnrecognised,
            kind,
          ),
        ),
      );
      return;
    }

    final achievement = state.achievement;
    if (achievement == null) return;

    state = state.copyWith(
      evidence: EvidenceAttachment(
        phase: EvidencePhase.uploading,
        filename: captured.filename,
        byteSize: captured.byteSize,
      ),
    );

    try {
      final ref = await _repository.uploadEvidence(
        achievement.id,
        filePath: captured.path,
        filename: captured.filename,
        // THE TYPE DERIVED FROM THE BYTES, never the picker's claim — the
        // route's multer filter drops a part whose declared Content-Type is
        // outside the allowlist and the child then reads «لم يصل أي ملف».
        mimeType: mimeType,
      );
      if (!mounted) return;
      state = state.copyWith(
        evidence: EvidenceAttachment(
          // A ref-less 2xx should be impossible; if it happens, this stays in
          // `idle` with no ref rather than showing an attachment that `submit`
          // cannot use.
          phase: ref.isUsable ? EvidencePhase.uploaded : EvidencePhase.idle,
          filename: captured.filename,
          // The SERVER'S byte count, which is the one that was stored.
          byteSize: ref.isUsable ? ref.byteSize : captured.byteSize,
          submissionRef: ref.isUsable ? ref.submissionRef : null,
          noticeKey: ref.isUsable ? null : 'session.evidence.captureFailed',
        ),
      );
    } on ApiFailure catch (failure) {
      if (!mounted) return;
      // NO REF, THEREFORE NOTHING TO SUBMIT, AND NOTHING IS SUBMITTED. The
      // child sees the server's own sentence (`EVIDENCE_TOO_LARGE`,
      // `EVIDENCE_TYPE_WRONG_FOR_METHOD`, `CLIENT_OFFLINE`…) and the button
      // they press next is «جرّب تاني», not «تم».
      state = state.copyWith(
        evidence: EvidenceAttachment(
          filename: captured.filename,
          byteSize: captured.byteSize,
          failure: failure,
        ),
      );
    }
  }

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
        // F1 — THE REF, AND THE WHOLE REASON THIS SPRINT EXISTS.
        //
        // Null unless an upload actually completed, which is the property
        // that matters: a refused file and a failed upload both leave
        // `submissionRef` null, so neither can be submitted as though it had
        // worked. The server then answers `RECITATION_MISSING` /
        // `ARTIFACT_MISSING` in its own words, exactly as it does today.
        //
        // The button is NOT disabled when this is null, deliberately. A child
        // whose upload failed on a bad connection may still want a grown-up
        // to see the attempt, and `canAutoApprove: false` means a grown-up is
        // where this ends either way. Blocking the button would be the client
        // deciding what counts as a valid submission, which is precisely the
        // authority it does not have.
        submissionRef: goal.needsUpload ? state.evidence.submissionRef : null,
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
    // F1 — the second timer this class owns. A `Timer.periodic` that survives
    // its notifier keeps assigning to `state` on a disposed StateNotifier once
    // a second, forever; cancelling it here is not tidiness, it is the bug
    // not happening.
    _recordTicker?.cancel();
    _recordTicker = null;
    if (state.evidence.isRecording) {
      // The screen is gone mid-recitation: stop the microphone and delete the
      // partial file. Not awaited — `dispose` is synchronous by contract —
      // and failure inside it is swallowed by the source itself.
      _capture.discardRecording();
    }
    super.dispose();
  }
}
