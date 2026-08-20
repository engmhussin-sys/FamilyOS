import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../family_growth/presentation/rewards_screen.dart';
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
            // THE ONE LIVE NUMBER ON THIS SCREEN, AND IT IS THE SERVER'S.
            // Computed in `PrismaRewardProgramRepository.activeBonusMinutes`
            // over `revokedAt: null, expiresAt > now` at the SERVER's `now`.
            // The client shows it; it does not re-add the rows below, and —
            // since the row list is history and carries no live flag — it no
            // longer marks individual rows live or finished either. See
            // `ChildScreenTimeGrant`'s docstring for why the child's route
            // cannot answer that per row.
            if (snapshot.activeBonusMinutes == null)
              // NOT A ZERO. The server did not send the total, so the screen
              // says it could not read it rather than telling a child their
              // minutes are gone.
              KidCard(
                padding: const EdgeInsets.all(KidSpace.md),
                child: Row(
                  children: [
                    const Icon(
                      Icons.help_outline_rounded,
                      size: KidSize.iconSm,
                      color: KidColor.unknown,
                    ),
                    const SizedBox(width: KidSpace.sm),
                    Expanded(
                      child: Text(
                        t('myRewards.bonusUnknown'),
                        style: KidText.body(context),
                      ),
                    ),
                  ],
                ),
              )
            else
              KidStatTile(
                value: snapshot.activeBonusMinutes!.toString(),
                label: t('myRewards.bonusMinutes'),
                icon: Icons.hourglass_bottom_rounded,
                color: KidColor.primary,
              ),
            KidSpace.gapMd,
            if (snapshot.grants.isNotEmpty) ...[
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: KidSpace.sm),
                child: Text(
                  t('myRewards.grantsHistoryHint'),
                  style: KidText.caption(context),
                ),
              ),
              KidSpace.gapSm,
              for (final grant in snapshot.grants)
                KidCard(
                  padding: const EdgeInsets.all(KidSpace.md),
                  child: Text(
                    t('myRewards.grantMinutes', options: {'count': grant.minutes}),
                    style: KidText.cardTitle(context),
                  ),
                ),
            ],
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
                        // A prize with no description is named by its TYPE, and
                        // the type is a backend enum. `t` alone would render
                        // «rewardType.BADGE» — the key itself — for any of the
                        // three `RewardType` values this app had no sentence
                        // for, and for whatever the enum gains next.
                        prize.description.isEmpty
                            ? locale.tOrElse(
                                'rewardType.${prize.rewardType}',
                                t('rewardType.unknown'),
                              )
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

            // THE STORE, REACHABLE FROM THE REWARDS TAB AT LAST.
            //
            // `RewardsScreen` — the coins balance and the family store, i.e.
            // the ONLY place a child can actually SPEND what they earn — was
            // reachable from exactly one place in the whole app: the settings
            // icon → `DeviceHomeScreen` → a button in the middle of the
            // diagnostics console. That is the same defect PA-M-041 named
            // when it found the child's landing screen was a monitoring
            // console: the child-facing half of the product was filed behind
            // the device-facing half. Child MVP capability 4 («اختيار Goal /
            // Reward») was unreachable from the tab named "my rewards".
            //
            // This is a LINK, not a merge. The two screens read two endpoints
            // (`/self/achievements/rewards` and
            // `/life-intelligence/self/rewards/*`) and unifying them is the
            // product decision this file's header already records as
            // deferred. Making the store reachable is not that decision.
            KidSpace.gapLg,
            KidQuietButton(
              label: t('myRewards.openStore'),
              icon: Icons.storefront_rounded,
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const RewardsScreen()),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
