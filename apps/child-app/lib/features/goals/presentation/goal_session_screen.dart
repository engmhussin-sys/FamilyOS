import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/widgets/celebration_overlay.dart';
import '../application/goal_session_controller.dart';
import '../domain/child_goal.dart';
import '../domain/evidence.dart';
import 'celebration_view.dart';

/// THE WORKING SESSION — timer, progress, submit, and the answer.
///
/// THE ONE RULE THIS SCREEN EXISTS TO ENFORCE VISUALLY: a full ring is not
/// a reward. The ring reaching 100% changes a caption and nothing else. The
/// child presses «خلّصت!», the server runs its strategy, and only
/// [SubmitOutcome.isVerified] — the server's word — produces the
/// celebration. There is no code path on this screen that can award
/// anything, which is what makes F4's «a completed timer must not
/// automatically earn the reward» a property rather than a promise.
class GoalSessionScreen extends ConsumerStatefulWidget {
  const GoalSessionScreen({super.key, required this.goal});

  final TodayGoal goal;

  @override
  ConsumerState<GoalSessionScreen> createState() => _GoalSessionScreenState();
}

class _GoalSessionScreenState extends ConsumerState<GoalSessionScreen> {
  final _note = TextEditingController();

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final goal = widget.goal;
    final state = ref.watch(goalSessionControllerProvider(goal));
    final controller = ref.read(goalSessionControllerProvider(goal).notifier);

