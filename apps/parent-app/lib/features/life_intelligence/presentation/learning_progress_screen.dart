import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// Sprint 16.1 Phase 7 — CLOSES A REAL GAP: LearningEngineService
/// (Goals/Sessions/Assessments/Progress/Streak) existed in the
/// backend since an earlier sprint, with a real API endpoint, but had
/// ZERO representation anywhere in the Parent App — a parent had no
/// way to see their child's education progress at all. Mirrors
/// HealthTrendScreen's own exact visual pattern (gradient hero +
/// metric rows) for consistency across this app's screens.
class LearningProgressScreen extends ConsumerStatefulWidget {
  const LearningProgressScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<LearningProgressScreen> createState() => _LearningProgressScreenState();
}

class _LearningProgressScreenState extends ConsumerState<LearningProgressScreen> {
  Map<String, dynamic>? _progress;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(lifeIntelligenceApiProvider).getLearningProgress(widget.childId);
      if (mounted) setState(() => _progress = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('learningProgress.title')} — ${widget.childName}')),
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
          : _progress == null
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(vertical: 24),
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            colors: [AppTheme.guardian950.withOpacity(0.85), AppTheme.guardian950.withOpacity(0.6)],
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                          ),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Column(
                          children: [
                            Text(t('learningProgress.streak'), style: Theme.of(context).textTheme.labelLarge?.copyWith(color: Colors.white70)),
                            const SizedBox(height: 8),
                            Text(
                              t('learningProgress.streakDays', options: {'count': _progress!['streakDays']}),
                              style: Theme.of(context).textTheme.displaySmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w700),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      _MetricRow(icon: Icons.menu_book_rounded, color: AppTheme.sage500, label: t('learningProgress.sessions'), value: '${_progress!['totalSessions']}'),
                      _MetricRow(icon: Icons.timer_rounded, color: const Color(0xFF3D8FB4), label: t('learningProgress.minutes'), value: '${_progress!['totalMinutes']}'),
                      _MetricRow(
                        icon: Icons.quiz_rounded,
                        color: AppTheme.amber500,
                        label: t('learningProgress.avgScore'),
                        value: _progress!['averageAssessmentScore'] != null ? '${(_progress!['averageAssessmentScore'] as num).toStringAsFixed(0)}%' : t('learningProgress.notYetAvailable'),
                      ),
                    ],
                  ),
                ),
    );
  }
}

class _MetricRow extends StatelessWidget {
  const _MetricRow({required this.icon, required this.color, required this.label, required this.value});

  final IconData icon;
  final Color color;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        leading: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(color: color.withOpacity(0.14), shape: BoxShape.circle),
          child: Icon(icon, color: color, size: 20),
        ),
        title: Text(label),
        trailing: Text(value, style: Theme.of(context).textTheme.titleMedium?.copyWith(color: color, fontWeight: FontWeight.w700)),
      ),
    );
  }
}
