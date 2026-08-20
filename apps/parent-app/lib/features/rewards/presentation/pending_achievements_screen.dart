import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../application/achievements_controller.dart';
import '../domain/achievement.dart';
import 'achievement_review_screen.dart';

/// THE REVIEW QUEUE — `GET /reward-programs/achievements/pending`.
///
/// This is the parent's half of the flagship journey: the child submitted,
/// the server escalated (or the method never allowed auto-approval), and
/// nothing has been granted. Until a row here is decided, no ledger entry
/// exists and no notification claiming a reward has been sent — that
/// absence is structural in F4, not a UI convention.
///
/// NOT `pending_approvals_screen.dart`. That screen lists pending MESSAGES
/// (`/life-intelligence/communication/pending`) and audit P12 flagged the
/// name collision explicitly.
class PendingAchievementsScreen extends ConsumerWidget {
  const PendingAchievementsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(pendingAchievementsControllerProvider);
    final controller = ref.read(pendingAchievementsControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(
        title: Text(t('reviewQueue.title')),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            tooltip: t('common.retry'),
            onPressed: controller.load,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: controller.load,
        child: DsStateView<List<PendingReviewItem>>(
          state: state,
          arabic: locale.isRtl,
          loadingLabel: t('reviewQueue.loading'),
          emptyTitle: t('reviewQueue.emptyTitle'),
          emptyBody: t('reviewQueue.emptyBody'),
          emptyIcon: Icons.done_all_rounded,
          errorTitle: t('reviewQueue.errorTitle'),
          retryLabel: t('common.retry'),
          requestIdLabel: t('common.requestId'),
          onRetry: controller.load,
          builder: (context, items) => ListView(
            padding: DsSpace.screen,
            children: [
              Text(t('reviewQueue.intro'), style: DsText.caption(context)),
              DsSpace.gapLg,
              for (final item in items) _PendingCard(item: item, onReviewed: controller.load),
            ],
          ),
        ),
      ),
    );
  }
}

class _PendingCard extends ConsumerWidget {
  const _PendingCard({required this.item, required this.onReviewed});

  final PendingReviewItem item;
  final Future<void> Function() onReviewed;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(localeControllerProvider.notifier).t;
    final achievement = item.achievement;
    final pendingParent = achievement.status == AchievementStatuses.pendingParent;

    return DsCard(
      accent: DsColor.statePending,
      onTap: () async {
        final decided = await Navigator.of(context).push<bool>(
          MaterialPageRoute(
            builder: (_) => AchievementReviewScreen(
              achievementId: achievement.id,
              targetSummaryAr: item.targetSummaryAr,
            ),
          ),
        );
        if (decided == true) await onReviewed();
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            item.targetSummaryAr.isEmpty ? t('reviewQueue.unnamedGoal') : item.targetSummaryAr,
            style: DsText.cardTitle(context),
          ),
          DsSpace.gapSm,
          Wrap(
            spacing: DsSpace.sm,
            runSpacing: DsSpace.xs,
            children: [
              DsBadge(
                label: pendingParent
                    ? t('achievementStatus.PENDING_PARENT')
                    : t('achievementStatus.SUBMITTED'),
                color: DsColor.statePending,
              ),
              if (achievement.elapsedMinutes != null)
                DsBadge(
                  label: t('reviewQueue.elapsed',
                      options: {'count': achievement.elapsedMinutes!}),
                  icon: Icons.timer_outlined,
                ),
              if (achievement.localDate != null)
                DsBadge(label: achievement.localDate!, icon: Icons.event_outlined),
              DsBadge(
                label: t('reviewQueue.attemptNo', options: {'number': achievement.attemptNo}),
              ),
            ],
          ),
          DsSpace.gapMd,
          Text(t('reviewQueue.tapToReview'), style: DsText.caption(context)),
        ],
      ),
    );
  }
}
