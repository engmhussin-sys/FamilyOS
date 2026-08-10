import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
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
  String? _errorMessage;
  String? _redeemingItemId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
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
      if (mounted) setState(() => _errorMessage = e.toString());
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
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          ),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(ref.read(localeControllerProvider.notifier).t('rewards.redeemFailed'))),
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
          body: _errorMessage != null
              ? _buildFriendlyError(t)
              : (_account == null || _store == null)
                  ? const Center(child: CircularProgressIndicator(color: KidTheme.skyBlue))
                  : RefreshIndicator(
                      color: KidTheme.skyBlue,
                      onRefresh: _load,
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                        children: [
                          _CoinBalanceCard(account: _account!, coinsLabel: t('rewards.coinsLabel'), xpLabel: t('rewards.xpLabel')),
                          const SizedBox(height: 24),
                          Text(t('rewards.storeTitle'), style: Theme.of(context).textTheme.headlineMedium),
                          const SizedBox(height: 12),
                          if (_store!.isEmpty)
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: Text(t('rewards.noRewardsYet')),
                            ),
                          ..._store!.map((item) {
                            final map = item as Map<String, dynamic>;
                            final costCoins = map['costCoins'] as int? ?? 0;
                            final coins = _account!['coins'] as int? ?? 0;
                            final canAfford = coins >= costCoins;
                            final itemId = map['id'] as String;
                            return _StoreItemCard(
                              title: map['title'] as String? ?? '',
                              costCoins: costCoins,
                              costLabel: t('rewards.coins', options: {'count': costCoins}),
                              canAfford: canAfford,
                              isRedeeming: _redeemingItemId == itemId,
                              getItLabel: t('rewards.getIt'),
                              needMoreLabel: t('rewards.needMore'),
                              onRedeem: canAfford ? () => _redeem(itemId, map['title'] as String? ?? 'reward') : null,
                            );
                          }),
                        ],
                      ),
                    ),
        ),
      ),
    );
  }

  Widget _buildFriendlyError(String Function(String, {int? count, Map<String, Object>? options}) t) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('\u{1F605}', style: TextStyle(fontSize: 56)),
            const SizedBox(height: 16),
            Text(t('rewards.loadError'), style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
            const SizedBox(height: 20),
            FilledButton.icon(onPressed: _load, icon: const Icon(Icons.refresh_rounded), label: Text(t('rewards.tryAgain'))),
          ],
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
      padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [KidTheme.sunshineYellow.withOpacity(0.25), KidTheme.coral.withOpacity(0.15)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(28),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _BalanceStat(emoji: '\u{1FA99}', value: '$coins', label: coinsLabel),
          Container(width: 1, height: 50, color: KidTheme.mutedInk.withOpacity(0.2)),
          _BalanceStat(emoji: '\u2B50', value: '$xp', label: xpLabel),
        ],
      ),
    );
  }
}

class _BalanceStat extends StatelessWidget {
  const _BalanceStat({required this.emoji, required this.value, required this.label});
  final String emoji;
  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(emoji, style: const TextStyle(fontSize: 28)),
        const SizedBox(height: 4),
        Text(value, style: Theme.of(context).textTheme.headlineMedium),
        Text(label, style: Theme.of(context).textTheme.bodyMedium),
      ],
    );
  }
}

class _StoreItemCard extends StatelessWidget {
  const _StoreItemCard({
    required this.title,
    required this.costCoins,
    required this.costLabel,
    required this.canAfford,
    required this.isRedeeming,
    required this.getItLabel,
    required this.needMoreLabel,
    required this.onRedeem,
  });

  final String title;
  final int costCoins;
  final String costLabel;
  final bool canAfford;
  final bool isRedeeming;
  final String getItLabel;
  final String needMoreLabel;
  final VoidCallback? onRedeem;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: canAfford ? Colors.white : KidTheme.mutedInk.withOpacity(0.04),
        borderRadius: BorderRadius.circular(20),
        boxShadow: canAfford
            ? [BoxShadow(color: KidTheme.sunshineYellow.withOpacity(0.15), blurRadius: 14, offset: const Offset(0, 5))]
            : null,
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
        child: Row(
          children: [
            const Text('\u{1F381}', style: TextStyle(fontSize: 28)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  Row(
                    children: [
                      const Text('\u{1FA99} ', style: TextStyle(fontSize: 14)),
                      Text(costLabel, style: Theme.of(context).textTheme.bodyMedium),
                    ],
                  ),
                ],
              ),
            ),
            if (isRedeeming)
              const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.5))
            else
              FilledButton(
                onPressed: onRedeem,
                style: FilledButton.styleFrom(
                  backgroundColor: canAfford ? KidTheme.sunshineYellow : Colors.grey.shade300,
                  minimumSize: const Size(80, 44),
                ),
                child: Text(canAfford ? getItLabel : needMoreLabel),
              ),
          ],
        ),
      ),
    );
  }
}
