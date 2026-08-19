import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/kid_theme.dart';
import '../../../core/widgets/celebration_overlay.dart';

/// CLOSES A REAL GAP (Sprint 3 — Parent/Child parity audit): the
/// child has ALWAYS had a real rewards account (RewardsEngineService,
/// Sprint 17) — a parent could always see and manage it, but the
/// child who actually earns and would spend the balance never had
/// any way to see their own coins or the family store.
class RewardsScreen extends ConsumerStatefulWidget {
  const RewardsScreen({super.key});

  @override
  ConsumerState<RewardsScreen> createState() => _RewardsScreenState();
}

class _RewardsScreenState extends ConsumerState<RewardsScreen> {
  Map<String, dynamic>? _account;
  List<dynamic>? _store;

  /// THE B3 ENVELOPE, not `e.toString()`. This used to hold raw exception
  /// text — which the error widget then did not render, so the child was
  /// told a fixed «ياااه! حاجة ما حمّلتش.» while the server had already
  /// written the actual reason in Arabic and it was thrown away.
  ApiFailure? _failure;
  String? _redeemingItemId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _failure = null);
    try {
      final api = ref.read(familyGrowthApiProvider);
      final results = await Future.wait([api.getRewardsAccount(), api.getRewardsStore()]);
      if (mounted) {
        setState(() {
          _account = results[0] as Map<String, dynamic>;
          _store = results[1] as List<dynamic>;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _failure = ApiFailure.from(e));
    }
  }

  Future<void> _redeem(String catalogItemId, String title) async {
    setState(() => _redeemingItemId = catalogItemId);
    try {
      await ref.read(familyGrowthApiProvider).redeemReward(catalogItemId);
      if (mounted) {
        CelebrationOverlay.of(context).burst();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(ref.read(localeControllerProvider.notifier).t('rewards.requested', options: {'title': title})),
            backgroundColor: KidTheme.celebrationAccent,
            behavior: SnackBarBehavior.floating,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KidRadius.control)),
          ),
        );
      }
    } catch (e) {
      // THE SERVER'S OWN SENTENCE, not a fixed client line. A redemption is
      // refused for reasons the child can act on — not enough coins yet, this
      // one is already on its way — and F4 words each of them in Arabic. The
      // old `catch (_)` discarded all of that and always said «معرفناش نطلبها
      // دلوقتي», which teaches the child nothing about what to do next.
      //
      // `ApiFailure.display` is never empty and never raw: an envelope gives
      // the server's Arabic, and anything the server did not word falls back
      // to `unexpected`'s reviewed sentence.
      if (mounted) {
        final locale = ref.read(localeControllerProvider.notifier);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(ApiFailure.from(e).displayFor(arabic: locale.isRtl)),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _redeemingItemId = null);
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final localeController = ref.watch(localeControllerProvider.notifier);
    final t = localeController.t;

    return Directionality(
      textDirection: localeController.isRtl ? TextDirection.rtl : TextDirection.ltr,
      child: CelebrationOverlay(
        child: Scaffold(
          appBar: AppBar(title: Text(t('rewards.title'))),
          body: _failure != null
              ? _buildFriendlyError(t, localeController.isRtl)
              : (_account == null || _store == null)
                  ? Center(child: KidLoadingState(label: t('common.loading')))
                  : RefreshIndicator(
                      color: KidTheme.skyBlue,
                      onRefresh: _load,
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                        children: [
                          _CoinBalanceCard(account: _account!, coinsLabel: t('rewards.coinsLabel'), xpLabel: t('rewards.xpLabel')),
                          const SizedBox(height: KidSpace.xl),
                          Text(t('rewards.storeTitle'), style: Theme.of(context).textTheme.headlineMedium),
                          const SizedBox(height: KidSpace.md),
                          if (_store!.isEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: KidSpace.sm),
                              child: Text(t('rewards.noRewardsYet')),
                            ),
                          // NO AFFORDABILITY GATE. `requestRedemption` accepts
                          // a request from a child who is short, and says why
                          // in its own words: «Requesting is allowed even if
                          // the child is currently short on coins — a parent
                          // may grant bonus coins after seeing the request.
                          // The balance check that actually matters happens at
                          // approval time.» This screen used to disable the
                          // button, so a child ten coins short met a dead
                          // control and the parent never learned they wanted
                          // it. The cost is rendered and the gap is said out
                          // loud; whether the request is granted stays with
                          // the server and the parent.
                          ..._store!.map((item) {
                            final map = item as Map<String, dynamic>;
                            final costCoins = map['costCoins'] as int? ?? 0;
                            final coins = _account!['coins'] as int? ?? 0;
                            final itemId = map['id'] as String;
                            return _StoreItemCard(
                              title: map['title'] as String? ?? '',
                              costLabel: t('rewards.coins', options: {'count': costCoins}),
                              shortfallLabel: coins >= costCoins
                                  ? null
                                  : t('rewards.askAnyway',
                                      options: {'count': costCoins - coins}),
                              isRedeeming: _redeemingItemId == itemId,
                              getItLabel: t('rewards.getIt'),
                              onRedeem: () =>
                                  _redeem(itemId, map['title'] as String? ?? 'reward'),
                            );
                          }),
                        ],
                      ),
                    ),
        ),
      ),
    );
  }

  /// The chrome line stays this screen's; the EXPLANATION is the server's.
  ///
  /// `KidErrorState` renders `failure.displayFor(arabic:)` under the title, so
  /// the Arabic sentence F4 wrote for this exact failure finally lands on a
  /// screen instead of being replaced by a fixed "something didn't load" —
  /// and it picks the sunshine treatment over the coral one for an
  /// `isNotNow` refusal, which a bare `FilledButton` could never do.
  Widget _buildFriendlyError(
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool arabic,
  ) {
    return Center(
      child: SingleChildScrollView(
        child: KidErrorState(
          failure: _failure!,
          title: t('rewards.loadError'),
          retryLabel: t('rewards.tryAgain'),
          arabic: arabic,
          onRetry: _load,
        ),
      ),
    );
  }
}

