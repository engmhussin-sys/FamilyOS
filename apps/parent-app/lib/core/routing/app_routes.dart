/// Centralized route name constants — avoids magic strings scattered
/// across `Navigator.pushNamed` calls.
class AppRoutes {
  static const splash = '/';
  static const login = '/login';
  static const register = '/register';
  static const familySetup = '/family-setup';
  static const dashboard = '/dashboard';
  static const addChild = '/add-child';
  static const notifications = '/notifications';
  static const settings = '/settings';
  static const subscription = '/subscription';
  static const billingHistory = '/billing-history';
  static const support = '/support';
  static const contactSupport = '/contact-support';
  static const createChild = '/create-child';
  static const manageConsents = '/manage-consents';
  static const deleteAccount = '/delete-account';
  static const redeemCode = '/redeem-code';

  // --- B6: the F4 Smart Reward Engine surface ---
  // Only the ARGUMENT-FREE destinations are named routes. The id-scoped
  // screens (program detail, achievement review, a child's rewards,
  // suggestions) are pushed with a MaterialPageRoute carrying real
  // constructor arguments — this app has no typed-arguments router, and
  // squeezing ids through `settings.arguments` as an untyped Object is
  // exactly the kind of stringly-typed navigation that produces runtime
  // casts nothing can check without an analyzer.
  //
  // REMOVED, AND WHY THEY ARE NOT COMING BACK: `digitalTwin`
  // ('/digital-twin') and `lifeTimeline` ('/life-timeline'). Both were
  // declared here and neither was ever in `main.dart`'s `routes:` table,
  // so `pushNamed(AppRoutes.digitalTwin)` threw at runtime — the constants
  // were live ammunition for a crash and nothing else. They could not be
  // registered either: `DigitalTwinScreen` and `LifeTimelineScreen` both
  // require `childId`/`childName` constructor arguments, which is exactly
  // the case the paragraph above says is pushed with a MaterialPageRoute —
  // and that is precisely how `dashboard_home_screen.dart` already pushes
  // them, correctly. Deleting the two names is the honest fix; registering
  // routes that cannot be constructed is not.
  static const goals = '/goals';
  static const goalReviewQueue = '/goal-review-queue';
  static const fulfilments = '/fulfilments';

  // --- F1: the parent's safety & protection surface ---
  //
  // A NAMED route, and it passes the test the paragraph above sets:
  // `SafetyScreen` is genuinely constructible with no arguments. Its one
  // parameter is OPTIONAL and only selects which card leads the list, so
  // `pushNamed` here can never produce the runtime cast that registering
  // `ChildDetailScreen` — whose `childId` is required — would.
  //
  // `abny://safety/<alertId>` is still pushed as a page with a real
  // constructor argument. Both forms live in `deep_link_router.dart`, and why
  // one screen has two kinds is argued there.
  static const safety = '/safety';

  // --- the parent's screen-time surface ---
  //
  // A NAMED route, and it passes the same test `safety` above does:
  // `ScreenTimeChildrenScreen` is genuinely constructible with NO arguments.
  // That is the whole reason it exists as a separate screen from
  // `ScreenTimeOverviewScreen`, whose `childId` is required — an id-less
  // `abny://screen-time` names no child, and the landing screen is what
  // resolves that from the family's own data rather than from a guess. See
  // that screen's header for the decision.
  static const screenTime = '/screen-time';
}
