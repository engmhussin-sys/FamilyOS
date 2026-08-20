import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: each recommendation now has a colored left-edge
/// accent by track (parent/child/family) and an icon, instead of a
/// plain neutral Chip — a parent scanning several recommendations at
/// once can now tell at a glance which are "for you" to act on
/// versus "for the family" to discuss together.
///
/// ERROR PASS: `_errorMessage = e.toString()` is gone. It kept the raw
/// transport sentence in state and then rendered a generic
/// `common.error` over it, so the parent got no explanation and the
/// team got no diagnostic — the worst of both. The fetch now goes
/// through `LifeIntelligenceRepository`, which converts and LOGS, and
/// the screen renders the resulting [ApiFailure] through the shared
/// `DsErrorState` so the server's own Arabic finally lands on screen.
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

/// The row for a track name this build has never heard of. Its label is a
/// localised word, never the backend's own token.
const _unknownTrack = _TrackMeta('coaching.track.other', Icons.lightbulb_outline_rounded, AppTheme.guardian950);

class _CoachingScreenState extends ConsumerState<CoachingScreen> {
  List<dynamic>? _recommendations;
  ApiFailure? _failure;

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
          .getCoachingRecommendations(widget.childId);
      if (mounted) setState(() => _recommendations = result);
    } catch (error) {
      // The repository throws `ApiFailure` and has already logged the
      // original with its stack. `ApiFailure.from` is idempotent on one,
      // so this also covers anything thrown outside that boundary.
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(title: Text('${t('coaching.title')} \u2014 ${widget.childName}')),
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
          : _recommendations == null
              ? const DsSkeletonList(rows: 3)
              : _recommendations!.isEmpty
                  ? Center(child: Text(t('coaching.empty')))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.builder(
                        padding: const EdgeInsets.all(DsSpace.lg),
                        itemCount: _recommendations!.length,
                        itemBuilder: (context, index) {
                          final rec = _recommendations![index] as Map<String, dynamic>;
                          // WAS `_trackMeta[...]!`. A track this build does
                          // not know — the backend's coaching engine owns
                          // that vocabulary and can add to it — turned the
                          // `!` into a null check failure INSIDE build, i.e.
                          // a red screen and a stack trace on the parent's
                          // phone. An unknown track is now just a neutral
                          // row with a neutral label.
                          final meta = _trackMeta[rec['track']] ?? _unknownTrack;
                          return Container(
                            margin: const EdgeInsets.only(bottom: DsSpace.md),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(DsRadius.card),
                              boxShadow: [BoxShadow(color: meta.color.withOpacity(0.10), blurRadius: 14, offset: const Offset(0, 5))],
                            ),
                            child: Padding(
                              padding: const EdgeInsets.all(DsSpace.lg),
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Container(
                                    width: 4,
                                    height: 64,
                                    decoration: BoxDecoration(color: meta.color, borderRadius: BorderRadius.circular(2)),
                                  ),
                                  const SizedBox(width: DsSpace.md),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Row(
                                          children: [
                                            Icon(meta.icon, size: 14, color: meta.color),
                                            const SizedBox(width: DsSpace.xs),
                                            Text(t(meta.labelKey), style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: meta.color, fontWeight: FontWeight.w600)),
                                          ],
                                        ),
                                        const SizedBox(height: DsSpace.xs),
                                        Text(rec['title'] as String? ?? '', style: Theme.of(context).textTheme.titleMedium),
                                        const SizedBox(height: DsSpace.xs),
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
