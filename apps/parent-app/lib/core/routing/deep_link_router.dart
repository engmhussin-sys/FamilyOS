import 'package:flutter/material.dart';

import '../../features/rewards/presentation/achievement_review_screen.dart';
import '../../features/rewards/presentation/program_detail_screen.dart';
import 'app_routes.dart';
import 'deep_link.dart';

/// DESTINATION → THE SCREEN THAT ACTUALLY EXISTS.
///
/// [DeepLinkRouter.resolve] is a pure function and is where the whole map
/// lives, so "where does `abny://approval/<id>` land?" is answered by reading
/// one switch rather than by tracing a tap through three widgets. [follow] is
/// the only part that touches a [Navigator], and it does nothing [resolve] did
/// not already decide.
///
/// IT OBEYS `app_routes.dart`'S DISTINCTION, WHICH IS NOT A STYLE PREFERENCE.
/// Only ARGUMENT-FREE screens are named routes; the id-scoped ones are pushed
/// with a `MaterialPageRoute` carrying a real constructor argument. Forcing
/// `ProgramDetailScreen` into the named table would mean smuggling the id
/// through `settings.arguments` as an untyped `Object` and casting it back at
/// the far end — a runtime cast in an app that has never run an analyser. The
/// two kinds are therefore two kinds here as well, and [DeepLinkRoute] names
/// them.
///
/// ---------------------------------------------------------------------------
/// WHAT [DeepLinkRouteKind.unavailable] MEANS, stated plainly because five of
/// the twelve surfaces are in it today: THIS APP HAS NO SCREEN THIS DESTINATION
/// CAN OPEN. Two different causes, one honest answer:
///
///   * `progress`, `coach`, `screen-time` — the screens exist
///     (`LearningProgressScreen`, `CoachingScreen`, `WellbeingScreen`) but every
///     one of them requires `childId` AND `childName`, and the link carries
///     neither. That is not an oversight in the link: the server pins
///     `notifications.data` identifier-free on purpose (`e2e-13 STEP 14` asserts
///     the payload contains no `childId`), so no `abny://` link will ever carry
///     a child. Opening one of these needs a child chosen first, and this app's
///     child picker is the dashboard, not a deep link.
///   * `child/<id>`, `safety/<id>` — no parent screen exists at all. There is no
///     child-detail screen (the dashboard's `_ChildCard` fans out to eight
///     child-scoped screens instead), and no safety-alert detail screen.
///
/// In BOTH cases the tap lands on the inbox — where the notification itself
/// is — and says so out loud in a snackbar. Never a blank screen, never a
/// crash, and never the silent no-op that this whole change exists to remove.
/// The moment one of those screens gains an argument-free entry point, it is
/// one line in [resolve] and nothing else moves.
enum DeepLinkRouteKind {
  /// A registered name in `main.dart`'s `routes:` table.
  named,

  /// An id-scoped screen, constructed with a real argument.
  page,

  /// No screen in this app can open it — fall back to the inbox, visibly.
  unavailable,
}

class DeepLinkRoute {
  DeepLinkRoute.named(this.routeName)
      : kind = DeepLinkRouteKind.named,
        pageBuilder = null;

  DeepLinkRoute.page(this.pageBuilder)
      : kind = DeepLinkRouteKind.page,
        routeName = null;

  DeepLinkRoute.unavailable()
      : kind = DeepLinkRouteKind.unavailable,
        routeName = null,
        pageBuilder = null;

  final DeepLinkRouteKind kind;

  /// Non-null exactly when [kind] is [DeepLinkRouteKind.named].
  final String? routeName;

  /// Non-null exactly when [kind] is [DeepLinkRouteKind.page].
  final WidgetBuilder? pageBuilder;
}

class DeepLinkRouter {
  const DeepLinkRouter._();

  /// The l10n key for the honest fallback line. Named here so the screen, the
  /// router and the test all quote one key.
  static const String unavailableMessageKey = 'deepLink.unavailable';

