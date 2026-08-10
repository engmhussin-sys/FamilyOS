import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

class LifeTimelineScreen extends ConsumerStatefulWidget {
  const LifeTimelineScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<LifeTimelineScreen> createState() => _LifeTimelineScreenState();
}

class _LifeTimelineScreenState extends ConsumerState<LifeTimelineScreen> {
  List<dynamic>? _events;
  String? _errorMessage;
  String? _category;

  static const _categories = ['HEALTH', 'LEARNING', 'FAITH', 'REWARDS', 'SAFETY', 'HABITS', 'FAMILY'];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _errorMessage = null);
    try {
      final result = await ref.read(lifeIntelligenceApiProvider).getTimeline(widget.childId, category: _category);
      if (mounted) setState(() => _events = result);
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('lifeTimeline.title')} \u2014 ${widget.childName}')),
      body: Column(
        children: [
          SizedBox(
            height: 44,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              children: [
                _CategoryChip(
                  label: t('lifeTimeline.all'),
                  selected: _category == null,
                  onTap: () {
                    setState(() => _category = null);
                    _load();
                  },
                ),
                ..._categories.map(
                  (c) => _CategoryChip(
                    label: t('lifeTimeline.category.${c.toLowerCase()}'),
                    selected: _category == c,
                    onTap: () {
                      setState(() => _category = c);
                      _load();
                    },
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: _errorMessage != null
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
                : _events == null
                    ? const Center(child: CircularProgressIndicator())
                    : _events!.isEmpty
                        ? Center(child: Text(t('lifeTimeline.empty')))
                        : RefreshIndicator(
                            onRefresh: _load,
                            child: ListView.builder(
                              padding: const EdgeInsets.all(16),
                              itemCount: _events!.length,
                              itemBuilder: (context, index) {
                                final event = _events![index] as Map<String, dynamic>;
                                return ListTile(
                                  leading: const Icon(Icons.circle, size: 10),
                                  title: Text(event['title'] as String? ?? ''),
                                  subtitle: Text(_formatDate(event['occurredAt'] as String?)),
                                );
                              },
                            ),
                          ),
          ),
        ],
      ),
    );
  }

  String _formatDate(String? iso) {
    if (iso == null) return '';
    final date = DateTime.tryParse(iso);
    if (date == null) return '';
    return '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
  }
}

class _CategoryChip extends StatelessWidget {
  const _CategoryChip({required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: ChoiceChip(label: Text(label), selected: selected, onSelected: (_) => onTap()),
    );
  }
}
