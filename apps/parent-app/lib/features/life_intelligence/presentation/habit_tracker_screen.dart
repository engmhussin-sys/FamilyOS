import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: was a plain ListTile-per-row list — now has a colored
/// left-edge accent and category icon, matching the same visual
/// language established across the other elevated screens in this app.
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
      // Best-effort single action.
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
                          final isDone = habit['completedToday'] as bool? ?? false;
                          return Container(
                            margin: const EdgeInsets.only(bottom: 10),
                            decoration: BoxDecoration(
                              color: isDone ? AppTheme.sage500.withOpacity(0.06) : Colors.white,
                              borderRadius: BorderRadius.circular(14),
                              boxShadow: isDone
                                  ? null
                                  : [BoxShadow(color: AppTheme.guardian950.withOpacity(0.06), blurRadius: 12, offset: const Offset(0, 4))],
                            ),
                            child: Padding(
                              padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
                              child: Row(
                                children: [
                                  Container(
                                    width: 40,
                                    height: 40,
                                    decoration: BoxDecoration(color: AppTheme.sage500.withOpacity(0.14), shape: BoxShape.circle),
                                    child: const Icon(Icons.checklist_rounded, color: AppTheme.sage500, size: 20),
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          habit['title'] as String? ?? '',
                                          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                                decoration: isDone ? TextDecoration.lineThrough : null,
                                              ),
                                        ),
                                        Text(
                                          isShared
                                              ? '${habit['category']} \u00b7 ${t('habitTracker.shared')}'
                                              : '${habit['category']}',
                                          style: Theme.of(context).textTheme.bodyMedium,
                                        ),
                                      ],
                                    ),
                                  ),
                                  if (isDone)
                                    const Icon(Icons.check_circle_rounded, color: AppTheme.sage500, size: 28)
                                  else
                                    FilledButton(
                                      onPressed: () => _complete(habit['id'] as String),
                                      child: Text(t('habitTracker.markDone')),
                                    ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