    return CelebrationOverlay(
      child: Scaffold(
        appBar: AppBar(
          title: Text(t('session.title')),
          automaticallyImplyLeading: state.phase != GoalSessionPhase.submitting,
        ),
        body: state.phase == GoalSessionPhase.answered && state.outcome != null
            ? CelebrationView(
                goal: goal,
                outcome: state.outcome!,
                onTryAgain: controller.tryAgain,
                // Back to the shell, not back to the detail screen the
                // session was pushed from — a child who just finished should
                // land on today's list, not on the goal they already did.
                onDone: () => Navigator.of(context).popUntil((route) => route.isFirst),
              )
            : _buildWorking(context, t, locale.isRtl, state, controller),
      ),
    );
  }

  Widget _buildWorking(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
    GoalSessionState state,
    GoalSessionController controller,
  ) {
    final goal = widget.goal;
    final seconds = state.foregroundSeconds;
    final reached = controller.reachedTarget;

    return ListView(
      padding: KidSpace.screen,
      children: [
        Text(
          // The server's own sentence when there is one; otherwise this app's
          // name for the category — and never the raw category CODE, which is
          // what `t('category.<something new>')` would have rendered.
          goal.targetSummaryAr.isEmpty
              ? ref.read(localeControllerProvider.notifier).tOrElse(
                    'category.${goal.category}',
                    t('category.unknown'),
                  )
              : goal.targetSummaryAr,
          style: KidText.sectionTitle(context),
          textAlign: TextAlign.center,
        ),
        KidSpace.gapXl,
        Center(
          child: KidTimerRing(
            progress: controller.progress,
            centerLabel: _clock(seconds),
            caption: reached
                ? t('session.targetReached')
                : t('session.ofTarget',
                    options: {'count': goal.durationMinutes}),
            color: reached ? KidColor.done : KidColor.primary,
          ),
        ),
        KidSpace.gapLg,
        Center(
          child: Text(
            // The counter only runs while the app is in front. Saying so
            // plainly is both honest and the only way the number makes
            // sense to a child who switched apps and came back.
            t('session.foregroundNote'),
            style: KidText.caption(context),
            textAlign: TextAlign.center,
          ),
        ),
        KidSpace.gapXl,
        if (goal.needsSelfConfirmation)
          KidCard(
            child: SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              value: state.selfConfirmed,
              onChanged: controller.setSelfConfirmed,
              title: Text(t('session.selfConfirm'), style: KidText.cardTitle(context)),
              subtitle: Text(t('session.selfConfirmHint'), style: KidText.caption(context)),
            ),
          ),
        if (goal.needsQuiz) _buildQuiz(context, t, isRtl, state, controller),
        if (goal.needsUpload) _buildEvidence(context, t, isRtl, state, controller),
        KidSpace.gapMd,
        TextField(
          controller: _note,
          maxLength: 280,
          maxLines: 2,
          decoration: InputDecoration(
            labelText: t('session.noteLabel'),
            helperText: t('session.noteHint'),
          ),
        ),
        if (state.failure != null) ...[
          KidSpace.gapLg,
          KidErrorState(
            failure: state.failure!,
            title: state.failure!.isNotNow
                ? t('session.notNowTitle')
                : t('session.somethingHappenedTitle'),
            retryLabel: t('common.retry'),
            arabic: isRtl,
            compact: true,
            onRetry: controller.clearFailure,
          ),
        ],
        KidSpace.gapXl,
        KidBigButton(
          label: goal.endsWithParent ? t('session.sendToParent') : t('session.done'),
          icon: Icons.send_rounded,
          busy: state.isBusy,
          color: reached ? KidColor.done : KidColor.primary,
          onPressed: () => controller.submit(note: _note.text.trim()),
        ),
        KidSpace.gapSm,
        Text(
          goal.endsWithParent ? t('session.parentWillSee') : t('session.serverWillCheck'),
          style: KidText.caption(context),
          textAlign: TextAlign.center,
        ),
        // F1 — SAID, NOT ENFORCED. The button above stays enabled with no
        // uploaded file, because deciding that a submission is invalid is the
        // server's job and not this screen's; `RECITATION_MISSING` /
        // `ARTIFACT_MISSING` come back in the server's own words, and both
        // methods end with a parent regardless. This line only makes sure the
        // child is not surprised by that answer.
        if (goal.needsUpload && !state.evidence.hasStoredFile) ...[
          KidSpace.gapXs,
          Text(
            t('session.evidence.notAttachedYet'),
            style: KidText.caption(context),
            textAlign: TextAlign.center,
          ),
        ],
      ],
    );
  }

  /// THE EVIDENCE CARD — F1, and what replaced a paragraph explaining that
  /// this could not be built.
  ///
  /// WHAT THIS WIDGET IS NOT ALLOWED TO SAY, and the reason it is written the
  /// way it is: there is no state below in which a child is told their
  /// recitation was good, accepted, verified or rewarded. The strongest
  /// sentence on it is «اتبعت» — the bytes arrived — followed immediately by
  /// «حد كبير هيشوفها». Both methods that reach this card have
  /// `canAutoApprove: false` in the server's own verification matrix, so an
  /// acceptance verdict here would not merely be off-brand, it would be
  /// false.
  ///
  /// AND NOTHING HERE IS A DECORATIVE CONTROL. Every button opens a real
  /// recorder or a real picker. The mode set comes from
  /// [EvidenceContract.modesFor], derived from the ALLOWED MIME TYPES for
  /// this goal's kind — so an artifact goal gets a "pick a file" button
  /// because the server accepts `application/pdf`, and a recitation goal does
  /// not get a gallery button, because an audio file out of the gallery is
  /// not this child reciting.
  Widget _buildEvidence(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
    GoalSessionState state,
    GoalSessionController controller,
  ) {
    final kind = EvidenceContract.kindForVerificationLevel(widget.goal.verificationLevel);
    if (kind == null) return const SizedBox.shrink();

    final evidence = state.evidence;
    final isRecitation = kind == EvidenceKind.recitation;
    final modes = EvidenceContract.modesFor(kind);
    final busy = evidence.isUploading || state.isBusy;
    final noticeKey = evidence.noticeKey;
    final uploadFailure = evidence.failure;

    return KidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                isRecitation ? Icons.mic_none_rounded : Icons.photo_camera_outlined,
                color: KidColor.magic,
              ),
              KidSpace.hGapSm,
              Expanded(
                child: Text(t('session.uploadTitle'), style: KidText.cardTitle(context)),
              ),
            ],
          ),
          KidSpace.gapSm,
          Text(
            isRecitation
                ? t('session.evidence.recitationHow')
                : t('session.evidence.artifactHow'),
            style: KidText.body(context),
          ),

          // THE MICROPHONE RATIONALE, ABOVE THE BUTTON THAT TRIGGERS THE
          // DIALOG. Android shows that dialog a very small number of times in
          // an app's entire life; spending one on a child who has no idea
          // what is being asked wastes a chance that does not come back. It
          // is also simply what a nine-year-old is owed before a prompt.
          if (isRecitation && !evidence.hasStoredFile && !evidence.isRecording) ...[
            KidSpace.gapSm,
            Text(t('session.evidence.micWhy'), style: KidText.caption(context)),
          ],

          KidSpace.gapMd,

          if (evidence.isUploading)
            Row(
              children: [
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2.5),
                ),
                KidSpace.hGapMd,
                Expanded(
                  child: Text(t('session.evidence.uploading'), style: KidText.body(context)),
                ),
              ],
            )
          else if (evidence.isRecording) ...[
            Row(
              children: [
                const Icon(Icons.fiber_manual_record_rounded, color: KidColor.warm, size: 18),
                KidSpace.hGapSm,
                Expanded(
                  child: Text(
                    t('session.evidence.recording',
                        options: {'time': _clock(evidence.recordingSeconds)}),
                    style: KidText.body(context),
                  ),
                ),
              ],
            ),
            KidSpace.gapMd,
            KidBigButton(
              label: t('session.evidence.stop'),
              icon: Icons.stop_rounded,
              color: KidColor.magic,
              onPressed: controller.stopRecitation,
            ),
            KidSpace.gapSm,
            KidQuietButton(
              label: t('session.evidence.cancelRecording'),
              icon: Icons.restart_alt_rounded,
              onPressed: controller.cancelRecitation,
            ),
          ] else if (evidence.hasStoredFile) ...[
            // THE STRONGEST SENTENCE ON THIS CARD, and it is a transport fact:
            // the file went. Followed by who decides, which is not this app.
            Row(
              children: [
                const Icon(Icons.cloud_done_outlined, color: KidColor.waiting),
                KidSpace.hGapSm,
                Expanded(
                  child: Text(
                    t('session.evidence.stored',
                        options: {'name': evidence.filename ?? ''}),
                    style: KidText.body(context),
                  ),
                ),
              ],
            ),
            KidSpace.gapXs,
            Text(t('session.evidence.storedHint'), style: KidText.caption(context)),
            KidSpace.gapMd,
            KidQuietButton(
              label: t('session.evidence.replace'),
              icon: Icons.autorenew_rounded,
              onPressed: busy ? null : controller.clearEvidence,
            ),
          ] else ...[
            for (final mode in modes) ...[
              KidQuietButton(
                label: _modeLabel(t, mode),
                icon: _modeIcon(mode),
                onPressed: busy ? null : () => _runMode(controller, mode),
              ),
              KidSpace.gapSm,
            ],
            Text(t('session.evidence.none'), style: KidText.caption(context)),
          ],

          // A CLIENT-SIDE NOTICE — too big, wrong kind, the microphone is
          // off, the recorder failed. Warm, never red, and it names the next
          // step. These are the only sentences on this path written by the
          // app rather than by the server, and they exist only because they
          // are said BEFORE any request is made.
          if (noticeKey != null) ...[
            KidSpace.gapMd,
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(KidSpace.md),
              decoration: BoxDecoration(
                color: KidColor.notNow.withOpacity(0.16),
                borderRadius: KidRadius.cardBorder,
              ),
              child: Text(
                t(noticeKey, options: {'mb': EvidenceContract.maxMegabytes}),
                style: KidText.body(context),
              ),
            ),
          ],

          // AND A SERVER "NO", rendered from the server's own `messageAr`:
          // EVIDENCE_TOO_LARGE, EVIDENCE_TYPE_WRONG_FOR_METHOD,
          // ACHIEVEMENT_NOT_SUBMITTABLE, CLIENT_OFFLINE. Nothing here rewrites
          // it or improves on it.
          if (uploadFailure != null) ...[
            KidSpace.gapSm,
            KidErrorState(
              failure: uploadFailure,
              title: t('session.evidence.uploadFailedTitle'),
              retryLabel: t('common.retry'),
              arabic: isRtl,
              compact: true,
              onRetry: controller.clearEvidence,
            ),
          ],
        ],
      ),
    );
  }

  /// The child-facing name of one capture mode. A `switch` rather than a map
  /// so that a mode added to [EvidenceCaptureMode] stops compiling here
  /// instead of quietly rendering a blank button.
  String _modeLabel(
    String Function(String, {int? count, Map<String, Object>? options}) t,
    EvidenceCaptureMode mode,
  ) {
    switch (mode) {
      case EvidenceCaptureMode.recordAudio:
        return t('session.evidence.record');
      case EvidenceCaptureMode.cameraPhoto:
        return t('session.evidence.camera');
      case EvidenceCaptureMode.galleryImage:
        return t('session.evidence.gallery');
      case EvidenceCaptureMode.document:
        return t('session.evidence.document');
    }
  }

  IconData _modeIcon(EvidenceCaptureMode mode) {
    switch (mode) {
      case EvidenceCaptureMode.recordAudio:
        return Icons.mic_rounded;
      case EvidenceCaptureMode.cameraPhoto:
        return Icons.photo_camera_rounded;
      case EvidenceCaptureMode.galleryImage:
        return Icons.image_outlined;
      case EvidenceCaptureMode.document:
        return Icons.description_outlined;
    }
  }

  void _runMode(GoalSessionController controller, EvidenceCaptureMode mode) {
    switch (mode) {
      case EvidenceCaptureMode.recordAudio:
        controller.startRecitation();
      case EvidenceCaptureMode.cameraPhoto:
        controller.attachPhoto();
      case EvidenceCaptureMode.galleryImage:
        controller.attachFromGallery();
      case EvidenceCaptureMode.document:
        controller.attachDocument();
    }
  }

  /// THE QUIZ — questions the SERVER drew, answers the SERVER grades.
  ///
  /// B5 (backend) replaced `quizCorrect`/`quizTotal` with `quizAnswers`, and
  /// the shape of this widget is the visible half of that change. Note what
  /// is NOT here: no correct-answer highlight, no per-question tick, no
  /// running score, no "you got 3 of 5". The device does not hold the key
  /// and must not look as though it does — the first time a child learns
  /// their score is from `outcome.messageAr` after submitting.
  Widget _buildQuiz(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
    GoalSessionState state,
    GoalSessionController controller,
  ) {
    // Idempotent on both sides: the controller returns early once a set is
    // held, and the server returns the identical set per (attempt, id).
    WidgetsBinding.instance.addPostFrameCallback((_) => controller.loadQuiz());

    if (state.quizLoading) {
      return KidCard(child: KidLoadingState(label: t('session.quizLoading')));
    }
    if (state.quizFailure != null) {
      // `QUIZ_BANK_EMPTY` lands here — «لا توجد أسئلة جاهزة لهذا النشاط بعد.
      // أخبر ولي أمرك ليضيفها.» That is an operator gap, not the child's
      // fault, and the server says so itself.
      return KidCard(
        child: KidErrorState(
          failure: state.quizFailure!,
          title: t('session.quizUnavailableTitle'),
          retryLabel: t('common.retry'),
          arabic: isRtl,
          compact: true,
          onRetry: controller.loadQuiz,
        ),
      );
    }
    final quiz = state.quiz;
    if (quiz == null || quiz.isEmpty) {
      return KidCard(child: Text(t('session.quizNotReady'), style: KidText.body(context)));
    }

    return KidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.quiz_outlined, color: KidColor.magic),
              KidSpace.hGapSm,
              Expanded(
                child: Text(t('session.quizTitle'), style: KidText.cardTitle(context)),
              ),
              KidBadge(
                label: t('session.quizAnswered', options: {
                  'answered': state.answeredCount,
                  'total': quiz.questions.length,
                }),
                color: state.quizFullyAnswered ? KidColor.done : KidColor.primary,
              ),
            ],
          ),
          KidSpace.gapMd,
          for (var q = 0; q < quiz.questions.length; q += 1) ...[
            Text(
              t('session.questionNumber', options: {'number': q + 1}),
              style: KidText.caption(context),
            ),
            KidSpace.gapXs,
            Text(quiz.questions[q].promptAr, style: KidText.body(context)),
            KidSpace.gapSm,
            for (var c = 0; c < quiz.questions[q].choices.length; c += 1)
              _ChoiceRow(
                label: quiz.questions[q].choices[c],
                selected: state.quizAnswers[q] == c,
                onTap: () => controller.answerQuestion(q, c),
              ),
            KidSpace.gapLg,
          ],
        ],
      ),
    );
  }

  /// `mm:ss`, forced left-to-right.
  ///
  /// The leading U+200E (LEFT-TO-RIGHT MARK) is load-bearing, not
  /// decoration: inside an RTL paragraph the bidi algorithm treats `12:05`
  /// as a neutral-separated number run and can render it as `05:12`. This
  /// is a real, reproducible Arabic-layout bug and one invisible character
  /// is the standard fix — cheaper and more local than wrapping the label
  /// in a `Directionality` the ring would then have to expose.
  String _clock(int seconds) {
    final m = (seconds ~/ 60).toString().padLeft(2, '0');
    final s = (seconds % 60).toString().padLeft(2, '0');
    return '‎$m:$s';
  }
}

/// One answer choice. Neutral until chosen and neutral after — the only
/// state it has is "you picked this", never "this is right".
class _ChoiceRow extends StatelessWidget {
  const _ChoiceRow({required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: KidSpace.sm),
      decoration: BoxDecoration(
        color: selected ? KidColor.primary.withOpacity(0.12) : Colors.transparent,
        borderRadius: KidRadius.controlBorder,
        border: Border.all(
          color: selected ? KidColor.primary : KidColor.border,
          width: selected ? 2 : 1,
        ),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: KidRadius.controlBorder,
          child: Container(
            constraints: const BoxConstraints(minHeight: 56),
            padding: const EdgeInsets.symmetric(
              horizontal: KidSpace.md,
              vertical: KidSpace.sm,
            ),
            child: Row(
              children: [
                Icon(
                  selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                  color: selected ? KidColor.primary : KidColor.mutedInk,
                ),
                KidSpace.hGapMd,
                Expanded(child: Text(label, style: KidText.body(context))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
