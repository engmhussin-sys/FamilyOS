import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
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
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final api = ref.read(lifeIntelligenceApiProvider);
      final result = await api.getWellbeingSnapshot(widget.childId);
      if (mounted) {
        setState(() {
          _snapshot = result;
          _hasData = result != null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
      return;
    }

    // FIXES A REAL BUG (Sprint 14.1 integration audit): fetched
    // SEPARATELY from the snapshot above, with its own try/catch —
    // Sprint 14's pattern data being unavailable (e.g. too little
    // history for a baseline yet) must never block the existing,
    // already-working rolling-average view above it.
    try {
      final insight = await ref.read(lifeIntelligenceApiProvider).getWellbeingInsight(widget.childId);
      if (mounted) setState(() => _insight = insight);
    } catch (_) {
      // Best-effort — the screen already rendered successfully above.
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('wellbeing.title')} \u2014 ${widget.childName}')),
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
                            value: '${_snapshot!['averageDailyScreenMinutes']} ${t('wellbeing.minutesPerDay')}',
                          ),
                          _MetricCard(
                            icon: Icons.touch_app_rounded,
                            color: AppTheme.sage500,
                            label: t('wellbeing.avgPickups'),
                            value: '${_snapshot!['averagePickups']}',
                          ),
                          _MetricCard(
                            icon: Icons.bedtime_rounded,
                            color: const Color(0xFF6B5B95),
                            label: t('wellbeing.nightUsage'),
                            value: '${_snapshot!['averageNightUsageMinutes']} ${t('wellbeing.minutesPerDay')}',
                          ),
                          _MetricCard(
                            icon: Icons.block_rounded,
                            color: AppTheme.brick500,
                            label: t('wellbeing.blockedAttempts'),
                            value: '${_snapshot!['totalBlockedAttempts']}',
                          ),
                          const SizedBox(height: 8),
                          Text(
                            t('wellbeing.windowNote', options: {'days': _snapshot!['windowDays'], 'daysWithData': _snapshot!['daysWithData']}),
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
