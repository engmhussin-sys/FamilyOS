import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../application/screen_time_overview_controller.dart';
import '../domain/screen_time_policy.dart';
import 'blocked_apps_screen.dart';
import 'screen_time_grant_row.dart';
import 'screen_time_policy_editor_screen.dart';

/// ONE CHILD'S SCREEN TIME — THE SCREEN THIS APP DID NOT HAVE.
///
/// The backend has shipped a complete Screen Time API since Sprint 4 and this
/// app had no `features/screen_time/` directory at all: `abny://screen-time`
/// fell through to the safety feed, and a parent who wanted to change a daily
/// limit had nowhere to go. Screen time is a headline feature of this product
/// and it was unreachable from the phone.
///
/// ---------------------------------------------------------------------------
/// THE TWO NUMBERS, AND WHY BOTH ARE ON SCREEN.
///
///   * `GET /children/:childId/screen-time-policy` — what the parent CONFIGURED.
///   * `GET /children/:childId/screen-time-policy/effective` — what the device
///     ENFORCES today: the same limit PLUS the bonus minutes the child earned
///     and has not used up (`ScreenTimeService.getEffectivePolicy`:
///     `effective = base + Σ(active bonus grants)`).
///
/// Showing only the effective number would attribute a child's earned reward to
/// the parent's setting, and the parent would then be surprised by what the
/// edit form contains. Showing only the configured one would hide the minutes
/// the device is actually allowing. So both are here, the DIFFERENCE is named
/// («+30 دقيقة مكتسبة اليوم»), and each earned grant is listed with its own
/// expiry so «why is today different» has a visible answer.
///
/// THE ONE CASE WHERE THE REWARD BUYS NOTHING is stated rather than hidden: if
/// the parent set no daily limit, the allowance is already unlimited and the
/// server keeps `effectiveDailyLimitMinutes` null instead of inventing a cap.
/// The screen says so.
class ScreenTimeOverviewScreen extends ConsumerWidget {
  const ScreenTimeOverviewScreen({super.key, required this.childId, this.childName});

  /// Opaque, and never an authorization claim — it says only which row the
  /// next call will ASK for. `assertChildBelongsToFamily` decides whether this
  /// parent may have it, from the family on their access token.
  final String childId;

  final String? childName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(screenTimeOverviewControllerProvider(childId));
    final controller = ref.read(screenTimeOverviewControllerProvider(childId).notifier);

    return Scaffold(
      appBar: AppBar(
        title: Text(childName == null || childName!.isEmpty
            ? t('screenTime.title')
            : t('screenTime.titleForChild', options: {'name': childName!})),
      ),
      body: RefreshIndicator(
        onRefresh: controller.load,
        child: DsStateView<ScreenTimeOverview>(
          state: state,
          arabic: locale.isRtl,
          loadingLabel: t('common.loading'),
          skeletonHero: true,
          // EMPTY IS NOT AN ERROR. No policy row and no earned bonus is a real,
          // common answer for a family that has not configured anything yet —
          // and the action that fixes it is one tap away, right here.
          emptyTitle: t('screenTime.emptyTitle'),
          emptyBody: t('screenTime.emptyBody'),
          emptyIcon: Icons.phonelink_lock_outlined,
          emptyActionLabel: t('screenTime.setPolicy'),
          onEmptyAction: () => _openEditor(context, ref),
          errorTitle: t('screenTime.errorTitle'),
          retryLabel: t('common.retry'),
          requestIdLabel: t('common.requestId'),
          onRetry: controller.load,
          builder: (context, overview) => _OverviewBody(
            childId: childId,
            childName: childName,
            overview: overview,
            onEdit: () => _openEditor(context, ref),
          ),
        ),
      ),
    );
  }

  Future<void> _openEditor(BuildContext context, WidgetRef ref) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => ScreenTimePolicyEditorScreen(
          childId: childId,
          childName: childName,
        ),
      ),
    );
    if (changed == true) {
      // The policy row was REPLACED server-side, so the effective allowance
      // changed too — both reads are re-run rather than patched locally.
      await ref.read(screenTimeOverviewControllerProvider(childId).notifier).load();
    }
  }
}

class _OverviewBody extends ConsumerWidget {
  const _OverviewBody({
    required this.childId,
    required this.childName,
    required this.overview,
    required this.onEdit,
  });

  final String childId;
  final String? childName;
  final ScreenTimeOverview overview;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;
    final effective = overview.effective;
    final policy = overview.policy;

