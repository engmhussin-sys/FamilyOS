import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/widgets/celebration_overlay.dart';
import '../../../core/widgets/sparky_mascot.dart';
import '../domain/child_achievement.dart';
import '../domain/child_goal.dart';

/// THE MOMENT — what the child sees after the server answers.
///
/// THREE OUTCOMES, THREE DIFFERENT FEELINGS, ZERO FAILURES.
///
///   1. **VERIFIED** — confetti, Sparky celebrating, the reward named out
///      loud. `CelebrationOverlay.burst()` fires exactly once, and ONLY
///      here: the trigger is `outcome.isVerified`, which is the server's
///      word after it ran the verification strategy and wrote the ledger
///      row. A finished timer never reaches this branch on its own.
///
///   2. **ESCALATED** — «وصلت لولي أمرك». Purple, warm, patient. Nothing
///      was lost and nothing failed; a human is going to look. F4 chose
///      escalation over rejection deliberately (`ATTEMPTS_EXHAUSTED` says
///      «أرسلنا محاولتك إلى ولي الأمر ليطّلع عليها»), and the UI must not
///      undo that choice by drawing it like a failure.
///
///   3. **NOT YET** — the attempt stays OPEN and «جرّب تاني» is the primary
///      action. The word «فشلت» appears nowhere in this file, in either
///      language, and the server's own sentence — «النتيجة 40% والعتبة 70%.
///      جرّب مرة أخرى.» — is what explains why.
///
/// In all three branches the explanatory line is `outcome.messageAr`,
/// rendered verbatim. The client writes the frame; the server writes the
/// words (CONTEXT §3 principle 7).
class CelebrationView extends ConsumerStatefulWidget {
  const CelebrationView({
    super.key,
    required this.goal,
    required this.outcome,
    required this.onTryAgain,
    required this.onDone,
  });

  final TodayGoal goal;
  final SubmitOutcome outcome;
  final VoidCallback onTryAgain;
  final VoidCallback onDone;

  @override
  ConsumerState<CelebrationView> createState() => _CelebrationViewState();
}

class _CelebrationViewState extends ConsumerState<CelebrationView> {
  bool _burstFired = false;

  @override
  void initState() {
    super.initState();
    if (widget.outcome.isVerified) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || _burstFired) return;
        _burstFired = true;
        CelebrationOverlay.of(context).burst();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;
    final outcome = widget.outcome;
    final goal = widget.goal;

    final verified = outcome.isVerified;
    final waiting = outcome.isWaitingForParent;

    final accent = verified
        ? KidColor.done
        : waiting
            ? KidColor.waiting
            : KidColor.notNow;

    return ListView(
      padding: KidSpace.screen,
      children: [
        KidSpace.gapXl,
        Center(
          child: SparkyMascot(
            mood: verified ? SparkyMood.celebrating : SparkyMood.neutral,
            size: 140,
          ),
        ),
        KidSpace.gapLg,
        Text(
          verified
              ? t('celebrate.verifiedTitle')
              : waiting
                  ? t('celebrate.waitingTitle')
                  : t('celebrate.notYetTitle'),
          style: KidText.screenTitle(context).copyWith(color: accent),
          textAlign: TextAlign.center,
        ),
        KidSpace.gapMd,
        Container(
          padding: const EdgeInsets.all(KidSpace.lg),
          decoration: BoxDecoration(
            color: accent.withOpacity(0.14),
            borderRadius: KidRadius.cardBorder,
          ),
          child: Column(
            children: [
              // THE SERVER'S OWN SENTENCE.
              Text(
                outcome.messageAr.isNotEmpty
                    ? outcome.messageAr
                    : verified
                        ? t('celebrate.verifiedFallback')
                        : waiting
                            ? t('celebrate.waitingFallback')
                            : t('celebrate.notYetFallback'),
                style: KidText.body(context),
                textAlign: TextAlign.center,
              ),
              if (outcome.scorePercent != null) ...[
                KidSpace.gapMd,
                KidBadge(
                  label: t('celebrate.score', options: {'percent': outcome.scorePercent!}),
                  color: accent,
                  icon: Icons.insights_rounded,
                ),
              ],
            ],
          ),
        ),
        if (verified) ...[
          KidSpace.gapLg,
          Row(
            children: [
              Expanded(
                child: KidStatTile(
                  value: goal.reward.amount.toString(),
                  label: goal.reward.isScreenTime
                      ? t('goalDetail.bonusMinutes')
                      : goal.reward.isPoints
                          ? t('goalDetail.points')
                          : t('rewardType.${goal.reward.type}'),
                  icon: Icons.star_rounded,
                  color: KidColor.highlight,
                ),
              ),
            ],
          ),
          KidSpace.gapSm,
          Text(
            // Honest about the one case where the reward is not instant: a
            // physical or privilege reward waits on a parent's hand, and
            // saying so here prevents the disappointment of looking for it
            // and finding nothing.
            goal.reward.isPoints || goal.reward.isScreenTime
                ? t('celebrate.rewardInstant')
                : t('celebrate.rewardWaitsForParent'),
            style: KidText.caption(context),
            textAlign: TextAlign.center,
          ),
        ],
        if (!verified && !waiting && outcome.attemptsLeft > 0) ...[
          KidSpace.gapMd,
          Center(
            child: KidBadge(
              label: t('celebrate.attemptsLeft', options: {'count': outcome.attemptsLeft}),
              color: KidColor.primary,
            ),
          ),
        ],
        KidSpace.gapXl,
        if (outcome.canTryAgain)
          KidBigButton(
            label: t('celebrate.tryAgain'),
            icon: Icons.refresh_rounded,
            color: KidColor.primary,
            onPressed: widget.onTryAgain,
          ),
        KidSpace.gapMd,
        KidQuietButton(
          label: t('celebrate.backToGoals'),
          icon: Icons.home_rounded,
          onPressed: widget.onDone,
        ),
      ],
    );
  }
}
