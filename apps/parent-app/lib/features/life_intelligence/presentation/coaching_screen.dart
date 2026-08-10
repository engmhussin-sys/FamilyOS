import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: each recommendation now has a colored left-edge
/// accent by track (parent/child/family) and an icon, instead of a
/// plain neutral Chip — a parent scanning several recommendations at
/// once can now tell at a glance which are "for you" to act on
/// versus "for the family" to discuss together.
class CoachingScreen extends ConsumerStatefulWidget {
  const CoachingScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<CoachingScreen> createState() => _CoachingScreenState();
}

class _TrackMeta {
  const _TrackMeta(this.labelKey, this.icon, this.color);
  final String labelKey;
  final IconData icon;
  final Color color;
}

const _trackMeta = <String, _TrackMeta>{
  'PARENT': _TrackMeta('coaching.track.parent', Icons.person_rounded, AppTheme.guardian950),
  'CHILD': _TrackMeta('coaching.track.child', Icons.child_care_rounded, AppTheme.sage500),
  'FAMILY': _TrackMeta('coaching.track.family', Icons.groups_rounded, AppTheme.amber500),
};

class _CoachingScreenState extends ConsumerState<CoachingScreen> {
  List<dynamic>? _recommendations;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(lifeIntelligenceApiProvider).getCoachingRecommendations(widget.childId);
      if (mounted) setState(() => _recommendations = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('coaching.title')} \u2014 ${widget.childName}')),
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
          : _recommendations == null
              ? const Center(child: CircularProgressIndicator())
              : _recommendations!.isEmpty
                  ? Center(child: Text(t('coaching.empty')))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: _recommendations!.length,
                        itemBuilder: (context, index) {
                          final rec = _recommendations![index] as Map<String, dynamic>;
                          final meta = _trackMeta[rec['track'] as String? ?? 'PARENT']!;
                          return Container(
                            margin: const EdgeInsets.only(bottom: 12),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(16),
                              boxShadow: [BoxShadow(color: meta.color.withOpacity(0.10), blurRadius: 14, offset: const Offset(0, 5))],
                            ),
                            child: Padding(
                              padding: const EdgeInsets.all(16),
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Container(
                                    width: 4,
                                    height: 64,
                                    decoration: BoxDecoration(color: meta.color, borderRadius: BorderRadius.circular(2)),
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Row(
                                          children: [
                                            Icon(meta.icon, size: 14, color: meta.color),
                                            const SizedBox(width: 5),
                                            Text(t(meta.labelKey), style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: meta.color, fontWeight: FontWeight.w600)),
                                          ],
                                        ),
                                        const SizedBox(height: 6),
                                        Text(rec['title'] as String? ?? '', style: Theme.of(context).textTheme.titleMedium),
                                        const SizedBox(height: 4),
                                        Text(rec['body'] as String? ?? '', style: Theme.of(context).textTheme.bodyLarge),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}
