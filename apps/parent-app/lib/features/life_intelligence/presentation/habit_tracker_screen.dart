import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: was a plain ListTile-per-row list — now has a colored
/// left-edge accent and category icon, matching the same visual
/// language established across the other elevated screens in this app.
class HabitTrackerScreen extends ConsumerStatefulWidget {
  const HabitTrackerScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<HabitTrackerScreen> createState() => _HabitTrackerScreenState();
}

class _HabitTrackerScreenState extends ConsumerState<HabitTrackerScreen> {
  List<dynamic>? _habits;
  ApiFailure? _failure;

  /// A refused \u00ab\u062a\u0645 \u0627\u0644\u0625\u0646\u062c\u0627\u0632\u00bb, kept apart from [_failure] \u2014 the list is fine,
  /// one action was not. Frequently the server saying \u00ab\u0633\u064f\u062c\u0651\u0644\u062a \u0647\u0630\u0647 \u0627\u0644\u0639\u0627\u062f\u0629
  /// \u0627\u0644\u064a\u0648\u0645 \u0628\u0627\u0644\u0641\u0639\u0644\u00bb, which is a "not now" and must not look like a breakage.
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
          await ref.read(lifeIntelligenceRepositoryProvider).getHabits(widget.childId);
      if (mounted) setState(() => _habits = result);
    } catch (error) {
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    }
  }

  Future<void> _complete(String habitId) async {
    setState(() => _actionFailure = null);
    try {
      await ref
          .read(lifeIntelligenceRepositoryProvider)
          .completeHabit(widget.childId, habitId);
    } catch (error) {
      // WAS `catch (_) {}`. The reload underneath hid the refusal
      // completely: the row simply stayed un-ticked with no explanation.
      if (mounted) setState(() => _actionFailure = ApiFailure.from(error));
    }
    await _load();
  }

  /// The habit's category as a parent should read it.
  ///
  /// `habit['category']` is whatever the creating client stored (the DTO
  /// accepts any 1\u201350 character string), and in practice that is an
  /// uppercase token like `HEALTH` or `STUDY` \u2014 which this screen used to
  /// print verbatim under the habit title. Where this app already has a
  /// label for the token it is used; a genuinely free-text category is
  /// parent-authored content and is shown as written.
  String _categoryLabel(LocaleController locale, Object? raw) {
    final value = raw is String ? raw.trim() : '';
    if (value.isEmpty) return '';
    final key = 'category.$value';
    return locale.has(key) ? locale.t(key) : value;
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('habitTracker.title')} \u2014 ${widget.childName}')),
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
          : _habits == null
              ? const DsSkeletonList(rows: 4)
              : Column(
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
                    Expanded(
                      child: _habits!.isEmpty
                            ? Center(child: Text(t('habitTracker.empty')))
                            : RefreshIndicator(
                                onRefresh: _load,
                                child: ListView.builder(
                                  padding: const EdgeInsets.all(DsSpace.lg),
                                  itemCount: _habits!.length,
                                  itemBuilder: (context, index) {
                                    final habit = _habits![index] as Map<String, dynamic>;
                                    final isShared = habit['isShared'] as bool? ?? false;
                                    final isDone = habit['completedToday'] as bool? ?? false;
                                    final category = _categoryLabel(locale, habit['category']);
                                    return Container(
                                      margin: const EdgeInsets.only(bottom: DsSpace.sm),
                                      decoration: BoxDecoration(
                                        color: isDone ? AppTheme.sage500.withOpacity(0.06) : Colors.white,
                                        borderRadius: BorderRadius.circular(DsRadius.card),
                                        boxShadow: isDone
                                            ? null
                                            : [BoxShadow(color: AppTheme.guardian950.withOpacity(0.06), blurRadius: 12, offset: const Offset(0, 4))],
                                      ),
                                      child: Padding(
                                        padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
                                        child: Row(
                                          children: [
                                            Container(
                                              width: 40,
                                              height: 40,
                                              decoration: BoxDecoration(color: AppTheme.sage500.withOpacity(0.14), shape: BoxShape.circle),
                                              child: const Icon(Icons.checklist_rounded, color: AppTheme.sage500, size: 20),
                                            ),
                                            const SizedBox(width: DsSpace.md),
                                            Expanded(
                                              child: Column(
                                                crossAxisAlignment: CrossAxisAlignment.start,
                                                children: [
                                                  Text(
                                                    habit['title'] as String? ?? '',
                                                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                                          decoration: isDone ? TextDecoration.lineThrough : null,
                                                        ),
                                                  ),
                                                  Text(
                                                    isShared
                                                        ? '$category \u00b7 ${t('habitTracker.shared')}'
                                                        : category,
                                                    style: Theme.of(context).textTheme.bodyMedium,
                                                  ),
                                                ],
                                              ),
                                            ),
                                            if (isDone)
                                              const Icon(Icons.check_circle_rounded, color: AppTheme.sage500, size: 28)
                                            else
                                              FilledButton(
                                                onPressed: () => _complete(habit['id'] as String),
                                                child: Text(t('habitTracker.markDone')),
                                              ),
                                          ],
                                        ),
                                      ),
                                    );
                                  },
                                ),
                              ),
                    ),
                  ],
                ),
    );
  }
}
