import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';

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
              ? const DsSkeletonList(rows: 4, hero: true)
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: DsSpace.screen,
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
                      DsHeroPanel(
                        label: t('healthTrend.score'),
                        value: _scoreText(t),
                        base: DsColor.domainHealth,
                      ),
                      DsSpace.gapLg,
                      DsMetricRow(icon: Icons.water_drop_rounded, color: DsColor.domainHydration, label: t('healthTrend.hydration'), value: _hydrationText(t)),
                      DsMetricRow(icon: Icons.directions_run_rounded, color: DsColor.domainHabits, label: t('healthTrend.activity'), value: _activityText(t)),
                      DsMetricRow(icon: Icons.bedtime_rounded, color: DsColor.domainSleep, label: t('healthTrend.sleep'), value: _sleepText(t)),
                      DsMetricRow(icon: Icons.restaurant_rounded, color: DsColor.domainRewards, label: t('healthTrend.meals'), value: _mealsText(t)),
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

// REMOVED: a private `_MetricRow` that was one of four copies of the same
// widget across this feature (here, learning_progress_screen,
// digital_twin_screen and wellbeing_screen), each with its own leading
// swatch size and its own margin. It is `DsMetricRow` now.
