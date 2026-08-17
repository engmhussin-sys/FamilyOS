import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
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
  ApiFailure? _failure;

  /// A refused \u00ab\u0633\u062c\u0651\u0644 \u0643\u0648\u0628 \u0645\u0627\u0621\u00bb. Separate from [_failure] because the score
  /// above it is still valid and still worth reading \u2014 one rejected log
  /// must not blank the screen.
  ApiFailure? _actionFailure;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _failure = null);
    try {
      final result =
          await ref.read(lifeIntelligenceRepositoryProvider).getHealthScore(widget.childId);
      if (mounted) setState(() => _health = result);
    } catch (error) {
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    }
  }

  Future<void> _logGlassOfWater() async {
    setState(() => _actionFailure = null);
    try {
      await ref.read(lifeIntelligenceRepositoryProvider).logHydration(widget.childId, 250);
    } catch (error) {
      // WAS `catch (_) {}`. The reload underneath meant a refused log and a
      // successful one looked the same: the hydration row simply did not
      // move, and the parent had no way to know which had happened.
      if (mounted) setState(() => _actionFailure = ApiFailure.from(error));
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('healthTrend.title')} \u2014 ${widget.childName}')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _logGlassOfWater,
        icon: const Icon(Icons.water_drop_rounded),
        label: Text(t('healthTrend.logWater')),
      ),
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
          : _health == null
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      if (_actionFailure != null)
                        DsErrorState(
                          failure: _actionFailure!,
                          title: t('lifeIntelligence.actionFailedTitle'),
                          retryLabel: t('common.dismiss'),
                          requestIdLabel: t('common.requestId'),
                          arabic: locale.isRtl,
                          compact: true,
                          onRetry: () => setState(() => _actionFailure = null),
                        ),
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
                              _scoreText(t),
                              style: Theme.of(context).textTheme.displaySmall?.copyWith(color: Colors.white, fontWeight: FontWeight.w700),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      _MetricRow(icon: Icons.water_drop_rounded, color: const Color(0xFF3D8FB4), label: t('healthTrend.hydration'), value: _hydrationText(t)),
                      _MetricRow(icon: Icons.directions_run_rounded, color: AppTheme.sage500, label: t('healthTrend.activity'), value: _activityText(t)),
                      _MetricRow(icon: Icons.bedtime_rounded, color: const Color(0xFF6B5B95), label: t('healthTrend.sleep'), value: _sleepText(t)),
                      _MetricRow(icon: Icons.restaurant_rounded, color: AppTheme.amber500, label: t('healthTrend.meals'), value: _mealsText(t)),
                    ],
                  ),
                ),
    );
  }

  /// EVERY READER BELOW USED TO BE AN UNCHECKED CAST.
  ///
  /// `_health!['breakdown'] as Map`, then `breakdown['hydration'] as Map` —
  /// four of them, all inside `build`. A backend that stops sending one
  /// optional section (the health engine returns a partial breakdown when a
  /// device has not synced) turned every one of those into a cast error
  /// DURING BUILD, which is a red screen and a stack trace on the parent's
  /// phone — the exact outcome the error work elsewhere in this screen
  /// exists to prevent. `healthTrend.notLogged` is the honest answer for a
  /// section that is not there, and it is a string this screen already had.
  Map<String, dynamic>? get _breakdown {
    final raw = _health?['breakdown'];
    return raw is Map<String, dynamic> ? raw : null;
  }

  String _scoreText(String Function(String, {int? count, Map<String, Object>? options}) t) {
    final score = _health?['score'];
    return score is num ? '$score' : t('healthTrend.notLogged');
  }

  String _hydrationText(String Function(String, {int? count, Map<String, Object>? options}) t) {
    final hydration = _breakdown?['hydration'];
    if (hydration is! Map) return t('healthTrend.notLogged');
    final actual = hydration['actualMl'];
    final target = hydration['targetMl'];
    if (actual is! num || target is! num) return t('healthTrend.notLogged');
    // WAS a hardcoded 'ml' — a user-facing unit sitting outside the resource
    // maps, so it stayed Latin script in an Arabic RTL line.
    return '$actual / $target ${t('healthTrend.millilitres')}';
  }

  String _activityText(String Function(String, {int? count, Map<String, Object>? options}) t) {
    final activity = _breakdown?['activity'];
    if (activity is! Map) return t('healthTrend.notLogged');
    final minutes = activity['totalMinutes'];
    if (minutes is! num) return t('healthTrend.notLogged');
    return '$minutes ${t('healthTrend.minutes')}';
  }

  String _sleepText(String Function(String, {int? count, Map<String, Object>? options}) t) {
    final sleepHours = _breakdown?['sleepHours'];
    if (sleepHours is! num) return t('healthTrend.notLogged');
    return '${sleepHours.toStringAsFixed(1)} ${t('healthTrend.hours')}';
  }

  String _mealsText(String Function(String, {int? count, Map<String, Object>? options}) t) {
    final count = _breakdown?['nutritionLogsCount'];
    return count is num ? '$count' : t('healthTrend.notLogged');
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
