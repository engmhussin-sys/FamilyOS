import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
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
          .getLearningProgress(widget.childId);
      if (mounted) setState(() => _progress = result);
    } catch (error) {
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    }
  }

  /// `streakDays`, `totalSessions` and `totalMinutes` were read straight out
  /// of the map and interpolated. A missing one printed «null» into an
  /// Arabic sentence, and `streakDays` went into the plural machinery as an
  /// `Object`, so a null there was a type error inside build.
  num? _number(String key) {
    final value = _progress?[key];
    return value is num ? value : null;
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('learningProgress.title')} — ${widget.childName}')),
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
                              _number('streakDays') == null
                                  ? t('learningProgress.notYetAvailable')
                                  : t('learningProgress.streakDays',
                                      options: {'count': _number('streakDays')!}),
                              style: Theme.of(context).textTheme.displaySmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w700),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      _MetricRow(
                        icon: Icons.menu_book_rounded,
                        color: AppTheme.sage500,
                        label: t('learningProgress.sessions'),
                        value: _number('totalSessions')?.toString() ?? t('learningProgress.notYetAvailable'),
                      ),
                      _MetricRow(
                        icon: Icons.timer_rounded,
                        color: const Color(0xFF3D8FB4),
                        label: t('learningProgress.minutes'),
                        value: _number('totalMinutes')?.toString() ?? t('learningProgress.notYetAvailable'),
                      ),
                      _MetricRow(
                        icon: Icons.quiz_rounded,
                        color: AppTheme.amber500,
                        label: t('learningProgress.avgScore'),
                        value: _number('averageAssessmentScore') != null
                            ? '${_number('averageAssessmentScore')!.toStringAsFixed(0)}%'
                            : t('learningProgress.notYetAvailable'),
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
