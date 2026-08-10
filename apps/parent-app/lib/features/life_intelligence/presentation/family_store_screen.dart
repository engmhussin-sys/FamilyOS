import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: a real coin-icon badge for the cost instead of plain
/// trailing text — the reward store is meant to feel like a store,
/// not a settings list.
class FamilyStoreScreen extends ConsumerStatefulWidget {
  const FamilyStoreScreen({super.key, required this.familyId});

  final String familyId;

  @override
  ConsumerState<FamilyStoreScreen> createState() => _FamilyStoreScreenState();
}

class _FamilyStoreScreenState extends ConsumerState<FamilyStoreScreen> {
  List<dynamic>? _items;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(lifeIntelligenceApiProvider).getFamilyStore(widget.familyId);
      if (mounted) setState(() => _items = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('familyStore.title'))),
      body: _errorMessage != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(t('common.error'), textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    FilledButton(onPressed: _load, child: Text(t('common.retry'))),
                  ],
                ),
              ),
            )
          : _items == null
              ? const Center(child: CircularProgressIndicator())
              : _items!.isEmpty
                  ? Center(child: Text(t('familyStore.empty')))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: GridView.builder(
                        padding: const EdgeInsets.all(16),
                        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 2,
                          mainAxisSpacing: 12,
                          crossAxisSpacing: 12,
                          childAspectRatio: 1.1,
                        ),
                        itemCount: _items!.length,
                        itemBuilder: (context, index) {
                          final item = _items![index] as Map<String, dynamic>;
                          return Container(
                            padding: const EdgeInsets.all(16),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(16),
                              boxShadow: [BoxShadow(color: AppTheme.amber500.withOpacity(0.10), blurRadius: 12, offset: const Offset(0, 4))],
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Container(
                                  width: 40,
                                  height: 40,
                                  decoration: const BoxDecoration(color: Color(0x1FE0A458), shape: BoxShape.circle),
                                  child: const Icon(Icons.card_giftcard_rounded, color: AppTheme.amber500, size: 20),
                                ),
                                Text(
                                  item['title'] as String? ?? '',
                                  style: Theme.of(context).textTheme.titleMedium,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                Row(
                                  children: [
                                    const Icon(Icons.monetization_on_rounded, color: AppTheme.amber500, size: 16),
                                    const SizedBox(width: 4),
                                    Text(
                                      '${item['costCoins']} ${t('familyStore.coins')}',
                                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
