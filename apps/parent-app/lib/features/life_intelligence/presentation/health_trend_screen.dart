import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

class HealthTrendScreen extends ConsumerStatefulWidget {
  const HealthTrendScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<HealthTrendScreen> createState() => _HealthTrendScreenState();
}

class _HealthTrendScreenState extends ConsumerState<HealthTrendScreen> {
  Map<String, dynamic>? _health;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(lifeIntelligenceApiProvider).getHealthScore(widget.childId);
      if (mounted) setState(() => _health = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  Future<void> _logGlassOfWater() async {
    try {
      // 250ml — a standard glass, matching the quick-log convenience
      // this project's own quick-action patterns favor over a form
      // for the single most common health action.
      await ref.read(lifeIntelligenceApiProvider).logHydration(widget.childId, 250);
    } catch (_) {
      // Best-effort — same pattern as HabitTrackerScreen's own quick action.
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('healthTrend.title')} \u2014 ${widget.childName}')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _logGlassOfWater,
        icon: const Icon(Icons.water_drop_outlined),
        label: Text(t('healthTrend.logWater')),
      ),
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
          : _health == null
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(20),
                          child: Column(
                            children: [
                              Text(t('healthTrend.score'), style: Theme.of(context).textTheme.labelLarge),
                              const SizedBox(height: 8),
                              Text(
                                '${_health!['score']}',
                                style: Theme.of(context).textTheme.displaySmall?.copyWith(fontWeight: FontWeight.bold),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      _buildBreakdownTile(context, t, 'healthTrend.hydration', _hydrationText()),
                      _buildBreakdownTile(context, t, 'healthTrend.activity', _activityText(t)),
                      _buildBreakdownTile(context, t, 'healthTrend.sleep', _sleepText(t)),
                      _buildBreakdownTile(context, t, 'healthTrend.meals', '${(_health!['breakdown'] as Map)['nutritionLogsCount']}'),
                    ],
                  ),
                ),
    );
  }

  String _hydrationText() {
    final breakdown = _health!['breakdown'] as Map;
    final hydration = breakdown['hydration'] as Map;
    return '${hydration['actualMl']} / ${hydration['targetMl']} ml';
  }

  String _activityText(String Function(String, {int? count, Map<String, Object>? options}) t) {
    final breakdown = _health!['breakdown'] as Map;
    final activity = breakdown['activity'] as Map;
    return '${activity['totalMinutes']} ${t('healthTrend.minutes')}';
  }

  String _sleepText(String Function(String, {int? count, Map<String, Object>? options}) t) {
    final breakdown = _health!['breakdown'] as Map;
    final sleepHours = breakdown['sleepHours'];
    if (sleepHours == null) return t('healthTrend.notLogged');
    return '${(sleepHours as num).toStringAsFixed(1)} ${t('healthTrend.hours')}';
  }

  Widget _buildBreakdownTile(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    String labelKey,
    String value,
  ) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(title: Text(t(labelKey)), trailing: Text(value, style: Theme.of(context).textTheme.titleMedium)),
    );
  }
}
