import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

class FaithProgressScreen extends ConsumerStatefulWidget {
  const FaithProgressScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<FaithProgressScreen> createState() => _FaithProgressScreenState();
}

class _FaithProgressScreenState extends ConsumerState<FaithProgressScreen> {
  List<dynamic>? _practices;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(lifeIntelligenceApiProvider).getFaithPractices(widget.childId);
      if (mounted) setState(() => _practices = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  Future<void> _log(String practiceId) async {
    try {
      await ref.read(lifeIntelligenceApiProvider).logFaithPractice(widget.childId, practiceId);
    } catch (_) {
      // Best-effort single action — same pattern as HabitTrackerScreen.
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('faithProgress.title')} \u2014 ${widget.childName}')),
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
          : _practices == null
              ? const Center(child: CircularProgressIndicator())
              : _practices!.isEmpty
                  ? Center(child: Text(t('faithProgress.empty')))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _practices!.length,
                        itemBuilder: (context, index) {
                          final practice = _practices![index] as Map<String, dynamic>;
                          return Card(
                            margin: const EdgeInsets.only(bottom: 8),
                            child: ListTile(
                              title: Text(practice['title'] as String? ?? ''),
                              trailing: FilledButton(
                                onPressed: () => _log(practice['id'] as String),
                                child: Text(t('faithProgress.logToday')),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
