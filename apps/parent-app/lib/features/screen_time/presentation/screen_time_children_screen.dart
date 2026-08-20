import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/localization/locale_controller.dart';
import '../../family/presentation/child_picker.dart';
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
///     states about `progress` and `coach` — an objection that still stands,
///     and that those two answer through `ChildPicker`, which is this screen's
///     three-way resolution extracted so a third and fourth copy of it cannot
///     drift.
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
///
/// ---------------------------------------------------------------------------
/// AND IT NO LONGER OWNS THAT RESOLUTION. `ChildPicker` was extracted FROM this
/// screen for `progress` and `coach`, and this original caller was never
/// migrated — so the three-way rule, the `GET /children` row parsing, the
/// «drop a row with no id» guard and the error-state wording existed twice,
/// byte for byte. The copy is gone. What is left below is the only part that
/// was ever specific to screen time: its four sentences, its glyph, and the
/// screen a chosen child leads to.
class ScreenTimeChildrenScreen extends ConsumerWidget {
  const ScreenTimeChildrenScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return ChildPicker(
      title: t('screenTime.pickChildTitle'),
      hint: t('screenTime.pickChildHint'),
      errorTitle: t('screenTime.pickChildErrorTitle'),
      emptyTitle: t('screenTime.noChildrenTitle'),
      emptyBody: t('screenTime.noChildrenBody'),
      icon: Icons.phonelink_lock_outlined,
      childScreenBuilder: (childId, childName) => ScreenTimeOverviewScreen(
        childId: childId,
        childName: childName,
      ),
    );
  }
}
