import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: the score card is now a gradient hero (matching the
/// visual weight given to Digital Twin's Growth Score), and each
/// metric row gets its own icon and semantic color instead of a
/// plain ListTile.
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
      await ref.read(lifeIntelligenceApiProvider).logHydration(widget.childId, 250);
    } catch (_) {
      // Best-effort.
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
        icon: const Icon(Icons.water_drop_rounded),
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
                      Container(
                        padding: const EdgeInsets.symmetric(vertical: 24),
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            colors: [AppTheme.brick500.withOpacity(0.85), AppTheme.brick500.withOpacity(0.6)],
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                          ),
                          borderRadius: BorderRadius.circular(20),
                        ),
                        child: Column(
                          children: [
                            Text(t('healthTrend.score'), style: Theme.of(context).textTheme.labelLarge?.copyWith(color: Colors.white70)),
                            const SizedBox(height: 8),
                            Text(
                              '${_health!['score']}',
                              style: Theme.of(context).textTheme.displaySmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w700),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      _MetricRow(icon: Icons.water_drop_rounded, color: const Color(0xFF3D8FB4), label: t('healthTrend.hydration'), value: _hydrationText()),
                      _MetricRow(icon: Icons.directions_run_rounded, color: AppTheme.sage500, label: t('healthTrend.activity'), value: _activityText(t)),
                      _MetricRow(icon: Icons.bedtime_rounded, color: const Color(0xFF6B5B95), label: t('healthTrend.sleep'), value: _sleepText(t)),
                      _MetricRow(icon: Icons.restaurant_rounded, color: AppTheme.amber500, label: t('healthTrend.meals'), value: '${(_health!['breakdown'] as Map)['nutritionLogsCount']}'),
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
