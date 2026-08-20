import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: a real coin-icon badge for the cost instead of plain
/// trailing text — the reward store is meant to feel like a store,
/// not a settings list.
///
/// ERROR PASS: the fetch went straight to the API and ended in
/// `_errorMessage = e.toString()` — raw transport text held in state,
/// with a generic `common.error` painted over it. It now reads through
/// `LifeIntelligenceRepository` (which converts and logs the original)
/// and renders the failure with the shared `DsErrorState`.
class FamilyStoreScreen extends ConsumerStatefulWidget {
  const FamilyStoreScreen({super.key, required this.familyId});

  final String familyId;

  @override
  ConsumerState<FamilyStoreScreen> createState() => _FamilyStoreScreenState();
}

class _FamilyStoreScreenState extends ConsumerState<FamilyStoreScreen> {
  List<dynamic>? _items;
  ApiFailure? _failure;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _failure = null);
    try {
      final result = await ref
          .read(lifeIntelligenceRepositoryProvider)
          .getFamilyStore(widget.familyId);
      if (mounted) setState(() => _items = result);
    } catch (error) {
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text(t('familyStore.title'))),
      body: _failure != null
          ? Center(
              child: DsErrorState(
                failure: _failure!,
                title: t('common.error'),
                retryLabel: t('common.retry'),
                requestIdLabel: t('common.requestId'),
                arabic: locale.isRtl,
                onRetry: _load,
              ),
            )
          : _items == null
              ? const DsSkeletonList(rows: 4)
              : _items!.isEmpty
                  ? Center(child: Text(t('familyStore.empty')))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: GridView.builder(
                        padding: const EdgeInsets.all(DsSpace.lg),
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
                            padding: const EdgeInsets.all(DsSpace.lg),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(DsRadius.card),
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
                                    const SizedBox(width: DsSpace.xs),
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
