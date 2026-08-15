import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../domain/achievement.dart';

/// AI SUGGESTIONS — ADVISORY ONLY.
///
/// `GET /reward-programs/suggestions/:childId` returns DRAFTS and creates
/// nothing. `POST /reward-programs/suggestions/accept` is the only door,
/// and it needs an explicit tap from a parent.
///
/// THE BANNER AT THE TOP IS NOT DECORATION. CONTEXT §3 principle 2 says the
/// AI may not create, grant, or bypass a parent. A screen that showed these
/// as ready-made goals — or worse, auto-created them — would break that
/// principle at the only layer a user can see it. So the copy says, in
/// plain Arabic, that nothing here exists until the parent says so.
class SuggestionsScreen extends ConsumerWidget {
  const SuggestionsScreen({super.key, required this.childId, this.childName});

  final String childId;
  final String? childName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(suggestionsControllerProvider(childId));
    final controller = ref.read(suggestionsControllerProvider(childId).notifier);

    return Scaffold(
      appBar: AppBar(
        title: Text(t('suggestions.title')),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            tooltip: t('common.retry'),
            onPressed: controller.load,
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: controller.load,
        child: DsStateView<List<ProgramSuggestion>>(
          state: state.items,
          arabic: locale.isRtl,
          loadingLabel: t('suggestions.loading'),
          emptyTitle: t('suggestions.emptyTitle'),
          emptyBody: t('suggestions.emptyBody'),
          emptyIcon: Icons.lightbulb_outline_rounded,
          errorTitle: t('suggestions.errorTitle'),
          retryLabel: t('common.retry'),
          requestIdLabel: t('common.requestId'),
          onRetry: controller.load,
          builder: (context, items) => ListView(
            padding: DsSpace.screen,
            children: [
              DsCard(
                accent: DsColor.warn,
                child: Text(t('suggestions.advisoryNotice'), style: DsText.body(context)),
              ),
              if (state.accepted != null) ...[
                DsSuccessBanner(
                  message: t('suggestions.accepted'),
                  onDismiss: controller.clearAccepted,
                ),
              ],
              if (state.actionFailure != null) ...[
                DsErrorState(
                  failure: state.actionFailure!,
                  title: t('suggestions.acceptFailedTitle'),
                  retryLabel: t('common.dismiss'),
                  requestIdLabel: t('common.requestId'),
                  arabic: locale.isRtl,
                  compact: true,
                  onRetry: controller.clearFailure,
                ),
              ],
              DsSpace.gapMd,
              for (final suggestion in items)
                DsCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // `previewAr` is composed server-side —
                      // «قرآن · الآيات 1–5 من سورة الملك · 20 دقيقة · 20 نقطة».
                      Text(suggestion.previewAr, style: DsText.cardTitle(context)),
                      if (suggestion.rationaleAr.isNotEmpty) ...[
                        DsSpace.gapSm,
                        Text(suggestion.rationaleAr, style: DsText.caption(context)),
                      ],
                      DsSpace.gapLg,
                      DsPrimaryButton(
                        label: t('suggestions.accept'),
                        icon: Icons.add_rounded,
                        busy: state.busyId == suggestion.suggestionId,
                        onPressed: () => controller.accept(suggestion.suggestionId),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
