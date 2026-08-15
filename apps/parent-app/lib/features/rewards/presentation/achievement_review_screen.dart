import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../application/achievements_controller.dart';
import '../domain/achievement.dart';

/// THE DECISION SCREEN — the attempt log (`GET .../attempts`) plus
/// approve / reject (`POST .../approve`, `POST .../reject`).
///
/// THE APPEND-ONLY LOG IS SHOWN IN FULL, including the SYSTEM rows. F4
/// records every automatic verification with its method, result, reason
/// code and verifier type, and no client has ever displayed it. A parent
/// deciding «هل أثق بهذا؟» deserves to see that the server already tried
/// three times and escalated on `ATTEMPTS_EXHAUSTED` — that context is the
/// difference between a rubber stamp and a judgement.
///
/// THE COPY IS NON-PUNITIVE ON BOTH BUTTONS. «وافق» and «أعده للمحاولة» —
/// not «ارفض». Rejecting writes a `PARENT_REJECTED` attempt row and emits
/// `ACHIEVEMENT_REJECTED`; it grants nothing and closes no door, and the
/// child may attempt the same program again. Saying «رفض» to a parent
/// invites them to say «فشلت» to a child.
class AchievementReviewScreen extends ConsumerStatefulWidget {
  const AchievementReviewScreen({
    super.key,
    required this.achievementId,
    this.targetSummaryAr = '',
  });

  final String achievementId;
  final String targetSummaryAr;

  @override
  ConsumerState<AchievementReviewScreen> createState() => _AchievementReviewScreenState();
}

class _AchievementReviewScreenState extends ConsumerState<AchievementReviewScreen> {
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
    final state = ref.watch(achievementReviewControllerProvider(widget.achievementId));
    final controller =
        ref.read(achievementReviewControllerProvider(widget.achievementId).notifier);

    ref.listen<AchievementReviewState>(
      achievementReviewControllerProvider(widget.achievementId),
      (previous, next) {
        if (next.isDecided && previous?.isDecided != true) Navigator.of(context).pop(true);
      },
    );

    return Scaffold(
      appBar: AppBar(title: Text(t('review.title'))),
      body: ListView(
        padding: DsSpace.screen,
        children: [
          DsCard(
            accent: DsColor.statePending,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  widget.targetSummaryAr.isEmpty
                      ? t('reviewQueue.unnamedGoal')
                      : widget.targetSummaryAr,
                  style: DsText.sectionTitle(context),
                ),
                DsSpace.gapSm,
                Text(t('review.intro'), style: DsText.caption(context)),
              ],
            ),
          ),
          if (state.decisionFailure != null) ...[
            DsErrorState(
              failure: state.decisionFailure!,
              title: t('review.decisionFailedTitle'),
              retryLabel: t('common.dismiss'),
              requestIdLabel: t('common.requestId'),
              arabic: locale.isRtl,
              compact: true,
              onRetry: controller.clearFailure,
            ),
            DsSpace.gapLg,
          ],
          if (state.evidence.isNotEmpty) ...[
            DsSectionHeader(
              title: t('review.evidenceSection'),
              subtitle: t('review.evidenceHint'),
            ),
            for (final item in state.evidence)
              DsCard(
                padding: const EdgeInsets.all(DsSpace.md),
                child: Row(
                  children: [
                    Icon(
                      item.kind == 'AUDIO' ? Icons.graphic_eq_rounded : Icons.image_outlined,
                      color: DsColor.accent,
                    ),
                    DsSpace.hGapMd,
                    Expanded(
                      child: Text(
                        t('evidenceKind.${item.kind}'),
                        style: DsText.cardTitle(context),
                      ),
                    ),
                    DsBadge(label: item.sizeLabel),
                  ],
                ),
              ),
            DsSpace.gapSm,
            // HONEST LIMIT: the bytes come from an authenticated streaming
            // route, and playing audio or showing an image inside this app
            // needs a media dependency this phase is not allowed to add.
            // Saying so beats a play button that does nothing.
            Text(t('review.evidencePlaybackDeferred'), style: DsText.caption(context)),
            DsSpace.gapLg,
          ],
          DsSectionHeader(
            title: t('review.attemptsSection'),
            subtitle: t('review.attemptsHint'),
          ),
          DsStateView<List<VerificationAttempt>>(
            state: state.attempts,
            arabic: locale.isRtl,
            loadingLabel: t('common.loading'),
            emptyTitle: t('review.attemptsEmptyTitle'),
            emptyBody: t('review.attemptsEmptyBody'),
            emptyIcon: Icons.history_toggle_off_rounded,
            errorTitle: t('review.attemptsErrorTitle'),
            retryLabel: t('common.retry'),
            requestIdLabel: t('common.requestId'),
            onRetry: controller.load,
            builder: (context, attempts) => Column(
              children: [for (final attempt in attempts) _AttemptCard(attempt: attempt)],
            ),
          ),
          DsSpace.gapLg,
          DsSectionHeader(title: t('review.decisionSection')),
          TextField(
            controller: _note,
            maxLength: 280,
            maxLines: 3,
            decoration: InputDecoration(
              labelText: t('review.noteLabel'),
              helperText: t('review.noteHint'),
            ),
          ),
          DsSpace.gapMd,
          DsPrimaryButton(
            label: t('review.approve'),
            icon: Icons.check_rounded,
            busy: state.busy,
            onPressed: () => controller.approve(note: _note.text.trim()),
          ),
          DsSpace.gapMd,
          DsSecondaryButton(
            label: t('review.sendBack'),
            icon: Icons.replay_rounded,
            onPressed: state.busy ? null : () => controller.reject(note: _note.text.trim()),
          ),
          DsSpace.gapSm,
          Text(t('review.sendBackHint'), style: DsText.caption(context)),
        ],
      ),
    );
  }
}

class _AttemptCard extends ConsumerWidget {
  const _AttemptCard({required this.attempt});

  final VerificationAttempt attempt;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(localeControllerProvider.notifier).t;
    final color = attempt.isPassed
        ? DsColor.stateSuccess
        : attempt.isEscalated
            ? DsColor.statePending
            : DsColor.stateMuted;

    return DsCard(
      accent: color,
      padding: const EdgeInsets.all(DsSpace.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  t('review.attemptNumber', options: {'number': attempt.attemptNumber}),
                  style: DsText.cardTitle(context),
                ),
              ),
              DsBadge(label: t('attemptResult.${attempt.result}'), color: color),
            ],
          ),
          DsSpace.gapSm,
          DsKeyValueRow(
            label: t('review.method'),
            value: t('verification.${attempt.method}'),
          ),
          DsKeyValueRow(
            label: t('review.decidedBy'),
            value: attempt.byParent ? t('review.byParent') : t('review.bySystem'),
          ),
          if (attempt.scorePercent != null)
            DsKeyValueRow(
              label: t('review.score'),
              value: '${attempt.scorePercent}%',
            ),
          DsKeyValueRow(
            label: t('review.reason'),
            // The reason code is a machine value with a localised sentence.
            // Falling back to the raw code is deliberate: an unknown code is
            // more useful on screen than a blank line, and it tells us a
            // server code was added that the client has not caught up with.
            value: t('reasonCode.${attempt.reasonCode}'),
          ),
        ],
      ),
    );
  }
}
