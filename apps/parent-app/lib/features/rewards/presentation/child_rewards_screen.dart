import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../application/child_rewards_controller.dart';
import '../domain/fulfilment.dart';

/// WHAT THIS CHILD HAS EARNED — the ledger balance, the live screen-time
/// grants, and the record of completed goals.
///
/// THREE ENDPOINTS, ONE SCREEN:
///   * `GET /life-intelligence/rewards/:childId/account` — the points
///     balance. REUSED, not rebuilt: F4's `POINTS` writes to the same
///     ledger via `REWARD_TYPE_TO_LEDGER: POINTS -> XP`, so this is the
///     one number, labelled «نقطة». Audit PA-M-006 warned about showing
///     two competing balances; this screen shows one.
///   * `GET /reward-programs/screen-time-grants/:childId` (+ `DELETE`).
///   * `GET /reward-programs/fulfilments`, filtered to this child.
///   * `GET /reward-programs/achievements?childId=` and
///     `GET /reward-programs/streaks/:childId` — both added by the backend
///     agent in B5 while this screen was being written. The audit's words
///     about the first were «`listForChild` موجودة بلا route والد»; until it
///     landed, "completed goals" had to be inferred from fulfilment rows,
///     which only exist for fulfillable reward types. It is now read
///     directly, and the inference is gone.
class ChildRewardsScreen extends ConsumerWidget {
  const ChildRewardsScreen({super.key, required this.childId, this.childName});

  final String childId;
  final String? childName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(childRewardsControllerProvider(childId));
    final controller = ref.read(childRewardsControllerProvider(childId).notifier);
    final now = DateTime.now();

