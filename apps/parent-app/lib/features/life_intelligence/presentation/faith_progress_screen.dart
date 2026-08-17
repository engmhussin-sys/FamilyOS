import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';

/// DESIGN PASS: same icon+completion-state treatment as
/// HabitTrackerScreen, using a distinct purple accent for the Faith
/// domain — matching the same color used for it on Digital Twin and
/// Life Timeline, so a parent learns "purple = faith" consistently
/// across every screen in this app.
class FaithProgressScreen extends ConsumerStatefulWidget {
  const FaithProgressScreen({super.key, required this.childId, required this.childName});

  final String childId;
  final String childName;

  @override
  ConsumerState<FaithProgressScreen> createState() => _FaithProgressScreenState();
}

class _FaithProgressScreenState extends ConsumerState<FaithProgressScreen> {
  static const _faithAccent = Color(0xFF6B5B95);

  List<dynamic>? _practices;
  ApiFailure? _failure;

  /// A REFUSED \u00ab\u0633\u062c\u0651\u0644 \u0627\u0644\u064a\u0648\u0645\u00bb, kept apart from [_failure].
  ///
  /// The distinction is the whole point: [_failure] means the list could not
  /// be read and there is nothing to show, while this means the list is fine
  /// and one action did not go through. The server's own sentence here is
  /// frequently \u00ab\u0633\u062c\u0651\u0644\u062a \u0647\u0630\u0647 \u0627\u0644\u0645\u0645\u0627\u0631\u0633\u0629 \u0627\u0644\u064a\u0648\u0645 \u0628\u0627\u0644\u0641\u0639\u0644\u00bb \u2014 a "not now", not a
  /// breakage \u2014 so it is shown as a dismissible banner ABOVE the list, never
  /// as a full-screen error that would wipe out the practices.
  ApiFailure? _actionFailure;

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
          .getFaithPractices(widget.childId);
      if (mounted) setState(() => _practices = result);
    } catch (error) {
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    }
  }

  Future<void> _log(String practiceId) async {
    setState(() => _actionFailure = null);
    try {
      await ref
          .read(lifeIntelligenceRepositoryProvider)
          .logFaithPractice(widget.childId, practiceId);
    } catch (error) {
      // WAS `catch (_) {}` with a "best-effort single action" comment. The
      // reload that follows made a refused log look identical to a
      // successful one, so a parent tapped, saw nothing change, and tapped
      // again. The repository has logged the original; this shows the
      // server's own sentence for it.
      if (mounted) setState(() => _actionFailure = ApiFailure.from(error));
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('faithProgress.title')} \u2014 ${widget.childName}')),
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
          : _practices == null
              ? const Center(child: CircularProgressIndicator())
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
                      child: _practices!.isEmpty
                          ? Center(child: Text(t('faithProgress.empty')))
                          : RefreshIndicator(
                              onRefresh: _load,
                              child: ListView.builder(
                                padding: const EdgeInsets.all(16),
                                itemCount: _practices!.length,
                                itemBuilder: (context, index) {
                                  final practice = _practices![index] as Map<String, dynamic>;
                                  final isDone = practice['completedToday'] as bool? ?? false;
                                  return Container(
                                    margin: const EdgeInsets.only(bottom: 10),
                                    decoration: BoxDecoration(
                                      color: isDone ? _faithAccent.withOpacity(0.06) : Colors.white,
                                      borderRadius: BorderRadius.circular(14),
                                      boxShadow: isDone
                                          ? null
                                          : [BoxShadow(color: _faithAccent.withOpacity(0.08), blurRadius: 12, offset: const Offset(0, 4))],
                                    ),
                                    child: Padding(
                                      padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
                                      child: Row(
                                        children: [
                                          Container(
                                            width: 40,
                                            height: 40,
                                            decoration: BoxDecoration(color: _faithAccent.withOpacity(0.14), shape: BoxShape.circle),
                                            child: const Icon(Icons.mosque_rounded, color: _faithAccent, size: 20),
                                          ),
                                          const SizedBox(width: 12),
                                          Expanded(
                                            child: Text(
                                              practice['title'] as String? ?? '',
                                              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                                                    decoration: isDone ? TextDecoration.lineThrough : null,
                                                  ),
                                            ),
                                          ),
                                          if (isDone)
                                            const Icon(Icons.check_circle_rounded, color: _faithAccent, size: 28)
                                          else
                                            FilledButton(
                                              onPressed: () => _log(practice['id'] as String),
                                              style: FilledButton.styleFrom(backgroundColor: _faithAccent),
                                              child: Text(t('faithProgress.logToday')),
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
