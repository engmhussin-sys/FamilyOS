import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

class DigitalTwinScreen extends ConsumerStatefulWidget {
  const DigitalTwinScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<DigitalTwinScreen> createState() => _DigitalTwinScreenState();
}

class _DigitalTwinScreenState extends ConsumerState<DigitalTwinScreen> {
  Map<String, dynamic>? _twin;
  String? _errorMessage;

  static const _subScoreOrder = <String, String>{
    'health': 'digitalTwin.health',
    'learning': 'digitalTwin.learning',
    'faith': 'digitalTwin.faith',
    'habits': 'digitalTwin.habits',
    'social': 'digitalTwin.social',
    'behavior': 'digitalTwin.behavior',
    'safety': 'digitalTwin.safety',
  };

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(lifeIntelligenceApiProvider).getDigitalTwin(widget.childId);
      if (mounted) setState(() => _twin = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('digitalTwin.title'))),
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
          : _twin == null
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      Text(widget.childName, style: Theme.of(context).textTheme.titleLarge),
                      const SizedBox(height: 4),
                      Text(
                        t('digitalTwin.notARankingTool'),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      const SizedBox(height: 16),
                      _GrowthScoreCard(twin: _twin!, t: t),
                      const SizedBox(height: 16),
                      ..._subScoreOrder.entries.map(
                        (entry) => _SubScoreTile(
                          label: t(entry.value),
                          subScore: _twin![entry.key] as Map<String, dynamic>?,
                          t: t,
                        ),
                      ),
                    ],
                  ),
                ),
    );
  }
}

class _GrowthScoreCard extends StatelessWidget {
  const _GrowthScoreCard({required this.twin, required this.t});

  final Map<String, dynamic> twin;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    final growthScore = twin['growthScore'] as Map<String, dynamic>?;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            Text(t('digitalTwin.growthScore'), style: Theme.of(context).textTheme.labelLarge),
            const SizedBox(height: 8),
            if (growthScore != null) ...[
              Text(
                '${growthScore['score']}',
                style: Theme.of(context).textTheme.displaySmall?.copyWith(fontWeight: FontWeight.bold),
              ),
              Text(
                t(
                  'digitalTwin.basedOnSubScores',
                  options: {
                    'count': (growthScore['inputs'] as Map)['contributingSubScores'] as Object,
                    'total': (growthScore['inputs'] as Map)['totalPossibleSubScores'] as Object,
                  },
                ),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ] else
              Text(t('digitalTwin.notYetAvailable')),
          ],
        ),
      ),
    );
  }
}

class _SubScoreTile extends StatefulWidget {
  const _SubScoreTile({required this.label, required this.subScore, required this.t});

  final String label;
  final Map<String, dynamic>? subScore;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  State<_SubScoreTile> createState() => _SubScoreTileState();
}

class _SubScoreTileState extends State<_SubScoreTile> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final subScore = widget.subScore;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ExpansionTile(
        enabled: subScore != null,
        onExpansionChanged: subScore == null ? null : (v) => setState(() => _expanded = v),
        title: Text(widget.label),
        trailing: subScore == null
            ? Text(widget.t('digitalTwin.notYetAvailable'), style: Theme.of(context).textTheme.bodySmall)
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('${subScore['score']}', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(width: 8),
                  Icon(_expanded ? Icons.expand_less : Icons.expand_more),
                ],
              ),
        children: subScore == null
            ? const []
            : [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: (subScore['inputs'] as Map<String, dynamic>)
                        .entries
                        .map((e) => Text('${e.key}: ${e.value}', style: Theme.of(context).textTheme.bodySmall))
                        .toList(),
                  ),
                ),
              ],
      ),
    );
  }
}
