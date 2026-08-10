import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

class HabitTrackerScreen extends ConsumerStatefulWidget {
  const HabitTrackerScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<HabitTrackerScreen> createState() => _HabitTrackerScreenState();
}

class _HabitTrackerScreenState extends ConsumerState<HabitTrackerScreen> {
  List<dynamic>? _habits;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(lifeIntelligenceApiProvider).getHabits(widget.childId);
      if (mounted) setState(() => _habits = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  Future<void> _complete(String habitId) async {
    try {
      await ref.read(lifeIntelligenceApiProvider).completeHabit(widget.childId, habitId);
    } catch (_) {
      // Best-effort single action — the list refresh below is the
      // only feedback; matches this app's own NotificationsScreen
      // pattern for similarly low-stakes retry-safe actions.
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('habitTracker.title')} \u2014 ${widget.childName}')),
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
          : _habits == null
              ? const Center(child: CircularProgressIndicator())
              : _habits!.isEmpty
                  ? Center(child: Text(t('habitTracker.empty')))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _habits!.length,
                        itemBuilder: (context, index) {
                          final habit = _habits![index] as Map<String, dynamic>;
                          final isShared = habit['isShared'] as bool? ?? false;
                          return Card(
                            margin: const EdgeInsets.only(bottom: 8),
                            child: ListTile(
                              title: Text(habit['title'] as String? ?? ''),
                              subtitle: Text(
                                isShared
                                    ? '${habit['category']} \u00b7 ${t('habitTracker.shared')}'
                                    : '${habit['category']}',
                              ),
                              trailing: FilledButton(
                                onPressed: () => _complete(habit['id'] as String),
                                child: Text(t('habitTracker.markDone')),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
