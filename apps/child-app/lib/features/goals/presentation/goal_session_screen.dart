import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/widgets/celebration_overlay.dart';
import '../application/goal_session_controller.dart';
import '../domain/child_goal.dart';
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
          goal.targetSummaryAr.isEmpty ? t('category.${goal.category}') : goal.targetSummaryAr,
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
        if (goal.needsUpload)
          KidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.mic_none_rounded, color: KidColor.magic),
                    KidSpace.hGapSm,
                    Expanded(
                      child: Text(t('session.uploadTitle'), style: KidText.cardTitle(context)),
                    ),
                  ],
                ),
                KidSpace.gapSm,
                // Same honesty: there is no upload endpoint yet. The attempt
                // still reaches a parent, who decides — which is what this
                // verification method does anyway (`canAutoApprove: false`).
                Text(t('session.uploadNotReady'), style: KidText.body(context)),
              ],
            ),
          ),
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
      ],
    );
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
