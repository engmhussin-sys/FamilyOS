import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: was plain text-on-card since Sprint 20 — this screen
/// is the single most important one in the app (the whole point of
/// Life Intelligence Platform, aggregated), so it earns the most
/// deliberate visual treatment: a real circular progress ring for the
/// Growth Score (matching the visual LANGUAGE the Child App's ring
/// uses, in this app's own professional palette instead), and
/// icon-led, color-coded sub-score rows instead of a plain
/// ExpansionTile list.
class DigitalTwinScreen extends ConsumerStatefulWidget {
  const DigitalTwinScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<DigitalTwinScreen> createState() => _DigitalTwinScreenState();
}

class _SubScoreMeta {
  const _SubScoreMeta(this.key, this.labelKey, this.icon);
  final String key;
  final String labelKey;
  final IconData icon;
}

class _DigitalTwinScreenState extends ConsumerState<DigitalTwinScreen> {
  Map<String, dynamic>? _twin;
  String? _errorMessage;

  static const _subScoreOrder = <_SubScoreMeta>[
    _SubScoreMeta('health', 'digitalTwin.health', Icons.favorite_rounded),
    _SubScoreMeta('learning', 'digitalTwin.learning', Icons.school_rounded),
    _SubScoreMeta('faith', 'digitalTwin.faith', Icons.mosque_rounded),
    _SubScoreMeta('habits', 'digitalTwin.habits', Icons.checklist_rounded),
    _SubScoreMeta('social', 'digitalTwin.social', Icons.groups_rounded),
    _SubScoreMeta('behavior', 'digitalTwin.behavior', Icons.psychology_rounded),
    _SubScoreMeta('safety', 'digitalTwin.safety', Icons.shield_rounded),
  ];

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
                      Text(widget.childName, style: Theme.of(context).textTheme.headlineMedium),
                      const SizedBox(height: 4),
                      Text(
                        t('digitalTwin.notARankingTool'),
                        style: Theme.of(context).textTheme.bodyMedium,
                      ),
                      const SizedBox(height: 16),
                      _GrowthScoreCard(twin: _twin!, t: t),
                      const SizedBox(height: 20),
                      ..._subScoreOrder.map(
                        (meta) => _SubScoreTile(
                          label: t(meta.labelKey),
                          icon: meta.icon,
                          subScore: _twin![meta.key] as Map<String, dynamic>?,
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
    final score = growthScore != null ? (growthScore['score'] as num).toDouble() : 0.0;

    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [AppTheme.guardian950, AppTheme.guardian950.withOpacity(0.85)],
        ),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 100,
            height: 100,
            child: TweenAnimationBuilder<double>(
              tween: Tween(begin: 0, end: score / 100),
              duration: const Duration(milliseconds: 900),
              curve: Curves.easeOutCubic,
              builder: (context, value, _) => CustomPaint(
                painter: _ScoreRingPainter(progress: value),
                child: Center(
                  child: growthScore != null
                      ? Text(
                          '${growthScore['score']}',
                          style: Theme.of(context).textTheme.headlineMedium?.copyWith(color: Colors.white, fontWeight: FontWeight.w700),
                        )
                      : const Icon(Icons.hourglass_empty_rounded, color: Colors.white54),
                ),
              ),
            ),
          ),
          const SizedBox(width: 20),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(t('digitalTwin.growthScore'), style: Theme.of(context).textTheme.titleMedium?.copyWith(color: Colors.white)),
                const SizedBox(height: 6),
                if (growthScore != null)
                  Text(
                    t(
                      'digitalTwin.basedOnSubScores',
                      options: {
                        'count': (growthScore['inputs'] as Map)['contributingSubScores'] as Object,
                        'total': (growthScore['inputs'] as Map)['totalPossibleSubScores'] as Object,
                      },
                    ),
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white70),
                  )
                else
                  Text(t('digitalTwin.notYetAvailable'), style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white70)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ScoreRingPainter extends CustomPainter {
  _ScoreRingPainter({required this.progress});
  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.width / 2 - 6;

    final track = Paint()
      ..color = Colors.white.withOpacity(0.15)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 8
      ..strokeCap = StrokeCap.round;
    canvas.drawCircle(center, radius, track);

    final arc = Paint()
      ..shader = const SweepGradient(colors: [AppTheme.sage500, AppTheme.amber500])
          .createShader(Rect.fromCircle(center: center, radius: radius))
      ..style = PaintingStyle.stroke
      ..strokeWidth = 8
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(Rect.fromCircle(center: center, radius: radius), -pi / 2, 2 * pi * progress, false, arc);
  }

  @override
  bool shouldRepaint(covariant _ScoreRingPainter oldDelegate) => oldDelegate.progress != progress;
}

class _SubScoreTile extends StatefulWidget {
  const _SubScoreTile({required this.label, required this.icon, required this.subScore, required this.t});

  final String label;
  final IconData icon;
  final Map<String, dynamic>? subScore;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  State<_SubScoreTile> createState() => _SubScoreTileState();
}

class _SubScoreTileState extends State<_SubScoreTile> {
  bool _expanded = false;

  Color _scoreColor(num score) {
    if (score >= 70) return AppTheme.sage500;
    if (score >= 40) return AppTheme.amber500;
    return AppTheme.brick500;
  }

  @override
  Widget build(BuildContext context) {
    final subScore = widget.subScore;
    final score = subScore != null ? subScore['score'] as num : null;
    final color = score != null ? _scoreColor(score) : Colors.grey;

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: ExpansionTile(
        enabled: subScore != null,
        onExpansionChanged: subScore == null ? null : (v) => setState(() => _expanded = v),
        leading: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(color: color.withOpacity(0.14), shape: BoxShape.circle),
          child: Icon(widget.icon, color: color, size: 20),
        ),
        title: Text(widget.label, style: Theme.of(context).textTheme.titleMedium),
        trailing: subScore == null
            ? Text(widget.t('digitalTwin.notYetAvailable'), style: Theme.of(context).textTheme.bodyMedium)
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('$score', style: Theme.of(context).textTheme.titleMedium?.copyWith(color: color, fontWeight: FontWeight.w700)),
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
                        .map((e) => Padding(
                              padding: const EdgeInsets.symmetric(vertical: 2),
                              child: Text('${e.key}: ${e.value}', style: Theme.of(context).textTheme.bodyMedium),
                            ))
                        .toList(),
                  ),
                ),
              ],
      ),
    );
  }
}
