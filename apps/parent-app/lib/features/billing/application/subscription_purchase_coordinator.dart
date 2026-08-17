import '../api/billing_api.dart';
import '../domain/store_billing_client.dart';

/// PHASE G — WHICH PURCHASE PATH, AND WHO DECIDES.
///
/// ============================== WHAT THIS CLOSES =============================
///
/// `subscription_screen.dart` called `billingApi.subscribe(tier, 'MANUAL')`. The
/// CLIENT named the tier and the provider, and `MANUAL` is the adapter that
/// always succeeds — so any parent could grant their household any plan by
/// pressing a button, with no payment anywhere in the story.
///
/// ==================== THE TWO PATHS, AND WHY BOTH EXIST ====================
///
/// `HUMAN DECISION REQUIRED #2` (PHASE-D-Payments-Report.md §8) is the heaviest
/// commercial decision in the project, worth roughly US$336K/year, and IT IS NOT
/// MADE HERE:
///
///   STORE  — Google Play Billing. 15–30% fee. Play policy requires it for
///            digital subscriptions sold inside the app. Cannot reach Fawry or
///            mobile wallets, which excludes a wide slice of the Egyptian market.
///   DIRECT — our own gateway (Paymob / Fawry / Moyasar). 2–3% fee. The app must
///            not steer users to it in a way that violates Play policy.
///
/// **THE SERVER DECIDES, PER PRICE, AND THE MECHANISM ALREADY EXISTS.** Phase D
/// put `store_product_id` on `subscription_prices`: non-null means that price is
/// sold through a store, null means direct checkout. This class READS that field
/// out of `GET /billing/catalogue/:countryCode` and routes accordingly. It has no
/// default, no preference and no fallback — a price the operator has not
/// configured for either channel produces `PurchaseChannelKind.unconfigured` and
/// an honest message, never a silent choice.
///
/// The two paths stay SEPARATE and CLEARLY SOURCED. `verifyStorePurchase` sends a
/// token and nothing else; `subscribe` names a gateway the SERVER chose for the
/// market. They meet nowhere except at `Entitlement`, which is the single source
/// of truth for access regardless of which channel paid.
///
/// ================================ NOT RUN ==================================
///
/// **No line of this file has been executed.** There is no Flutter SDK here.
/// It is `STATIC VERIFIED` at best, and the store path additionally needs a Play
/// Billing client that does not exist yet — see `StoreBillingClient`.
enum PurchaseChannelKind {
  /// Sold through a store. The client obtains a token; the server verifies it.
  store,

  /// Sold by us. The server creates the charge with the market's gateway.
  direct,

  /// The operator has configured neither for this tier in this market. NOT an
  /// error in this app — an unmade decision, and it is reported as one.
  unconfigured,
}

/// The resolved answer for one tier in one market. Every field came from the
/// server.
class PurchaseChannel {
  const PurchaseChannel({
    required this.kind,
    required this.planTier,
    required this.countryCode,
    this.storeProductId,
    this.directProvider,
    this.currency,
    this.grossMinor,
  });

  final PurchaseChannelKind kind;
  final String planTier;
  final String countryCode;

  /// Set iff [kind] is [PurchaseChannelKind.store]. From the server catalogue.
  final String? storeProductId;

  /// Set iff [kind] is [PurchaseChannelKind.direct]. The market's own gateway,
  /// as the SERVER reports it — never a literal in this app.
  final String? directProvider;

  /// For display only. The amount charged is decided by the store or by the
  /// server; nothing here is ever sent back as a claim about what was paid.
  final String? currency;
  final int? grossMinor;
}

/// Why a purchase could not be started, in terms a screen can translate.
enum PurchaseFailureReason {
  /// The deployment sells in more than one market and nothing in this app knows
  /// which one this family is in. A REAL GAP, named rather than guessed at:
  /// picking a market for a family would silently price them in the wrong
  /// currency, and 179 EGP and 179 SAR differ by roughly ten times.
  marketUnknown,

  /// The server has no price for this tier in this market. Migration 0014
  /// deliberately seeds no prices at all (`HUMAN DECISION REQUIRED #1`), so this
  /// is the expected state until someone sets them.
  channelUnconfigured,

  /// A store sale is configured, but this build has no store billing client.
  storeUnavailable,

  /// The store or the server refused. The message carries the detail.
  failed,
}

class PurchaseFailure implements Exception {
  const PurchaseFailure(this.reason, this.detail);

  final PurchaseFailureReason reason;
  final String detail;

  @override
  String toString() => 'PurchaseFailure(${reason.name}): $detail';
}

/// The outcome of a completed purchase attempt. Deliberately thin: the app's
/// next move is always to re-read `/billing/subscription` and
/// `/billing/entitlements` from the server, never to update local state from
/// what it thinks just happened.
class PurchaseResult {
  const PurchaseResult({required this.channel, required this.serverVerified});

  final PurchaseChannelKind channel;

  /// True only for the store path, where a 200 from
  /// `POST /billing/purchases/verify` means the STORE confirmed the purchase.
  final bool serverVerified;
}

class SubscriptionPurchaseCoordinator {
  SubscriptionPurchaseCoordinator(this._api, this._store);

  final BillingApi _api;
  final StoreBillingClient _store;

