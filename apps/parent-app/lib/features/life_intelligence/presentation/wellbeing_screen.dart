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
      final result = await ref.read(lifeIntelligenceApiProvider).getWellbeingSnapshot(widget.childId);
      if (mounted) {
        setState(() {
          _snapshot = result;
          _hasData = result != null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
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