  /// PURE. No context, no navigator, no side effect — which is what makes the
  /// whole map testable without pumping a widget.
  static DeepLinkRoute resolve(DeepLinkDestination destination) {
    final id = destination.id;
    switch (destination.surface) {
      case DeepLinkSurface.goals:
        return DeepLinkRoute.named(AppRoutes.goals);

      case DeepLinkSurface.goal:
        // `id == null` cannot arrive from `parseDeepLink` (a bare id-bearing
        // surface is already the inbox there). A destination built by hand
        // without one names no program, and `ProgramDetailScreen` cannot be
        // constructed without it — so it is genuinely unopenable.
        return id == null
            ? DeepLinkRoute.unavailable()
            : DeepLinkRoute.page((_) => ProgramDetailScreen(programId: id));

      case DeepLinkSurface.approvals:
        // The ACHIEVEMENT review queue — `PendingAchievementsScreen`. Not
        // `PendingApprovalsScreen`, which is the pending-MESSAGE queue; audit
        // P12 called out that the two had already been conflated once by name,
        // and `CHILD_REQUEST` — the one copy key that resolves to `approvals` —
        // is «أرسل {childName} طلبًا ينتظر ردّك», a request awaiting a decision.
        return DeepLinkRoute.named(AppRoutes.goalReviewQueue);

      case DeepLinkSurface.approval:
        return id == null
            ? DeepLinkRoute.unavailable()
            : DeepLinkRoute.page((_) => AchievementReviewScreen(achievementId: id));

      case DeepLinkSurface.rewards:
        // The parent's rewards surface is the FULFILMENT queue: the rewards a
        // child has earned and the parent has yet to hand over. The catalogue
        // (`ProgramWizardScreen`) is a configuration screen and answers a
        // question the notification did not ask.
        return DeepLinkRoute.named(AppRoutes.fulfilments);

      case DeepLinkSurface.subscription:
        return DeepLinkRoute.named(AppRoutes.subscription);

      case DeepLinkSurface.notifications:
        return DeepLinkRoute.named(AppRoutes.notifications);

      // --- No screen this app can open from a link alone. See the header. ---
      case DeepLinkSurface.progress:
      case DeepLinkSurface.coach:
      case DeepLinkSurface.screenTime:
      case DeepLinkSurface.safety:
      case DeepLinkSurface.child:
        return DeepLinkRoute.unavailable();
    }
  }

  /// Convenience for the tap path: parse and resolve in one step.
  static DeepLinkRoute resolveLink(String? link) => resolve(parseDeepLink(link));

  /// THE ONLY PLACE A DEEP LINK TOUCHES A NAVIGATOR.
  ///
  /// Synchronous and fire-and-forget on purpose: a tap must move now, and the
  /// caller must not be made to await a route that only completes when the user
  /// pops back. [t] is the caller's `LocaleController.t`, passed in rather than
  /// read from a provider so this stays usable from anywhere with a context.
  static void follow(
    BuildContext context,
    DeepLinkDestination destination, {
    required String Function(String) t,
  }) {
    final route = resolve(destination);
    final navigator = Navigator.of(context);
    final currentRouteName = ModalRoute.of(context)?.settings.name;

    switch (route.kind) {
      case DeepLinkRouteKind.named:
        final name = route.routeName;
        // Already on the screen the link names — pushing a second copy of the
        // inbox on top of the inbox is how a back button stops working.
        if (name == null || name == currentRouteName) return;
        navigator.pushNamed(name);
        return;
      case DeepLinkRouteKind.page:
        final builder = route.pageBuilder;
        if (builder == null) return;
        navigator.push(
          MaterialPageRoute<void>(
            builder: builder,
            // The canonical link as the route name: it is what a crash report
            // or a `RouteObserver` will show, and it is exactly the string the
            // server sent.
            settings: RouteSettings(name: destination.uri),
          ),
        );
        return;
      case DeepLinkRouteKind.unavailable:
        if (currentRouteName != AppRoutes.notifications) {
          navigator.pushNamed(AppRoutes.notifications);
        }
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(t(unavailableMessageKey)),
            duration: const Duration(seconds: 5),
          ),
        );
        return;
    }
  }

  /// Parse-and-go, for a caller holding the raw string off a payload.
  static void followLink(
    BuildContext context,
    String? link, {
    required String Function(String) t,
  }) =>
      follow(context, parseDeepLink(link), t: t);
}
