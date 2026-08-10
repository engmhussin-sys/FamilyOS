import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

/// DESIGN PASS: same icon+completion-state treatment as
/// HabitTrackerScreen, using a distinct purple accent for the Faith
/// domain — matching the same color used for it on Digital Twin and
/// Life Timeline, so a parent learns "purple = faith" consistently
/// across every screen in this app.
class FaithProgressScreen extends ConsumerStatefulWidget {
  const FaithProgressScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<FaithProgressScreen> createState() => _FaithProgressScreenState();
}

class _FaithProgressScreenState extends ConsumerState<FaithProgressScreen> {
  static const _faithAccent = Color(0xFF6B5B95);

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
      // Best-effort single action.
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
                          final isDone = practice['completedToday'] as bool? ?? false;
                          return Container(
                            margin: const EdgeInsets.only(bottom: 10),
                            decoration: BoxDecoration(
                              color: isDone ? _faithAccent.withOpacity(0.06) : Colors.white,
                              borderRadius: BorderRadius.circular(14),
                              boxShadow: isDone
                                  ? null
                                  : [BoxShadow(color: _faithAccent.withOpacity(0.08), blurRadius: 12, offset: const Offset(0, 4))],
                            ),
                            child: Padding(
                              padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
                              child: Row(
                                children: [
                                  Container(
                                    width: 40,
                                    height: 40,
                                    decoration: BoxDecoration(color: _faithAccent.withOpacity(0.14), shape: BoxShape.circle),
                                    child: const Icon(Icons.mosque_rounded, color: _faithAccent, size: 20),
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Text(
                                      practice['title'] as String? ?? '',
                                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                            decoration: isDone ? TextDecoration.lineThrough : null,
                                          ),
                                    ),
                                  ),
                                  if (isDone)
                                    const Icon(Icons.check_circle_rounded, color: _faithAccent, size: 28)
                                  else
                                    FilledButton(
                                      onPressed: () => _log(practice['id'] as String),
                                      style: FilledButton.styleFrom(backgroundColor: _faithAccent),
                                      child: Text(t('faithProgress.logToday')),
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
