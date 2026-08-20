import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/widgets/sparky_mascot.dart';
import '../application/goal_session_controller.dart';
import '../domain/child_goal.dart';
import 'goal_session_screen.dart';

/// ONE GOAL, before starting it.
///
/// A deliberately quiet screen: what to do, for how long, what you get, and
/// one big button. The verification method is described in the child's own
/// words («هيسمعك حد كبير», «هتأكد بنفسك») and never by its code name — the
/// machine vocabulary belongs on the parent's side of the product.
class GoalDetailScreen extends ConsumerWidget {
  const GoalDetailScreen({super.key, required this.goal});

  final TodayGoal goal;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(goalSessionControllerProvider(goal));
    final controller = ref.read(goalSessionControllerProvider(goal).notifier);

    // Starting successfully moves the child straight into the session.
    //
    // `push`, NOT `pushReplacement`, and that is load-bearing:
    // `goalSessionControllerProvider` is an `autoDispose` family keyed by
    // this `TodayGoal` instance. Replacing this route would unmount its last
    // listener, and an autoDispose provider with no listeners is disposed —
    // taking the running `ForegroundStopwatch` and the `StartedAchievement`
    // with it, so the session screen would rebuild in the `idle` phase with
    // no achievement id to submit against. Keeping this route mounted keeps
    // exactly one listener alive for the whole session.
    ref.listen<GoalSessionState>(goalSessionControllerProvider(goal), (previous, next) {
      if (next.isRunning && previous?.isRunning != true) {
        Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => GoalSessionScreen(goal: goal)),
        );
      }
    });

    return Scaffold(
      appBar: AppBar(title: Text(t('goalDetail.title'))),
      body: ListView(
        padding: KidSpace.screen,
        children: [
          Center(child: SparkyMascot(mood: SparkyMood.happy, size: 96)),
          KidSpace.gapLg,
          KidCard(
            accent: KidColor.primary,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  goal.targetSummaryAr.isEmpty
                      ? locale.tOrElse(
                          'category.${goal.category}',
                          t('category.unknown'),
                        )
                      : goal.targetSummaryAr,
                  style: KidText.sectionTitle(context),
                ),
                KidSpace.gapMd,
                Row(
                  children: [
                    Expanded(
                      child: KidStatTile(
                        value: goal.durationMinutes.toString(),
                        label: t('goalDetail.minutes'),
                        icon: Icons.schedule_rounded,
                      ),
                    ),
                    KidSpace.hGapMd,
                    Expanded(
                      child: KidStatTile(
                        value: goal.reward.amount.toString(),
                        label: goal.reward.isScreenTime
                            ? t('goalDetail.bonusMinutes')
                            : goal.reward.isPoints
                                ? t('goalDetail.points')
                                : locale.tOrElse(
                                    'rewardType.${goal.reward.type}',
                                    t('rewardType.unknown'),
                                  ),
                        icon: Icons.star_rounded,
                        color: KidColor.highlight,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          KidSpace.gapMd,
          KidCard(
            child: Row(
              children: [
                const Icon(Icons.verified_outlined, color: KidColor.magic),
                KidSpace.hGapMd,
                Expanded(
                  child: Text(
                    // The child's-eye description of how this will be
                    // checked. Sets the expectation BEFORE the work, which
                    // is the difference between "waiting" and "ignored".
                    //
                    // `tOrElse` because this key is assembled from the SERVER'S
                    // `verificationLevel`, and `TodayGoal.fromJson` defaults
                    // that to the empty string for a row that does not carry
                    // one — which rendered the bare key «verifyForKid.» on the
                    // one line that is supposed to explain what happens next.
                    // All nine of the backend's VERIFICATION_METHODS have a
                    // sentence here; this covers the empty and the tenth.
                    locale.tOrElse(
                      'verifyForKid.${goal.verificationLevel}',
                      t('verifyForKid.unknown'),
                    ),
                    style: KidText.body(context),
                  ),
                ),
              ],
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
              arabic: locale.isRtl,
              compact: true,
              onRetry: controller.clearFailure,
            ),
          ],
          KidSpace.gapXl,
          if (goal.available)
            KidBigButton(
              label: t('goalDetail.start'),
              icon: Icons.play_arrow_rounded,
              busy: state.isBusy,
              onPressed: controller.start,
            )
          else
            Container(
              padding: const EdgeInsets.all(KidSpace.lg),
              decoration: BoxDecoration(
                color: KidColor.notNow.withOpacity(0.16),
                borderRadius: KidRadius.cardBorder,
              ),
              child: Text(
                goal.unavailableReason?.messageAr.isNotEmpty == true
                    ? goal.unavailableReason!.messageAr
                    : t('today.notNow'),
                style: KidText.body(context),
                textAlign: TextAlign.center,
              ),
            ),
        ],
      ),
    );
  }
}
