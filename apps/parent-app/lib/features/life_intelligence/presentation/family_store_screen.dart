import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

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
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _items!.length,
                        itemBuilder: (context, index) {
                          final item = _items![index] as Map<String, dynamic>;
                          return Card(
                            margin: const EdgeInsets.only(bottom: 8),
                            child: ListTile(
                              title: Text(item['title'] as String? ?? ''),
                              trailing: Text(
                                '${item['costCoins']} ${t('familyStore.coins')}',
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
