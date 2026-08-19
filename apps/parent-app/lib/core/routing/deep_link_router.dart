import 'package:flutter/material.dart';

import '../../features/family/presentation/child_detail_screen.dart';
import '../../features/rewards/presentation/achievement_review_screen.dart';
import '../../features/rewards/presentation/program_detail_screen.dart';
import '../../features/safety/presentation/safety_screen.dart';
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
/// THREE OF THE FIVE UNAVAILABLE SURFACES ARE NOW OPEN. This block used to
/// read «five of the twelve surfaces have no screen»; `safety`, `child` and
/// `screen-time` do now, and the two that remain do so for a reason that is a
/// PRODUCT DECISION rather than a missing screen.
///
/// WHAT WAS BUILT, AND WHAT EACH ONE LANDS ON:
///
///   * `safety/<alertId>` → `SafetyScreen(alertId: …)`, and bare `safety` →
///     the same screen by name. It reads `GET /notifications` filtered to the
///     server's own SAFETY classification (`notification-class.ts`), so a
///     `PROTECTION_BYPASS_ATTEMPT`, an `ACCESSIBILITY_DISABLED`, a
///     `POLICY_VIOLATION` and the `CHILD_WELLBEING_CHECKIN` distress alert all
///     have somewhere to go.
///   * `child/<childId>` → `ChildDetailScreen(childId: …)`, reading
///     `GET /children/:childId`.
///   * `screen-time` → `ScreenTimeChildrenScreen`, by name. THIS ONE WAS
///     RETARGETED, and the change is worth stating rather than burying.
///
///     It used to resolve to the SAME `SafetyScreen`, and the argument for
///     that was sound at the time: `safetyDestination` in
///     `notification-destination.ts` IS `idLink('safety', alertId,
///     surfaceLink('screen-time'))`, so the server does treat
///     `abny://screen-time` as the id-less form of `safety` — and since no
///     producer carries an `alertId` today, that is the only form the four
///     device alerts are ever emitted as. But the reason it landed there was
///     that THE PARENT APP HAD NO SCREEN-TIME SCREEN AT ALL: no
///     `features/screen_time/` directory existed, while the backend had been
///     serving a complete Screen Time API for several sprints. Sending a link
///     named `screen-time` to a safety feed was the best available answer to a
///     missing screen, not a statement about what the link means.
///
///     The screen exists now, so the surface the link is NAMED for is the
///     truthful landing — and it is also where `DAILY_GOAL_COMPLETED` and
///     `HYDRATION_REMINDER`, which name `screen-time` directly and have
///     nothing to do with safety, were always trying to go.
///
///     WHAT THE SAFETY FEED LOSES: nothing that was reachable stops being
///     reachable. `abny://safety/<alertId>` still opens `SafetyScreen` with the
///     alert selected, `AppRoutes.safety` is still registered in `main.dart`,
///     and `dashboard_home_screen.dart` still links to it. The four device
///     alerts also still arrive in the inbox, which is where their own text
///     is — a tap that lands on screen time now lands on the surface where a
///     parent CHANGES something, rather than on the list of what happened.
///
/// WHAT [DeepLinkRouteKind.unavailable] STILL MEANS, and it is now two
/// surfaces rather than five:
///
///   * `progress` and `coach` — the screens exist (`LearningProgressScreen`,
///     `CoachingScreen`) and both require `childId` AND `childName`, which the
///     link carries neither of. That is not an oversight in the link: the
///     server pins `notifications.data` identifier-free on purpose (`e2e-13
///     STEP 14` asserts the payload contains no `childId`), so no `abny://`
///     link will ever carry a child.
///
///     `ChildDetailScreen` is now the natural HOST for both — it supplies
///     `childId` and `childName` and puts each one tap away — but hosting them
///     is not the same as opening them. [resolve] is a pure function of the
///     DESTINATION, and a destination with no id names no child; picking one
///     here would be this client deciding something the server declined to
///     say. `coach` is additionally moot today: its only producer
///     (`CHILD_WELLBEING_CHECKIN`) writes through `createForFamilyOwner`,
///     which attaches no `deepLink` at all, so that tap reaches
///     `parseDeepLink(null)` and the inbox regardless of this table.
///
/// For those two the tap lands on the inbox — where the notification itself
/// is — and says so out loud in a snackbar. Never a blank screen, never a
/// crash, and never the silent no-op that this whole change exists to remove.
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

      case DeepLinkSurface.safety:
        // A NAMED route for the bare form and a PAGE for the id-scoped one —
        // `app_routes.dart`'s distinction, applied to a surface that has both.
        // `id == null` cannot arrive from `parseDeepLink` (a bare id-bearing
        // surface is already the inbox there); a destination built by hand
        // without one names no alert, and the safety surface itself is then the
        // truthful landing rather than a fallback.
        return id == null
            ? DeepLinkRoute.named(AppRoutes.safety)
            : DeepLinkRoute.page((_) => SafetyScreen(alertId: id));

      case DeepLinkSurface.screenTime:
        // RETARGETED. It used to land on `SafetyScreen`, because the parent app
        // had no screen-time screen at all — see the header for what changed
        // and why the safety feed did not lose anything by it.
        //
        // A NAMED route, and it is `ScreenTimeChildrenScreen` rather than the
        // overview itself for a reason that is the same one `progress` and
        // `coach` are still `unavailable` for: this surface's every backend
        // route is `/children/:childId/…`, and an id-less link names no child.
        // `resolve` stays a pure function of the DESTINATION; the screen the
        // NAME resolves to (`ScreenTimeChildrenScreen`, registered in
        // `main.dart`) is the one that answers «which child» from the
        // FAMILY'S OWN DATA — the list when there are several, that child's overview when
        // there is exactly one, and an honest empty state when there are none.
        return DeepLinkRoute.named(AppRoutes.screenTime);

      case DeepLinkSurface.child:
        return id == null
            ? DeepLinkRoute.unavailable()
            : DeepLinkRoute.page((_) => ChildDetailScreen(childId: id));

      // --- No screen this app can open from a link alone. See the header. ---
      case DeepLinkSurface.progress:
      case DeepLinkSurface.coach:
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
