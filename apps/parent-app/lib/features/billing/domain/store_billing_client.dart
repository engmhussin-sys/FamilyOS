/// PHASE G — THE STORE BILLING PORT.
///
/// ======================= WHAT THIS FILE IS AND IS NOT =======================
///
/// It is the seam between "buy this on the device" and "the server verifies what
/// the store says". It is NOT a Play Billing implementation, and it does not
/// pretend to be one: `UnavailableStoreBillingClient` — the only implementation
/// in this repository — refuses, loudly, naming exactly what is missing.
///
/// WHY THERE IS NO REAL IMPLEMENTATION, STATED PLAINLY. Obtaining a Play
/// `purchaseToken` requires either the `in_app_purchase` Flutter plugin or a
/// platform channel onto Android's `BillingClient`. Both are real work and one of
/// them is a NEW DEPENDENCY. Adding a dependency in this repository right now
/// would be irresponsible for a specific, measurable reason:
///
///   * `pub.dev` is unreachable from the authoring environment, so a new
///     constraint cannot be resolved, let alone locked;
///   * neither app commits a `pubspec.lock` (audit PA-M-016), so resolution
///     already follows a DATE rather than a commit;
///   * `in_app_purchase`'s Android side has historically raised the required
///     `compileSdk`, and `android/settings.gradle` pins AGP 8.1.1, which refuses
///     `compileSdk` above 34.
///
/// So an unresolvable, unlockable dependency could break the single most
/// valuable unmeasured thing in the project — the first `flutter build` — and
/// it would break it in a way that looks like the build being broken rather
/// than like this decision. The dependency is therefore a NAMED, DELIBERATE
/// FOLLOW-UP, taken on a machine that can resolve it, and this port exists so
/// that adding it later is one new class and one changed line in
/// `core/di/providers.dart` with nothing else to touch.
///
/// **THE UI IS HONEST IN THE MEANTIME.** It does not fall back to a path that
/// grants entitlement without payment. That is precisely what it used to do.
library;

/// What a completed device-side purchase yields, and the only thing the server
/// is ever given.
///
/// ONE FIELD. There is no amount, no currency, no tier and no familyId here on
/// purpose — mirroring `VerifyPurchaseDto` on the server, which has no field for
/// them either. A client cannot assert what it paid or on whose behalf, because
/// there is nowhere for such a claim to travel.
class StorePurchase {
  const StorePurchase({required this.providerToken});

  /// Play's `purchaseToken`, or StoreKit's `jwsRepresentation`. Opaque here, and
  /// verified against the store's own API by the backend.
  final String providerToken;
}

/// Raised when a store purchase cannot even be attempted.
///
/// Distinguishable from "the purchase failed": this means the app was never able
/// to ask the store, which is a configuration or packaging fact the user cannot
/// fix by retrying. The UI must say something different for it, and does.
class StoreBillingUnavailableException implements Exception {
  const StoreBillingUnavailableException(this.reason);

  final String reason;

  @override
  String toString() => 'StoreBillingUnavailableException: $reason';
}

/// The device-side purchase flow. One method, deliberately.
abstract class StoreBillingClient {
  /// Which provider this client's tokens belong to — `GOOGLE_PLAY` or
  /// `APPLE_IAP`. Sent to the server so it knows which store to ask; it is a
  /// routing fact, not a claim about the purchase.
  String get providerName;

  /// True when a purchase can actually be attempted. Checked by the coordinator
  /// BEFORE anything is shown to the user, so the failure is a clear message
  /// rather than a spinner that ends in an exception.
  bool get isAvailable;

  /// Launches the store's purchase flow and returns its token.
  ///
  /// [storeProductId] is the id the SERVER's price catalogue holds
  /// (`subscription_prices.store_product_id`) — the app never invents it.
  ///
  /// [accountRef] is our opaque household reference, passed to the store as
  /// Play's `obfuscatedExternalAccountId` (Apple: `appAccountToken`). It is
  /// LOAD-BEARING, not telemetry: the server resolves the tenant from the value
  /// the STORE echoes back, and without it the tenant binds only to the session
  /// — a weaker binding that the backend logs a warning about.
  Future<StorePurchase> purchase({
    required String storeProductId,
    required String accountRef,
  });
}

/// The only implementation in this repository. It refuses, and says why.
///
/// FAIL LOUDLY, NEVER SILENTLY. The previous behaviour — `subscribe(tier,
/// 'MANUAL')` — was the opposite: it succeeded, granted the tier, and took no
/// money. A refusal that names the missing piece is strictly better than a
/// success that is a lie.
class UnavailableStoreBillingClient implements StoreBillingClient {
  const UnavailableStoreBillingClient({this.providerName = 'GOOGLE_PLAY'});

  @override
  final String providerName;

  @override
  bool get isAvailable => false;

  @override
  Future<StorePurchase> purchase({
    required String storeProductId,
    required String accountRef,
  }) async {
    throw const StoreBillingUnavailableException(
      'No Play Billing client is compiled into this build. Obtaining a '
      'purchaseToken needs either the in_app_purchase plugin or a platform '
      'channel onto Android BillingClient; neither is present, and adding a '
      'dependency that cannot be resolved or locked here would put the first '
      'build of this project at risk. See '
      'lib/features/billing/domain/store_billing_client.dart for the whole '
      'reasoning, and docs/release/PLAY_BILLING.md for what remains. This build '
      'deliberately does NOT fall back to a path that grants a paid tier '
      'without a payment.',
    );
  }
}