  /// Resolves which channel sells [planTier], asking the server for everything.
  ///
  /// MARKET RESOLUTION IS AN OPEN GAP AND IS TREATED AS ONE. `GET /billing/
  /// markets` lists the markets this deployment sells in; nothing in this app
  /// records which one a given family belongs to. When exactly one market is
  /// active the answer is unambiguous and is used. When there are several,
  /// this throws [PurchaseFailureReason.marketUnknown] rather than choosing —
  /// choosing would price a Saudi family in EGP or an Egyptian family in SAR,
  /// and those differ by roughly an order of magnitude.
  Future<PurchaseChannel> resolveChannel({required String planTier, String? countryCode}) async {
    var country = countryCode;
    if (country == null) {
      final markets = await _api.getMarkets();
      final active = markets
          .whereType<Map<String, dynamic>>()
          .where((m) => m['isActive'] != false)
          .toList(growable: false);
      if (active.length != 1) {
        throw PurchaseFailure(
          PurchaseFailureReason.marketUnknown,
          'This deployment sells in ${active.length} markets and nothing in this app '
          'records which one this family is in. Refusing to guess: the currencies '
          'differ by roughly ten times.',
        );
      }
      country = active.first['code'] as String?;
      if (country == null) {
        throw const PurchaseFailure(
          PurchaseFailureReason.marketUnknown,
          'The server returned a market with no country code.',
        );
      }
    }

    final catalogue = await _api.getCatalogue(country);
    final entry = catalogue
        .whereType<Map<String, dynamic>>()
        .where((e) => e['planTier'] == planTier)
        .cast<Map<String, dynamic>?>()
        .firstWhere((e) => e != null, orElse: () => null);

    if (entry == null) {
      return PurchaseChannel(
        kind: PurchaseChannelKind.unconfigured,
        planTier: planTier,
        countryCode: country,
      );
    }

    final storeProductId = entry['storeProductId'] as String?;
    if (storeProductId != null && storeProductId.isNotEmpty) {
      return PurchaseChannel(
        kind: PurchaseChannelKind.store,
        planTier: planTier,
        countryCode: country,
        storeProductId: storeProductId,
        currency: entry['currency'] as String?,
        grossMinor: entry['grossMinor'] as int?,
      );
    }

    // storeProductId is null -> this price is sold by us. WHICH gateway is the
    // server's answer too: it comes from the market row, not from a literal here.
    final markets = await _api.getMarkets();
    final market = markets
        .whereType<Map<String, dynamic>>()
        .cast<Map<String, dynamic>?>()
        .firstWhere((m) => m != null && m['code'] == country, orElse: () => null);
    final gateway = market?['defaultProvider'] as String?;
    if (gateway == null || gateway.isEmpty) {
      return PurchaseChannel(
        kind: PurchaseChannelKind.unconfigured,
        planTier: planTier,
        countryCode: country,
      );
    }
    return PurchaseChannel(
      kind: PurchaseChannelKind.direct,
      planTier: planTier,
      countryCode: country,
      directProvider: gateway,
      currency: entry['currency'] as String?,
      grossMinor: entry['grossMinor'] as int?,
    );
  }

  /// Buys [planTier] through whichever channel the server configured for it.
  ///
  /// The opaque household reference comes from the SERVER
  /// (`GET /billing/store-account-ref`) and is handed to the STORE, which echoes
  /// it back to our server, which resolves the tenant from that echo rather than
  /// from the session. This app never asserts a family id to the server — it
  /// only relays a value the server minted, through the store, so the server's
  /// own check has something to check.
  Future<PurchaseResult> purchase({
    required String planTier,
    String? countryCode,
  }) async {
    final channel = await resolveChannel(planTier: planTier, countryCode: countryCode);

    switch (channel.kind) {
      case PurchaseChannelKind.unconfigured:
        throw PurchaseFailure(
          PurchaseFailureReason.channelUnconfigured,
          'The server has no configured price for $planTier in ${channel.countryCode}, '
          'through a store or otherwise. Prices are deliberately unseeded until the '
          'commercial decision is made (HUMAN DECISION REQUIRED #1 and #2).',
        );

      case PurchaseChannelKind.store:
        if (!_store.isAvailable) {
          throw PurchaseFailure(
            PurchaseFailureReason.storeUnavailable,
            'This tier is sold through the store, and this build has no store '
            'billing client. It is NOT falling back to a path that would grant '
            'the tier without a payment.',
          );
        }
        final accountRef = await _api.getStoreAccountRef();
        final StorePurchase purchased;
        try {
          purchased = await _store.purchase(
            storeProductId: channel.storeProductId!,
            accountRef: accountRef,
          );
        } on StoreBillingUnavailableException catch (e) {
          throw PurchaseFailure(PurchaseFailureReason.storeUnavailable, e.reason);
        }
        // THE ONLY THING SENT. Not the tier, not the amount, not the currency,
        // not the family. The server asks the store and decides.
        await _api.verifyStorePurchase(
          provider: _store.providerName,
          providerToken: purchased.providerToken,
        );
        return const PurchaseResult(channel: PurchaseChannelKind.store, serverVerified: true);

      case PurchaseChannelKind.direct:
        // The tier is still named here because this endpoint is a request for
        // the SERVER to create a charge, not a claim that one was paid — the
        // server prices it from its own catalogue and the entitlement follows
        // the payment, not this call. The gateway came from the market row.
        await _api.subscribe(planTier, channel.directProvider!);
        return const PurchaseResult(channel: PurchaseChannelKind.direct, serverVerified: false);
    }
  }
}
