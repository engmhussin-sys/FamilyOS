import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import 'screen_time_overview_screen.dart';

/// WHERE AN ID-LESS `abny://screen-time` LANDS.
///
/// ---------------------------------------------------------------------------
/// THE DECISION, AND THE REASONING BEHIND IT.
///
/// `abny://screen-time` carries NO id — the scheme has no id-bearing form for
/// this surface (`deepLinkSurfaceTakesId(screenTime) == false`), and the server
/// pins `notifications.data` identifier-free on purpose, so no link will ever
/// name a child. Screen time, however, is configured PER CHILD: every route on
/// the surface is `/children/:childId/…`. So the link names a surface whose
/// every screen needs an argument the link cannot carry.
///
/// This screen is the answer, and it resolves in one of two ways depending on
/// the family — not on a guess:
///
///   * MORE THAN ONE CHILD → the CHILD LIST. Picking one of several children
///     on the parent's behalf would be this client inventing the thing the
///     server declined to say, which is the same objection `deep_link_router`
///     already states about `progress` and `coach`.
///
///   * EXACTLY ONE CHILD → that child's overview, directly. This is NOT the
///     same act: with one child there is only one possible referent, so the
///     destination is DETERMINED BY THE FAMILY'S DATA rather than chosen by
///     this client. Making a parent with one child tap through a one-item list
///     would be ceremony, not honesty. It is rendered by RETURNING the overview
///     widget rather than by pushing a route, so `resolve` stays pure, the back
///     button still has exactly one thing to pop, and nothing navigates as a
///     side effect of a network read landing.
///
///   * NO CHILDREN → an empty state that says so and points at adding one.
///
/// ---------------------------------------------------------------------------
/// WHAT THIS CHANGES FOR THE FOUR DEVICE ALERTS, STATED HONESTLY.
///
/// `notification-destination.ts` emits `abny://screen-time` for two different
/// kinds of thing: `safetyDestination` degrades to it when no `alertId` exists
/// (`PROTECTION_BYPASS_ATTEMPT`, `ACCESSIBILITY_DISABLED`, `POLICY_VIOLATION`,
/// `CHILD_WELLBEING_CHECKIN`), and `DAILY_GOAL_COMPLETED` / `HYDRATION_REMINDER`
/// name it directly. Until now every one of those landed on `SafetyScreen`,
/// because a screen-time screen did not exist.
///
/// It does now, and the surface the link is NAMED for is the truthful landing.
/// The safety feed did not go anywhere: `abny://safety/<alertId>` still opens
/// it with the alert selected, `AppRoutes.safety` is still registered, and the
/// dashboard still links to it. The four alerts arrive in the inbox regardless,
/// which is where their own text is.
class ScreenTimeChildrenScreen extends ConsumerWidget {
  const ScreenTimeChildrenScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final children = ref.watch(familyChildrenProvider);

    return children.when(
      loading: () => Scaffold(
        appBar: AppBar(title: Text(t('screenTime.pickChildTitle'))),
        body: DsLoadingState(label: t('common.loading')),
      ),
      error: (error, _) => Scaffold(
        appBar: AppBar(title: Text(t('screenTime.pickChildTitle'))),
        body: DsErrorState(
          // `familyChildrenProvider` is a plain `FutureProvider` over the
          // existing `DashboardApi`, so its error arrives as a raw `Object`
          // rather than the `ApiFailure` a repository-backed controller
          // produces. `ApiFailure.from` already knows how to read the B3
          // envelope out of an `ApiException`, so `messageAr` survives the
          // crossing — and a non-envelope error becomes the reviewed
          // «تعذّر إتمام الطلب» sentence rather than transport text.
          failure: ApiFailure.from(error),
          title: t('screenTime.pickChildErrorTitle'),
          retryLabel: t('common.retry'),
          requestIdLabel: t('common.requestId'),
          arabic: locale.isRtl,
          onRetry: () => ref.invalidate(familyChildrenProvider),
        ),
      ),
      data: (rows) {
        final entries = rows
            .whereType<Map<String, dynamic>>()
            .map(_ChildEntry.fromRow)
            .where((entry) => entry.id.isNotEmpty)
            .toList();

        if (entries.isEmpty) {
          return Scaffold(
            appBar: AppBar(title: Text(t('screenTime.pickChildTitle'))),
            body: DsEmptyState(
              title: t('screenTime.noChildrenTitle'),
              body: t('screenTime.noChildrenBody'),
              icon: Icons.family_restroom_outlined,
            ),
          );
        }

        // EXACTLY ONE CHILD — see the header. The overview IS this route.
        if (entries.length == 1) {
          return ScreenTimeOverviewScreen(
            childId: entries.first.id,
            childName: entries.first.name,
          );
        }

        return Scaffold(
          appBar: AppBar(title: Text(t('screenTime.pickChildTitle'))),
          body: ListView(
            padding: DsSpace.screen,
            children: [
              Text(t('screenTime.pickChildHint'), style: DsText.caption(context)),
              DsSpace.gapMd,
              for (final entry in entries)
                DsCard(
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => ScreenTimeOverviewScreen(
                        childId: entry.id,
                        childName: entry.name,
                      ),
                    ),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.phonelink_lock_outlined, color: DsColor.accent),
                      DsSpace.hGapMd,
                      Expanded(
                        child: Text(
                          entry.name.isEmpty ? t('childDetail.unnamed') : entry.name,
                          style: DsText.cardTitle(context),
                        ),
                      ),
                      DsIcons.disclosure(context),
                    ],
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

/// The two fields this screen needs off a `GET /children` row. Parsed rather
/// than indexed at the call site, so a row missing `firstName` is a child with
/// a blank name instead of a `TypeError` three widgets deep.
class _ChildEntry {
  const _ChildEntry({required this.id, required this.name});

  final String id;
  final String name;

  static _ChildEntry fromRow(Map<String, dynamic> row) {
    final first = row['firstName']?.toString() ?? '';
    final last = row['lastName']?.toString() ?? '';
    return _ChildEntry(
      id: row['id']?.toString() ?? '',
      name: '$first $last'.trim(),
    );
  }
}
