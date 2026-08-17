import '../../../core/network/api_client.dart';

/// Every method here calls a real, already-built backend endpoint
/// (Sprint 8's billing module, `/billing/*`, JWT-authenticated) —
/// zero invented endpoints. `_client.get()` on a raw-array response
/// gets wrapped as `{'data': [...]}` by ApiClient._unwrap (same
/// pattern LifeIntelligenceApi.getFamilyStore already relies on).
class BillingApi {
  BillingApi(this._client);

  final ApiClient _client;

  Future<List<dynamic>> getPlans() async {
    final result = await _client.get('/billing/plans');
    return result['data'] as List<dynamic>;
  }

  Future<Map<String, dynamic>> getSubscription() {
    return _client.get('/billing/subscription');
  }

  Future<void> startTrial() {
    return _client.post('/billing/trial/start');
  }

  /// THE DIRECT-CHECKOUT PATH (Sprint 8, endpoint unchanged).
  ///
  /// `provider` is the gateway the SERVER named for the family's market
  /// (`GET /billing/markets` -> `defaultProvider`), never a literal chosen in
  /// this app. The previous caller passed `'MANUAL'` — an adapter that always
  /// succeeds — so any parent could grant themselves any tier by pressing a
  /// button. See `SubscriptionPurchaseCoordinator`.
  Future<Map<String, dynamic>> subscribe(String planTier, String provider) {
    return _client.post('/billing/subscribe', data: {'planTier': planTier, 'provider': provider});
  }

  /// The markets this deployment sells in, each with its currency, VAT rate and
  /// the gateway the server uses for direct checkout there.
  Future<List<dynamic>> getMarkets() async {
    final result = await _client.get('/billing/markets');
    return result['data'] as List<dynamic>;
  }

  /// The price list for one country, VAT already broken out by the server.
  ///
  /// `storeProductId` on each entry is the field that DECIDES the purchase
  /// channel: non-null means this price is sold through a store, null means
  /// direct checkout. That is Phase D's design, and it is server-side
  /// configuration — not a decision this app is allowed to make.
  Future<List<dynamic>> getCatalogue(String countryCode) async {
    final result = await _client.get('/billing/catalogue/$countryCode');
    return result['data'] as List<dynamic>;
  }

  /// THE STORE PATH. This app sends a purchase token AND NOTHING ELSE.
  ///
  /// No amount, no currency, no tier, no familyId — `VerifyPurchaseDto` has no
  /// field for any of them, deliberately. The server calls Google Play over an
  /// authenticated channel, derives the tier from its own price catalogue,
  /// resolves the household from the store's own account reference, and grants
  /// the entitlement. A 200 here means the STORE confirmed the purchase, not
  /// that this app claimed it.
  Future<Map<String, dynamic>> verifyStorePurchase({
    required String provider,
    required String providerToken,
  }) {
    return _client.post(
      '/billing/purchases/verify',
      data: {'provider': provider, 'providerToken': providerToken},
    );
  }

  /// The opaque household reference this app must hand to the store when it
  /// starts a purchase (Play `obfuscatedExternalAccountId`, Apple
  /// `appAccountToken`).
  ///
  /// LOAD-BEARING, not telemetry. The server resolves the tenant from the value
  /// the STORE echoes back rather than from the session — that is the
  /// cross-tenant defence. Without it every purchase falls back to the weaker
  /// session binding, and the backend logs a warning each time.
  Future<String> getStoreAccountRef() async {
    final result = await _client.get('/billing/store-account-ref');
    return result['accountRef'] as String;
  }

  /// What the server says this family may do. The single source of truth for
  /// feature access: this app asks, and never decides.
  Future<Map<String, dynamic>> getEntitlements() {
    return _client.get('/billing/entitlements');
  }

  Future<void> cancel() {
    return _client.post('/billing/cancel');
  }

  Future<List<dynamic>> getBillingHistory() async {
    final result = await _client.get('/billing/history');
    return result['data'] as List<dynamic>;
  }
}
