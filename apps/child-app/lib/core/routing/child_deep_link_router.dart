import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/family_growth/presentation/my_growth_screen.dart';
import '../../features/goals/domain/child_goal.dart';
import '../../features/goals/presentation/goal_detail_screen.dart';
import '../di/providers.dart';
import 'child_home_tab.dart';
import 'deep_link.dart';

/// DESTINATION → THE SCREEN A CHILD ACTUALLY HAS.
///
/// [ChildDeepLinkRouter.resolve] is a pure function and is where the whole map
/// lives, so «where does `abny://approval/<id>` land for a child?» is answered
/// by reading one switch rather than by tracing a tap through three widgets.
/// [follow] is the only part that touches a [Navigator], and it does nothing
/// [resolve] did not already decide.
///
/// ---------------------------------------------------------------------------
/// MOST CHILD DESTINATIONS ARE TABS, NOT ROUTES. The child's home is
/// `ChildHomeShell`: today · rewards · progress · coach in an `IndexedStack`,
/// with `MyGrowthScreen` and `DeviceHomeScreen` behind two app-bar icons.
/// Pushing `MyRewardsScreen` for `abny://rewards` would put a second, tab-less
/// copy of a tab on top of the shell — so this router SELECTS the tab
/// (`childHomeTabProvider`) and pops back to the shell instead. There is one
/// navigation system in this app and this file does not add a second.
///
/// ---------------------------------------------------------------------------
/// THE PARENT-ONLY SURFACES, AND WHY EACH LANDS WHERE IT DOES. The server
/// already refuses to send a child-audience notification to a parent-only
/// surface (`resolveNotificationDestination` enforces that as its rule 3), so
/// nothing below should ever arrive. It is mapped anyway, because «should never
/// arrive» is not a routing strategy and a blank screen or a crash is the one
/// outcome this whole file exists to remove:
///
///   * `approvals`, `approval/<id>` — the queue where a PARENT decides whether
///     a child's work counts. A child must never be shown an approval queue;
///     the honest child-side answer to «your work is with a grown-up» is their
///     own goals, so both land on the today tab. (What the child needs to know
///     about a submission of theirs is already said, in the server's own
///     sentence, on the attempt itself.)
///   * `subscription` — billing. Not a child's screen in any product, and there
///     is no child equivalent to soften it into. Today tab.
///   * `child/<id>` — one child's detail page in the PARENT's app. This app is
///     single-child by construction: the only child it can show is the one
///     holding the phone, and their own surface is home. Today tab.
///   * `safety/<id>` — a safety alert row. There is no child-facing safety
///     alert screen and there should not be one: an alert is a conversation
///     between the product and a parent, and showing a child a row that says
///     something was flagged about them is punitive by construction (CONTEXT §3
///     principle 7). Today tab.
///
/// Every one of those is the CHILD'S HOME, never a parent concept, never a
/// blank screen, never a crash.
///
/// ---------------------------------------------------------------------------
/// THE TWO NON-OBVIOUS CHILD MAPPINGS:
///
///   * `screen-time` → `MyGrowthScreen`. The one copy key that sends a CHILD
///     here is `HYDRATION_REMINDER` («وقت شرب المياه»), and this app's hydration
///     log, activity minutes and health progress all live on that screen — the
///     device-status console behind the settings icon shows battery and
///     permissions and answers a question no child asked.
///   * `notifications` (the universal fallback) → `MyGrowthScreen` as well.
///     That screen's «رسايل» section IS the child's inbox — it is where the
///     `/self/messages` rows this router is invoked from are rendered — so the
///     fallback lands on the notification itself, exactly as the server's own
///     `NOTIFICATION_INBOX_LINK` intends.
class ChildDeepLinkRouter {
  const ChildDeepLinkRouter._();

  /// The route name for the pushed `MyGrowthScreen`, shared with
  /// `ChildHomeShell`'s app-bar push. Named rather than anonymous so [follow]
  /// can tell «already on this screen» from «not there yet» and skip a
  /// pop-and-push that would flicker the screen the child is already reading.
  static const String myGrowthRouteName = 'child/my-growth';

  /// PURE. No context, no navigator, no side effect — which is what makes the
  /// whole map testable without pumping a widget.
  static ChildDeepLinkRoute resolve(DeepLinkDestination destination) {
    switch (destination.surface) {
      case DeepLinkSurface.goals:
        return const ChildDeepLinkRoute(ChildHomeTab.today);

      case DeepLinkSurface.goal:
        // The goal list is the today tab either way; the id is a best-effort
        // extra that [follow] uses only if that exact goal is already loaded.
        // See [_goalFor] for why it is never fetched here.
        return ChildDeepLinkRoute(ChildHomeTab.today, goalId: destination.id);

      case DeepLinkSurface.rewards:
        return const ChildDeepLinkRoute(ChildHomeTab.rewards);

      case DeepLinkSurface.progress:
        return const ChildDeepLinkRoute(ChildHomeTab.progress);

      case DeepLinkSurface.coach:
        return const ChildDeepLinkRoute(ChildHomeTab.coach);

      case DeepLinkSurface.screenTime:
      case DeepLinkSurface.notifications:
        return const ChildDeepLinkRoute(
          ChildHomeTab.today,
          screen: ChildDeepLinkScreen.myGrowth,
        );

      // --- Meaningless or unreachable for a child. See the header. ---
      case DeepLinkSurface.approvals:
      case DeepLinkSurface.approval:
      case DeepLinkSurface.subscription:
      case DeepLinkSurface.child:
      case DeepLinkSurface.safety:
        return const ChildDeepLinkRoute(ChildHomeTab.today);
    }
  }