    return Scaffold(
      appBar: AppBar(
        title: Text(childName == null
            ? t('childRewards.title')
            : t('childRewards.titleForChild', options: {'name': childName!})),
      ),
      body: RefreshIndicator(
        onRefresh: controller.load,
        child: DsStateView<ChildRewardsSnapshot>(
          state: state.snapshot,
          arabic: locale.isRtl,
          loadingLabel: t('common.loading'),
          emptyTitle: t('childRewards.emptyTitle'),
          emptyBody: t('childRewards.emptyBody'),
          emptyIcon: Icons.emoji_events_outlined,
          errorTitle: t('childRewards.errorTitle'),
          retryLabel: t('common.retry'),
          requestIdLabel: t('common.requestId'),
          onRetry: controller.load,
          builder: (context, snapshot) => ListView(
            padding: DsSpace.screen,
            children: [
              if (state.actionFailure != null) ...[
                DsErrorState(
                  failure: state.actionFailure!,
                  title: t('childRewards.actionFailedTitle'),
                  retryLabel: t('common.dismiss'),
                  requestIdLabel: t('common.requestId'),
                  arabic: locale.isRtl,
                  compact: true,
                  onRetry: controller.clearFailure,
                ),
                DsSpace.gapLg,
              ],
              DsSectionHeader(
                title: t('childRewards.pointsSection'),
                subtitle: t('childRewards.pointsHint'),
              ),
              if (snapshot.account == null)
                DsCard(child: Text(t('childRewards.pointsUnavailable'), style: DsText.caption(context)))
              else
                DsCard(
                  accent: DsColor.accent,
                  child: Column(
                    children: [
                      DsKeyValueRow(
                        label: t('childRewards.points'),
                        value: snapshot.account!.xp.toString(),
                        valueColor: DsColor.accent,
                      ),
                      DsKeyValueRow(
                        label: t('childRewards.level'),
                        value: snapshot.account!.level.toString(),
                      ),
                    ],
                  ),
                ),
              DsSectionHeader(
                title: t('childRewards.screenTimeSection'),
                subtitle: t('childRewards.screenTimeHint'),
                trailing: DsBadge(
                  label: t('childRewards.activeBonus',
                      options: {'count': snapshot.activeBonusMinutes(now)}),
                  color: DsColor.accent,
                ),
              ),
              if (snapshot.grants.isEmpty)
                DsCard(child: Text(t('childRewards.noGrants'), style: DsText.caption(context)))
              else
                for (final grant in snapshot.grants)
                  _GrantCard(
                    grant: grant,
                    now: now,
                    busy: state.busyGrantId == grant.id,
                    onRevoke: () => _confirmRevoke(context, t, controller, grant.id),
                  ),
              if (snapshot.streaks.isNotEmpty) ...[
                DsSectionHeader(
                  title: t('childRewards.streaksSection'),
                  subtitle: t('childRewards.streaksHint'),
                ),
                DsCard(
                  child: Column(
                    children: [
                      for (final entry in snapshot.streaks.entries)
                        DsKeyValueRow(
                          label: t('streak.${entry.key}'),
                          value: t('childRewards.streakDays', options: {'count': entry.value}),
                          valueColor: entry.value > 0 ? DsColor.stateSuccess : null,
                        ),
                    ],
                  ),
                ),
              ],
              DsSectionHeader(
                title: t('childRewards.completedSection'),
                subtitle: t('childRewards.completedHint'),
              ),
              if (snapshot.verifiedAchievements.isEmpty)
                DsCard(child: Text(t('childRewards.noCompleted'), style: DsText.caption(context)))
              else
                for (final row in snapshot.verifiedAchievements)
                  DsCard(
                    padding: const EdgeInsets.all(DsSpace.md),
                    accent: DsColor.stateSuccess,
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            row.localDate ?? t('reviewQueue.unnamedGoal'),
                            style: DsText.body(context),
                            textDirection: TextDirection.ltr,
                          ),
                        ),
                        if (row.grantedAmount != null)
                          DsBadge(
                            label: t('childRewards.granted',
                                options: {'count': row.grantedAmount!}),
                            color: DsColor.accent,
                            icon: Icons.star_rounded,
                          ),
                        if (row.appliedMultiplierBps != null &&
                            row.appliedMultiplierBps! > 10000) ...[
                          DsSpace.hGapSm,
                          DsBadge(
                            label: t('programDetail.multiplierValue',
                                options: {'value': row.multiplierLabel}),
                            icon: Icons.local_fire_department_rounded,
                            color: DsColor.warn,
                          ),
                        ],
                      ],
                    ),
                  ),
              DsSectionHeader(
                title: t('childRewards.earnedSection'),
                subtitle: t('childRewards.earnedHint'),
              ),
              if (snapshot.fulfilments.isEmpty)
                DsCard(child: Text(t('childRewards.noEarned'), style: DsText.caption(context)))
              else
                for (final row in snapshot.fulfilments)
                  DsCard(
                    padding: const EdgeInsets.all(DsSpace.md),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            row.description.isEmpty
                                ? t('rewardType.${row.rewardType}')
                                : row.description,
                            style: DsText.body(context),
                          ),
                        ),
                        DsBadge(label: t('fulfilmentStatus.${row.status}')),
                      ],
                    ),
                  ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _confirmRevoke(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ChildRewardsController controller,
    String grantId,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(t('childRewards.revokeConfirmTitle')),
        content: Text(t('childRewards.revokeConfirmBody')),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(t('common.cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(t('childRewards.revoke')),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.revokeGrant(grantId);
  }
}

class _GrantCard extends ConsumerWidget {
  const _GrantCard({
    required this.grant,
    required this.now,
    required this.busy,
    required this.onRevoke,
  });

  final ScreenTimeGrant grant;
  final DateTime now;
  final bool busy;
  final VoidCallback onRevoke;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(localeControllerProvider.notifier).t;
    final active = grant.isActiveAt(now);
    return DsCard(
      accent: active ? DsColor.stateSuccess : DsColor.stateMuted,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  t('childRewards.bonusMinutes', options: {'count': grant.minutes}),
                  style: DsText.cardTitle(context),
                ),
              ),
              DsBadge(
                label: grant.isRevoked
                    ? t('childRewards.grantRevoked')
                    : active
                        ? t('childRewards.grantActive')
                        : t('childRewards.grantExpired'),
                color: active ? DsColor.stateSuccess : DsColor.stateMuted,
              ),
            ],
          ),
          if (grant.expiresAt != null) ...[
            DsSpace.gapXs,
            Text(
              t('childRewards.grantExpiresAt',
                  options: {'date': grant.expiresAt!.toLocal().toString().substring(0, 16)}),
              style: DsText.caption(context),
            ),
          ],
          if (active) ...[
            DsSpace.gapMd,
            DsSecondaryButton(
              label: t('childRewards.revoke'),
              icon: Icons.remove_circle_outline_rounded,
              danger: true,
              onPressed: busy ? null : onRevoke,
            ),
          ],
        ],
      ),
    );
  }
}