    return ListView(
      padding: DsSpace.screen,
      children: [
        // --- today, the number the device actually enforces -----------------
        DsHeroPanel(
          label: t('screenTime.todayLabel'),
          value: effective.hasNoLimit
              ? t('screenTime.noLimitValue')
              : t('common.minutesValue',
                  options: {'count': effective.effectiveDailyLimitMinutes!}),
          base: DsColor.accent,
          icon: Icons.hourglass_bottom_rounded,
          footnote: effective.hasNoLimit
              ? t('screenTime.noLimitFootnote')
              : t('screenTime.todayFootnote'),
        ),
        DsSpace.gapLg,

        // --- configured vs effective, and the difference named --------------
        DsSectionHeader(
          title: t('screenTime.allowanceSection'),
          subtitle: t('screenTime.allowanceHint'),
        ),
        DsCard(
          accent: effective.hasBonus ? DsColor.stateSuccess : DsColor.stateMuted,
          child: Column(
            children: [
              DsKeyValueRow(
                label: t('screenTime.configuredLimit'),
                value: effective.baseDailyLimitMinutes == null
                    ? t('screenTime.noLimitValue')
                    : t('common.minutesValue',
                        options: {'count': effective.baseDailyLimitMinutes!}),
              ),
              DsKeyValueRow(
                label: t('screenTime.earnedBonus'),
                value: t('common.minutesValue',
                    options: {'count': effective.bonusMinutes}),
                valueColor:
                    effective.hasBonus ? DsColor.stateSuccess : null,
              ),
              DsKeyValueRow(
                label: t('screenTime.effectiveLimit'),
                value: effective.hasNoLimit
                    ? t('screenTime.noLimitValue')
                    : t('common.minutesValue',
                        options: {'count': effective.effectiveDailyLimitMinutes!}),
                valueColor: DsColor.accent,
              ),
              DsSpace.gapSm,
              Text(
                effective.hasNoLimit
                    ? t('screenTime.differenceNoLimit')
                    : effective.hasBonus
                        ? t('screenTime.differenceExplained', options: {
                            'base': effective.baseDailyLimitMinutes ?? 0,
                            'bonus': effective.bonusMinutes,
                            'total': effective.effectiveDailyLimitMinutes ?? 0,
                          })
                        : t('screenTime.differenceNone'),
                style: DsText.caption(context),
              ),
            ],
          ),
        ),

        // --- WHY today is different: one row per earned grant ---------------
        if (effective.bonusGrants.isNotEmpty) ...[
          DsSectionHeader(
            title: t('screenTime.grantsSection'),
            subtitle: t('screenTime.grantsHint'),
          ),
          // THE SHARED ROW. Every grant in `bonusGrants` is one the SERVER
          // counts right now — the route returns no revoked and no expired row
          // — so the standing is not a guess this screen is making.
          for (final grant in effective.bonusGrants)
            ScreenTimeGrantRow(
              grant: grant,
              standing: GrantStanding.active,
            ),
        ],

        // --- the configured policy in full ----------------------------------
        DsSectionHeader(
          title: t('screenTime.policySection'),
          subtitle: t('screenTime.policyHint'),
        ),
        if (policy == null)
          // «WE COULD NOT READ IT» AND «IT IS NOT SET» ARE DIFFERENT
          // SENTENCES. Rendering the second when the first is true would be a
          // false statement about the parent's own configuration — and one
          // they might act on by setting a policy that already exists.
          DsCard(
            child: Text(
              overview.configuredFailed
                  ? t('screenTime.policyUnavailable')
                  : t('screenTime.noPolicy'),
              style: DsText.caption(context),
            ),
          )
        else
          DsCard(
            child: Column(
              children: [
                DsKeyValueRow(
                  label: t('screenTime.dailyLimit'),
                  value: policy.dailyLimitMinutes == null
                      ? t('screenTime.noLimitValue')
                      : t('common.minutesValue',
                          options: {'count': policy.dailyLimitMinutes!}),
                ),
                DsKeyValueRow(
                  label: t('screenTime.bedtime'),
                  value: policy.hasBedtime
                      ? t('screenTime.bedtimeRange', options: {
                          'start': policy.bedtimeStart!,
                          'end': policy.bedtimeEnd!,
                        })
                      : t('screenTime.bedtimeNotSet'),
                ),
                DsKeyValueRow(
                  label: t('screenTime.focusMode'),
                  value: policy.focusModeEnabled ? t('common.yes') : t('common.no'),
                ),
                if (policy.hasWeekdaySchedule) ...[
                  DsSpace.gapSm,
                  Text(t('screenTime.weekdayScheduleNote'), style: DsText.caption(context)),
                ],
              ],
            ),
          ),
        DsSpace.gapMd,
        DsPrimaryButton(
          label: policy == null ? t('screenTime.setPolicy') : t('screenTime.editPolicy'),
          icon: Icons.tune_rounded,
          onPressed: onEdit,
        ),
        DsSpace.gapLg,

        // --- onward: blocked apps -------------------------------------------
        DsSectionHeader(
          title: t('blockedApps.sectionTitle'),
          subtitle: t('blockedApps.sectionHint'),
        ),
        DsCard(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => BlockedAppsScreen(childId: childId, childName: childName),
            ),
          ),
          child: Row(
            children: [
              const Icon(Icons.block_rounded, color: DsColor.accent),
              DsSpace.hGapMd,
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(t('blockedApps.title'), style: DsText.cardTitle(context)),
                    DsSpace.gapXs,
                    Text(t('blockedApps.entryHint'), style: DsText.caption(context)),
                  ],
                ),
              ),
              DsIcons.disclosure(context),
            ],
          ),
        ),
        DsSpace.gapLg,
        Text(t('screenTime.footnote'), style: DsText.caption(context)),
      ],
    );
  }
}
