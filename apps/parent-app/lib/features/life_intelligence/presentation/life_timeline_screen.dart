import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: was a plain ListTile-per-row list with a generic
/// filled-circle icon on every row regardless of category — this is
/// now a real connected timeline (a vertical line linking each dot,
/// the actual visual metaphor "timeline" implies), with a distinct
/// icon and color per category so a parent can scan the whole history
/// at a glance rather than reading every title.
class LifeTimelineScreen extends ConsumerStatefulWidget {
  const LifeTimelineScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<LifeTimelineScreen> createState() => _LifeTimelineScreenState();
}

class _CategoryMeta {
  const _CategoryMeta(this.icon, this.color);
  final IconData icon;
  final Color color;
}

const _categoryMeta = <String, _CategoryMeta>{
  'HEALTH': _CategoryMeta(Icons.favorite_rounded, AppTheme.brick500),
  'LEARNING': _CategoryMeta(Icons.school_rounded, Color(0xFF3D6FB4)),
  'FAITH': _CategoryMeta(Icons.mosque_rounded, Color(0xFF6B5B95)),
  'REWARDS': _CategoryMeta(Icons.emoji_events_rounded, AppTheme.amber500),
  'SAFETY': _CategoryMeta(Icons.shield_rounded, AppTheme.guardian950),
  'HABITS': _CategoryMeta(Icons.checklist_rounded, AppTheme.sage500),
  'FAMILY': _CategoryMeta(Icons.groups_rounded, Color(0xFFB4653D)),
};

class _LifeTimelineScreenState extends ConsumerState<LifeTimelineScreen> {
  List<dynamic>? _events;
  ApiFailure? _failure;
  String? _category;

  static const _categories = ['HEALTH', 'LEARNING', 'FAITH', 'REWARDS', 'SAFETY', 'HABITS', 'FAMILY'];

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
          .getTimeline(widget.childId, category: _category);
      if (mounted) setState(() => _events = result);
    } catch (error) {
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('lifeTimeline.title')} \u2014 ${widget.childName}')),
      body: Column(
        children: [
          SizedBox(
            height: 48,
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
                    color: _categoryMeta[c]?.color,
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
            child: _failure != null
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
                : _events == null
                    ? const Center(child: CircularProgressIndicator())
                    : _events!.isEmpty
                        ? Center(child: Text(t('lifeTimeline.empty')))
                        : RefreshIndicator(
                            onRefresh: _load,
                            child: ListView.builder(
                              padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                              itemCount: _events!.length,
                              itemBuilder: (context, index) {
                                final event = _events![index] as Map<String, dynamic>;
                                final category = event['category'] as String?;
                                final meta = _categoryMeta[category] ?? const _CategoryMeta(Icons.circle_rounded, Colors.grey);
                                final isLast = index == _events!.length - 1;
                                return _TimelineRow(
                                  icon: meta.icon,
                                  color: meta.color,
                                  title: event['title'] as String? ?? '',
                                  date: _formatDate(event['occurredAt'] as String?),
                                  showConnector: !isLast,
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

class _TimelineRow extends StatelessWidget {
  const _TimelineRow({
    required this.icon,
    required this.color,
    required this.title,
    required this.date,
    required this.showConnector,
  });

  final IconData icon;
  final Color color;
  final String title;
  final String date;
  final bool showConnector;

  @override
  Widget build(BuildContext context) {
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(color: color.withOpacity(0.14), shape: BoxShape.circle),
                child: Icon(icon, color: color, size: 18),
              ),
              if (showConnector) Expanded(child: Container(width: 2, color: color.withOpacity(0.15))),
            ],
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 2),
                  Text(date, style: Theme.of(context).textTheme.bodyMedium),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CategoryChip extends StatelessWidget {
  const _CategoryChip({required this.label, required this.selected, required this.onTap, this.color});

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final chipColor = color ?? AppTheme.guardian950;
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: ChoiceChip(
        label: Text(label),
        selected: selected,
        onSelected: (_) => onTap(),
        selectedColor: chipColor.withOpacity(0.16),
        labelStyle: TextStyle(color: selected ? chipColor : null, fontWeight: selected ? FontWeight.w600 : null),
        side: BorderSide(color: selected ? chipColor.withOpacity(0.3) : Colors.transparent),
      ),
    );
  }
}
