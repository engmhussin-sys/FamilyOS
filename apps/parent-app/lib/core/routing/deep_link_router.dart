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
/// ALL TWELVE SURFACES ARE NOW OPEN. This block has read «five have no screen»
/// and then «two remain»; it now reads NONE. `safety`, `child` and
/// `screen-time` were opened earlier, and `progress` and `coach` are opened
/// here — see the last section for what changed in the argument, because the
/// reason they were refused was written down carefully and deserves an equally
/// explicit retraction.
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
///   * `progress` → `ProgressChildrenScreen`, and `coach` →
///     `CoachChildrenScreen`, both by name. THE DEAD TAP THIS PRODUCT'S TWO
///     MOST-SENT PARENT NOTIFICATIONS ENDED IN: `REWARD_GRANTED` («حصل
///     {childName} على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.») and
///     `BADGE_EARNED_PARENT` both resolve to `abny://progress`, both told the
///     parent to open the app, and both landed them back in the inbox they
///     were already in, under a snackbar.
///
///     WHAT THIS BLOCK USED TO ARGUE, AND WHY IT WAS HALF RIGHT. It said the
///     screens exist (`LearningProgressScreen`, `CoachingScreen`), that both
///     require `childId` AND `childName`, that no `abny://` link carries
///     either — the server pins `notifications.data` identifier-free on
///     purpose, `e2e-13 STEP 14` — and that [resolve], being a pure function of
///     the DESTINATION, must not pick a child the server declined to name.
///     Every one of those statements is still true and none of them has been
///     weakened here.
///
///     WHAT IT GOT WRONG was the conclusion. «This router must not pick a
///     child» is not «this app cannot open the surface»: the same objection was
///     already answered for `screen-time` by a screen that does not pick — it
///     ASKS, from the family's own data, and resolves to one child only when
///     the family itself makes the answer unambiguous. `ChildPicker` is that
///     mechanism extracted, and these two now use it. The router still invents
///     nothing.
///
///     `coach` is fixed in the same change rather than left behind. It is true
///     that nothing resolves there today (`CHILD_WELLBEING_CHECKIN` was moved
///     to `safetyDestination`), but a surface in the scheme that this app
///     cannot open is the defect, and the traffic on it is not the measure.
///
/// WHAT [DeepLinkRouteKind.unavailable] STILL MEANS, now that no SURFACE
/// returns it: an id-bearing destination BUILT BY HAND with no id —
/// `DeepLinkDestination(DeepLinkSurface.goal)` — which `ProgramDetailScreen`,
/// `AchievementReviewScreen` and `ChildDetailScreen` genuinely cannot be
/// constructed from. `parseDeepLink` never produces one (a bare id-bearing
/// surface is already the inbox there) and the server never emits one
/// (`notification-destination.ts` degrades `goal` to `goals` itself), so it is
/// unreachable from a real notification — and it stays implemented anyway,
/// because the tap lands on the inbox and SAYS SO in a snackbar. Never a blank
/// screen, never a crash, and never the silent no-op this whole file exists to
/// remove.
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

      case DeepLinkSurface.progress:
        // THE DEAD TAP THIS FILE USED TO DOCUMENT, CLOSED. `REWARD_GRANTED` and
        // `BADGE_EARNED_PARENT` — the two most-sent parent notifications — both
        // resolve here, and both ended on `unavailable()`.
        //
        // A NAMED route, and it is `ProgressChildrenScreen` rather than
        // `ChildRewardsScreen` itself for exactly the reason `screen-time`
        // above is a picker: that surface's every backend route is
        // `/…/:childId`, and an id-less link names no child. `resolve` stays a
        // pure function of the DESTINATION; the screen the NAME resolves to
        // answers «which child» from the FAMILY'S OWN DATA.
        return DeepLinkRoute.named(AppRoutes.progress);

      case DeepLinkSurface.coach:
        // The same repair by the same mechanism — `CoachChildrenScreen`. See
        // its header for why it is fixed in this change rather than left as the
        // one remaining refusal.
        return DeepLinkRoute.named(AppRoutes.coach);
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