class _CoinBalanceCard extends StatelessWidget {
  const _CoinBalanceCard({required this.account, required this.coinsLabel, required this.xpLabel});
  final Map<String, dynamic> account;
  final String coinsLabel;
  final String xpLabel;

  @override
  Widget build(BuildContext context) {
    final coins = account['coins'] as int? ?? 0;
    final xp = account['xp'] as int? ?? 0;

    return Container(
      padding: const EdgeInsets.symmetric(vertical: KidSpace.xl, horizontal: KidSpace.lg),
      decoration: BoxDecoration(
        gradient: KidGradient.duo(KidTheme.sunshineYellow, KidTheme.coral),
        borderRadius: BorderRadius.circular(KidRadius.lg),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _BalanceStat(icon: Icons.monetization_on_rounded, colour: KidTheme.sunshineYellow, value: '$coins', label: coinsLabel),
          Container(width: 1, height: 50, color: KidTheme.mutedInk.withOpacity(0.2)),
          _BalanceStat(icon: Icons.star_rounded, colour: KidTheme.berryPurple, value: '$xp', label: xpLabel),
        ],
      ),
    );
  }
}

class _BalanceStat extends StatelessWidget {
  const _BalanceStat({required this.icon, required this.colour, required this.value, required this.label});

  /// WAS a `String emoji`. Coins and XP are the two numbers this screen
  /// exists for, and both were drawn in whatever emoji font the phone
  /// happens to ship — which on a cheap Android in this product's market
  /// can be a grey outline or a tofu box. A Material glyph is inside the
  /// APK.
  final IconData icon;
  final Color colour;
  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: KidSize.iconLg, color: colour),
        KidSpace.gapXs,
        Text(value, style: Theme.of(context).textTheme.headlineMedium),
        Text(label, style: Theme.of(context).textTheme.bodyMedium),
      ],
    );
  }
}

class _StoreItemCard extends StatelessWidget {
  const _StoreItemCard({
    required this.title,
    required this.costLabel,
    required this.shortfallLabel,
    required this.isRedeeming,
    required this.getItLabel,
    required this.onRedeem,
  });

  final String title;
  final String costLabel;

  /// `null` when the child already has enough. When it is not null the card
  /// SAYS how far off they are and still offers the button — it is not a
  /// refusal, because the server does not refuse.
  final String? shortfallLabel;
  final bool isRedeeming;
  final String getItLabel;

  /// Never null. The card had a `canAfford` flag that turned this off; the
  /// button is now always live, because the request is always allowed.
  final VoidCallback onRedeem;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: KidSpace.md),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(KidRadius.card),
        boxShadow: [
          BoxShadow(
            color: KidTheme.sunshineYellow.withOpacity(0.15),
            blurRadius: 14,
            offset: const Offset(0, 5),
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(KidSpace.lg, KidSpace.md, KidSpace.md, KidSpace.md),
        child: Row(
          children: [
            const Icon(Icons.card_giftcard_rounded, size: KidSize.iconLg, color: KidTheme.sunshineYellow),
            const SizedBox(width: KidSpace.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  Row(
                    children: [
                      const Icon(Icons.monetization_on_rounded, size: KidSize.iconXs, color: KidTheme.sunshineYellow),
                      KidSpace.hGapSm,
                      Text(costLabel, style: KidText.caption(context)),
                    ],
                  ),
                  if (shortfallLabel != null)
                    Text(
                      shortfallLabel!,
                      style: KidText.caption(context),
                    ),
                ],
              ),
            ),
            if (isRedeeming)
              const SizedBox(
                width: KidSize.spinnerSm,
                height: KidSize.spinnerSm,
                child: CircularProgressIndicator(strokeWidth: 2.5),
              )
            else
              FilledButton(
                onPressed: onRedeem,
                style: FilledButton.styleFrom(
                  backgroundColor: KidTheme.sunshineYellow,
                  // WAS `Size(80, 44)`. 44 is BELOW this app's own 56px
                  // minimum touch target — the one commitment the child
                  // app's theme makes explicitly, on the only button on
                  // this card, for the youngest hands in the product.
                  minimumSize: const Size(96, KidSize.touchTarget),
                ),
                child: Text(getItLabel),
              ),
          ],
        ),
      ),
    );
  }
}
