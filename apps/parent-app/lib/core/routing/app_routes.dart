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
  static const digitalTwin = '/digital-twin';
  static const lifeTimeline = '/life-timeline';
  static const subscription = '/subscription';
  static const billingHistory = '/billing-history';
  static const support = '/support';
  static const contactSupport = '/contact-support';
  static const createChild = '/create-child';
  static const manageConsents = '/manage-consents';
  static const deleteAccount = '/delete-account';
  static const redeemCode = '/redeem-code';

  // --- B6: the F4 Smart Reward Engine surface ---
  // Only the three ARGUMENT-FREE destinations are named routes. The
  // id-scoped screens (program detail, achievement review, a child's
  // rewards, suggestions) are pushed with a MaterialPageRoute carrying
  // real constructor arguments — this app has no typed-arguments router,
  // and squeezing ids through `settings.arguments` as an untyped Object is
  // exactly the kind of stringly-typed navigation that produces runtime
  // casts nothing can check without an analyzer.
  static const goals = '/goals';
  static const goalReviewQueue = '/goal-review-queue';
  static const fulfilments = '/fulfilments';
}
