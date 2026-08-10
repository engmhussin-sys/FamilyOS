import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
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
            content: Text('Yay! "$title" requested \u2014 ask a grown-up to approve it!'),
            backgroundColor: KidTheme.celebrationAccent,
            behavior: SnackBarBehavior.floating,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          ),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("Couldn't request that right now \u2014 try again!")),
        );
      }
    } finally {
      if (mounted) setState(() => _redeemingItemId = null);
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return CelebrationOverlay(
      child: Scaffold(
        appBar: AppBar(title: const Text('My Rewards')),
        body: _errorMessage != null
            ? _buildFriendlyError()
            : (_account == null || _store == null)
                ? const Center(child: CircularProgressIndicator(color: KidTheme.skyBlue))
                : RefreshIndicator(
                    color: KidTheme.skyBlue,
                    onRefresh: _load,
                    child: ListView(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                      children: [
                        _CoinBalanceCard(account: _account!),
                        const SizedBox(height: 24),
                        Text('Reward Store', style: Theme.of(context).textTheme.headlineMedium),
                        const SizedBox(height: 12),
                        if (_store!.isEmpty)
                          const Padding(
                            padding: EdgeInsets.only(top: 8),
                            child: Text("No rewards yet - ask a grown-up to add some!"),
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
                            canAfford: canAfford,
                            isRedeeming: _redeemingItemId == itemId,
                            onRedeem: canAfford ? () => _redeem(itemId, map['title'] as String? ?? 'reward') : null,
                          );
                        }),
                      ],
                    ),
                  ),
      ),
    );
  }

  Widget _buildFriendlyError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('\u{1F605}', style: TextStyle(fontSize: 56)),
            const SizedBox(height: 16),
            Text("Oops! Something didn't load.", style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
            const SizedBox(height: 20),
            FilledButton.icon(onPressed: _load, icon: const Icon(Icons.refresh_rounded), label: const Text('Try Again')),
          ],
        ),
      ),
    );
  }
}

class _CoinBalanceCard extends StatelessWidget {
  const _CoinBalanceCard({required this.account});
  final Map<String, dynamic> account;

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
          _BalanceStat(emoji: '\u{1FA99}', value: '$coins', label: 'Coins'),
          Container(width: 1, height: 50, color: KidTheme.mutedInk.withOpacity(0.2)),
          _BalanceStat(emoji: '\u2B50', value: '$xp', label: 'XP'),
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
    required this.canAfford,
    required this.isRedeeming,
    required this.onRedeem,
  });

  final String title;
  final int costCoins;
  final bool canAfford;
  final bool isRedeeming;
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
                      Text('$costCoins coins', style: Theme.of(context).textTheme.bodyMedium),
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
                child: Text(canAfford ? 'Get it!' : 'Need more'),
              ),
          ],
        ),
      ),
    );
  }
}
