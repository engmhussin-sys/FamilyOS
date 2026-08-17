import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// Edge-First Intelligence Architecture — Parent-facing view of the
/// locally-aggregated Daily Behavioral Snapshot. Displays averages
/// over a window, never raw per-event data.
class WellbeingScreen extends ConsumerStatefulWidget {
  const WellbeingScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<WellbeingScreen> createState() => _WellbeingScreenState();
}

class _WellbeingScreenState extends ConsumerState<WellbeingScreen> {
  Map<String, dynamic>? _snapshot;
  Map<String, dynamic>? _insight;
  bool _hasData = true;
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
          .getWellbeingSnapshot(widget.childId);
      if (mounted) {
        setState(() {
          _snapshot = result;
          // STILL THE THREE-WAY DISTINCTION THIS SCREEN ALWAYS HAD. `null`
          // from the backend means "no snapshot yet" — an honest absence,
          // not a failure — and renders `wellbeing.noData`. A thrown error
          // renders the error state. Neither may impersonate the other.
          _hasData = result != null;
        });
      }
    } catch (error) {
      if (mounted) setState(() => _failure = ApiFailure.from(error));
      return;
    }

    // FIXES A REAL BUG (Sprint 14.1 integration audit): fetched
    // SEPARATELY from the snapshot above, with its own try/catch —
    // Sprint 14's pattern data being unavailable (e.g. too little
    // history for a baseline yet) must never block the existing,
    // already-working rolling-average view above it.
    try {
      final insight = await ref
          .read(lifeIntelligenceRepositoryProvider)
          .getWellbeingInsight(widget.childId);
      if (mounted) setState(() => _insight = insight);
    } catch (_) {
      // Best-effort, and deliberately still silent HERE: the rolling
      // averages below have already rendered, and an insight that does not
      // exist yet is not something a parent can act on. It is no longer
      // invisible to the TEAM, though — the repository logged the original
      // error with its stack trace before this catch ever ran.
    }
  }

  /// EVERY FIGURE BELOW USED TO BE INTERPOLATED STRAIGHT OUT OF THE MAP.
  ///
  /// A field the backend omits printed the literal word «null» into an
  /// Arabic sentence, and the two `windowNote` figures went into a
  /// `Map<String, Object>` literal, where a null is a runtime type error
  /// INSIDE build — a red screen and a stack trace on the parent's phone,
  /// from a snapshot that was merely incomplete.
  num? _number(String key) {
    final value = _snapshot?[key];
    return value is num ? value : null;
  }

  String _minutesText(
    String Function(String, {int? count, Map<String, Object>? options}) t,
    String key,
  ) {
    final value = _number(key);
    return value == null
        ? t('wellbeing.notYetAvailable')
        : '$value ${t('wellbeing.minutesPerDay')}';
  }

  String _countText(
    String Function(String, {int? count, Map<String, Object>? options}) t,
    String key,
  ) {
    final value = _number(key);
    return value?.toString() ?? t('wellbeing.notYetAvailable');
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('wellbeing.title')} \u2014 ${widget.childName}')),
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
          : !_hasData
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(t('wellbeing.noData'), textAlign: TextAlign.center),
                  ),
                )
              : _snapshot == null
                  ? const Center(child: CircularProgressIndicator())
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView(
                        padding: const EdgeInsets.all(16),
                        children: [
                          if (_insight != null) _InsightCard(insight: _insight!, t: t),
                          _MetricCard(
                            icon: Icons.smartphone_rounded,
                            color: AppTheme.guardian950,
                            label: t('wellbeing.avgScreenTime'),
                            value: _minutesText(t, 'averageDailyScreenMinutes'),
                          ),
                          _MetricCard(
                            icon: Icons.touch_app_rounded,
                            color: AppTheme.sage500,
                            label: t('wellbeing.avgPickups'),
                            value: _countText(t, 'averagePickups'),
                          ),
                          _MetricCard(
                            icon: Icons.bedtime_rounded,
                            color: const Color(0xFF6B5B95),
                            label: t('wellbeing.nightUsage'),
                            value: _minutesText(t, 'averageNightUsageMinutes'),
                          ),
                          _MetricCard(
                            icon: Icons.block_rounded,
                            color: AppTheme.brick500,
                            label: t('wellbeing.blockedAttempts'),
                            value: _countText(t, 'totalBlockedAttempts'),
                          ),
                          const SizedBox(height: 8),
                          if (_number('windowDays') != null && _number('daysWithData') != null)
                            Text(
                              t('wellbeing.windowNote', options: {
                                'days': _number('windowDays')!,
                                'daysWithData': _number('daysWithData')!,
                              }),
                              style: Theme.of(context).textTheme.bodyMedium,
                              textAlign: TextAlign.center,
                            ),
                        ],
                      ),
                    ),
    );
  }
}

/// FIXES A REAL BUG (Sprint 14.1 integration audit): the parent-facing
/// display for Sprint 14's headline capability — today's detected
/// behavioral patterns, baseline deviation, a deterministic
/// human-readable summary, and (if applicable) a recommendation. All
/// text here comes directly from the backend's own deterministic
/// template (PatternDetectionService/DigitalWellbeingEngineService) —
/// zero LLM call for this display, matching Sprint 14's own explicit
/// "not every insight should cost an AI request" discipline.
class _InsightCard extends StatelessWidget {
  const _InsightCard({required this.insight, required this.t});

  final Map<String, dynamic> insight;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    final humanSummary = insight['humanSummary'] as String?;
    final recommendation = insight['recommendation'] as String?;
    final patterns = (insight['patterns'] as List<dynamic>?) ?? const [];

    if (humanSummary == null) return const SizedBox.shrink();

    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      color: AppTheme.sand50,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.insights_rounded, color: AppTheme.guardian950),
                const SizedBox(width: 8),
                Text(t('wellbeing.insightTitle'), style: Theme.of(context).textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 8),
            Text(humanSummary, style: Theme.of(context).textTheme.bodyLarge),
            if (patterns.isNotEmpty) ...[
              const SizedBox(height: 12),
              ...patterns.map((p) {
                final map = p as Map<String, dynamic>;
                final explanation = map['explanation'] as String? ?? '';
                final isPositive = map['isPositive'] as bool? ?? false;
                return Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        isPositive ? Icons.check_circle_outline_rounded : Icons.info_outline_rounded,
                        size: 18,
                        color: isPositive ? AppTheme.sage500 : AppTheme.amber500,
                      ),
                      const SizedBox(width: 8),
                      Expanded(child: Text(explanation, style: Theme.of(context).textTheme.bodyMedium)),
                    ],
                  ),
                );
              }),
            ],
            if (recommendation != null) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: AppTheme.guardian950.withOpacity(0.05), borderRadius: BorderRadius.circular(10)),
                child: Text(recommendation, style: Theme.of(context).textTheme.bodySmall),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _MetricCard extends StatelessWidget {
  const _MetricCard({required this.icon, required this.color, required this.label, required this.value});

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
