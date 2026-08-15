import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../domain/child_rewards.dart';

/// «جوايزي» — `GET /self/achievements/rewards`.
///
/// The F4 view of what this child has earned: bonus screen-time minutes
/// still alive, and the physical / privilege / custom rewards waiting on a
/// parent's hand.
///
/// THIS IS A SECOND, SEPARATE SCREEN FROM `rewards_screen.dart`, and that
/// is a deliberate, temporary state. The older screen consumes the
/// coins/XP store (`/life-intelligence/self/rewards/*`) and audit PA-M-006
/// flagged the risk of the child seeing two economies. The bridge already
/// exists in the data (F4 `POINTS` writes to the same ledger as `XP`), so
/// the two surfaces agree on the number; merging the two SCREENS is a
/// product decision, not a technical one, and it is listed as deferred
/// rather than made silently here.
class MyRewardsScreen extends ConsumerWidget {
  const MyRewardsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(childRewardsControllerProvider);
    final controller = ref.read(childRewardsControllerProvider.notifier);
    final now = DateTime.now();

    return RefreshIndicator(
      onRefresh: controller.load,
      child: KidStateView<ChildRewardsSnapshot>(
        state: state,
        arabic: locale.isRtl,
        loadingLabel: t('myRewards.loading'),
        emptyTitle: t('myRewards.emptyTitle'),
        emptyBody: t('myRewards.emptyBody'),
        errorTitle: t('myRewards.errorTitle'),
        retryLabel: t('common.retry'),
        onRetry: controller.load,
        builder: (context, snapshot) => ListView(
          padding: KidSpace.screen,
          children: [
            KidSectionHeader(
              title: t('myRewards.bonusSection'),
              subtitle: t('myRewards.bonusHint'),
            ),
            KidStatTile(
              // Computed SERVER-SIDE over unexpired, unrevoked grants. The
              // client shows the number; it does not re-add the list.
              value: snapshot.activeBonusMinutes.toString(),
              label: t('myRewards.bonusMinutes'),
              icon: Icons.hourglass_bottom_rounded,
              color: KidColor.primary,
            ),
            KidSpace.gapMd,
            for (final grant in snapshot.grants)
              KidCard(
                padding: const EdgeInsets.all(KidSpace.md),
                dimmed: !grant.isActiveAt(now),
                accent: grant.isActiveAt(now) ? KidColor.done : null,
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        t('myRewards.grantMinutes', options: {'count': grant.minutes}),
                        style: KidText.cardTitle(context),
                      ),
                    ),
                    KidBadge(
                      label: grant.isActiveAt(now)
                          ? t('myRewards.grantActive')
                          : t('myRewards.grantFinished'),
                      color: grant.isActiveAt(now) ? KidColor.done : KidColor.mutedInk,
                    ),
                  ],
                ),
              ),
            KidSpace.gapLg,
            KidSectionHeader(
              title: t('myRewards.prizesSection'),
              subtitle: t('myRewards.prizesHint'),
            ),
            if (snapshot.fulfilments.isEmpty)
              KidCard(child: Text(t('myRewards.noPrizes'), style: KidText.body(context)))
            else
              for (final prize in snapshot.fulfilments)
                KidCard(
                  padding: const EdgeInsets.all(KidSpace.md),
                  accent: prize.isDelivered ? KidColor.done : KidColor.waiting,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        prize.description.isEmpty
                            ? t('rewardType.${prize.rewardType}')
                            : prize.description,
                        style: KidText.cardTitle(context),
                      ),
                      KidSpace.gapSm,
                      KidBadge(
                        label: prize.isDelivered
                            ? t('myRewards.prizeDelivered')
                            : t('myRewards.prizeWaiting'),
                        color: prize.isDelivered ? KidColor.done : KidColor.waiting,
                        icon: prize.isDelivered
                            ? Icons.check_circle_outline_rounded
                            : Icons.hourglass_empty_rounded,
                      ),
                    ],
                  ),
                ),
          ],
        ),
      ),
    );
  }
}