  /// Parse and resolve in one step, for a caller holding the raw string.
  static ChildDeepLinkRoute resolveLink(String? link) =>
      resolve(parseDeepLink(link));

  /// THE ONLY PLACE A DEEP LINK TOUCHES A NAVIGATOR.
  ///
  /// Synchronous and fire-and-forget on purpose: a tap must move now, and the
  /// caller must not be made to await a route that only completes when the
  /// child pops back.
  static void follow(
    BuildContext context,
    WidgetRef ref,
    DeepLinkDestination destination,
  ) {
    final route = resolve(destination);

    // The tab first, and unconditionally: whatever this method does with the
    // navigator afterwards, the shell underneath is now showing the tab the
    // link named.
    ref.read(childHomeTabProvider.notifier).state = route.tab;

    final navigator = Navigator.of(context);
    final currentRouteName = ModalRoute.of(context)?.settings.name;

    if (route.screen == ChildDeepLinkScreen.myGrowth) {
      // Tapping a message card whose link points back at the inbox must not
      // rebuild the screen the child is reading.
      if (currentRouteName == myGrowthRouteName) return;
      navigator.popUntil((r) => r.isFirst);
      navigator.push(
        MaterialPageRoute<void>(
          builder: (_) => const MyGrowthScreen(),
          settings: const RouteSettings(name: myGrowthRouteName),
        ),
      );
      return;
    }

    // Read BEFORE popping. `ref` belongs to the widget that was tapped, and
    // that widget is on the route about to be popped — reading through it
    // afterwards would be reading through something on its way out.
    final goal = _goalFor(ref, route.goalId);

    // Back to the shell, where every tab lives.
    navigator.popUntil((r) => r.isFirst);

    if (goal != null) {
      navigator.push(
        MaterialPageRoute<void>(
          builder: (_) => GoalDetailScreen(goal: goal),
          // The canonical link as the route name: it is what a crash report or
          // a `RouteObserver` will show, and it is exactly the string the
          // server sent.
          settings: RouteSettings(name: destination.uri),
        ),
      );
    }
  }

  /// Parse-and-go, for a caller holding the raw link off a payload.
  static void followLink(BuildContext context, WidgetRef ref, String? link) =>
      follow(context, ref, parseDeepLink(link));

  /// THE ENTRY POINT A FUTURE PUSH HANDLER CALLS.
  ///
  /// It takes the whole payload — an in-app message row from
  /// `/self/messages`, or a raw FCM `data` map — because both carry the link
  /// under the same key and [deepLinkFromNotification] already accepts both
  /// shapes. This app has no push DELIVERY yet (FCM token acquisition is not
  /// built, deliberately), and when it arrives it calls THIS, not a second
  /// resolver of its own: two resolvers is how a client starts disagreeing with
  /// its server about where a tap lands.
  static void followNotification(
    BuildContext context,
    WidgetRef ref,
    Object? notification,
  ) =>
      followLink(context, ref, deepLinkFromNotification(notification));

  /// The loaded goal with this id, or `null`.
  ///
  /// DELIBERATELY A LOOKUP AND NEVER A FETCH. `GoalDetailScreen` needs a whole
  /// [TodayGoal] — the Arabic target sentence, the duration, the reward, the
  /// availability answer the server already computed — and none of that can be
  /// invented from an id. Today's list is the only place those exist on this
  /// device, so: if the goal the link names is already in it, the child lands
  /// ON the goal; if the list has not loaded yet (a cold start from a push) or
  /// the goal is not in today's set, they land on the today tab, which loads
  /// the list and shows it. A tap that opens the goal list is a truthful
  /// outcome; a spinner on a screen that may never resolve is not.
  static TodayGoal? _goalFor(WidgetRef ref, String? goalId) {
    if (goalId == null) return null;
    final goals = ref.read(todayGoalsControllerProvider).valueOrNull;
    if (goals == null) return null;
    for (final goal in goals) {
      if (goal.programId == goalId) return goal;
    }
    return null;
  }
}

/// The screens this router can push ON TOP of the shell. Two values because
/// there are two: everything else in the child app is a tab.
enum ChildDeepLinkScreen {
  /// Stay on the shell; the tab is the destination.
  none,

  /// «نموّي» — messages, health, learning, habits and faith.
  myGrowth,
}

/// WHERE ONE LINK LANDS, as data. Comparable so a test can assert a map entry
/// without pumping a widget.
class ChildDeepLinkRoute {
  const ChildDeepLinkRoute(
    this.tab, {
    this.screen = ChildDeepLinkScreen.none,
    this.goalId,
  });

  /// The tab the shell shows underneath — always set, because the shell is
  /// always underneath.
  final ChildHomeTab tab;

  /// A screen pushed on top of the shell, or [ChildDeepLinkScreen.none].
  final ChildDeepLinkScreen screen;

  /// Best-effort: the goal `abny://goal/<id>` named. Non-null only for that
  /// surface, and honoured only when that goal is already loaded.
  final String? goalId;

  /// Value equality WITHOUT `operator ==` — same reason as
  /// [DeepLinkDestination.matches]: `scripts/dart_preflight.py` cannot parse an
  /// operator declaration, and equality on this type is wanted only in tests.
  bool matches(ChildDeepLinkRoute other) =>
      other.tab == tab && other.screen == screen && other.goalId == goalId;

  @override
  String toString() =>
      'ChildDeepLinkRoute(${tab.name}, screen: ${screen.name}, goalId: $goalId)';
}
