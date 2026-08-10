import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

class CoachingScreen extends ConsumerStatefulWidget {
  const CoachingScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<CoachingScreen> createState() => _CoachingScreenState();
}

class _CoachingScreenState extends ConsumerState<CoachingScreen> {
  List<dynamic>? _recommendations;
  String? _errorMessage;

  static const _trackLabelKeys = {
    'PARENT': 'coaching.track.parent',
    'CHILD': 'coaching.track.child',
    'FAMILY': 'coaching.track.family',
  };

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
                          final trackKey = _trackLabelKeys[rec['track'] as String? ?? 'PARENT']!;
                          return Card(
                            margin: const EdgeInsets.only(bottom: 8),
                            child: Padding(
                              padding: const EdgeInsets.all(16),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Chip(label: Text(t(trackKey)), visualDensity: VisualDensity.compact),
                                  const SizedBox(height: 8),
                                  Text(rec['title'] as String? ?? '', style: Theme.of(context).textTheme.titleMedium),
                                  const SizedBox(height: 4),
                                  Text(rec['body'] as String? ?? '', style: Theme.of(context).textTheme.bodyMedium),
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
