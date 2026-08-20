import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../application/programs_controller.dart';
import '../domain/reward_program.dart';

/// ONE GOAL — `GET /reward-programs/:programId`, plus the three lifecycle
/// actions (`PATCH` pause/resume, `DELETE` archive).
///
/// WHAT IS DELIBERATELY NOT HERE: a delete button. `DELETE` on this route
/// ARCHIVES — it sets `archivedAt` and keeps every achievement and every
/// ledger row the program produced. Labelling it «حذف» would be a lie about
/// what the server does.
class ProgramDetailScreen extends ConsumerWidget {
  const ProgramDetailScreen({super.key, required this.programId});

  final String programId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(programDetailControllerProvider(programId));
    final controller = ref.read(programDetailControllerProvider(programId).notifier);

    ref.listen<ProgramDetailState>(programDetailControllerProvider(programId), (previous, next) {
      if (next.archived && previous?.archived != true) Navigator.of(context).pop(true);
    });

    return Scaffold(
      appBar: AppBar(title: Text(t('programDetail.title'))),
      body: DsStateView<RewardProgram>(
        state: state.program,
        arabic: locale.isRtl,
        loadingLabel: t('common.loading'),
        emptyTitle: t('programDetail.emptyTitle'),
        errorTitle: t('programDetail.errorTitle'),
        retryLabel: t('common.retry'),
        requestIdLabel: t('common.requestId'),
        onRetry: controller.load,
        builder: (context, program) => ListView(
          padding: DsSpace.screen,
          children: [
            if (state.actionFailure != null) ...[
              DsErrorState(
                failure: state.actionFailure!,
                title: t('programDetail.actionFailedTitle'),
                retryLabel: t('common.dismiss'),
                requestIdLabel: t('common.requestId'),
                arabic: locale.isRtl,
                compact: true,
                onRetry: controller.clearActionFailure,
              ),
              DsSpace.gapLg,
            ],
            DsCard(
              accent: program.isActive ? DsColor.stateSuccess : DsColor.statePending,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    program.targetSummaryAr.isEmpty
                        ? t('category.${program.category}')
                        : program.targetSummaryAr,
                    style: DsText.screenTitle(context),
                  ),
                  DsSpace.gapSm,
                  DsBadge(
                    label: t('programStatus.${program.status}'),
                    color: program.isActive ? DsColor.stateSuccess : DsColor.statePending,
                  ),
                ],
              ),
            ),
            DsSectionHeader(title: t('programDetail.whatSection')),
            DsCard(
              child: Column(
                children: [
                  DsKeyValueRow(
                    label: t('wizard.review.category'),
                    value: t('category.${program.category}'),
                  ),
                  DsKeyValueRow(
                    label: t('wizard.review.activity'),
                    value: t('activity.${program.activity}'),
                  ),
                  DsKeyValueRow(
                    label: t('wizard.review.duration'),
                    value: t('common.minutesValue', options: {'count': program.durationMinutes}),
                  ),
                  DsKeyValueRow(
                    label: t('wizard.review.verification'),
                    value: t('verification.${program.verificationLevel}'),
                  ),
                ],
              ),
            ),
            DsSectionHeader(title: t('programDetail.rewardSection')),
            DsCard(
              child: Column(
                children: [
                  DsKeyValueRow(
                    label: t('wizard.review.reward'),
                    value: t('rewardType.${program.rewardSpec.type}'),
                  ),
                  DsKeyValueRow(
                    label: t('programDetail.amount'),
                    value: program.rewardSpec.amount.toString(),
                  ),
                  if (program.rewardSpec.description != null &&
                      program.rewardSpec.description!.isNotEmpty)
                    DsKeyValueRow(
                      label: t('wizard.rewardDescription'),
                      value: program.rewardSpec.description!,
                    ),
                  if (program.streakMultiplierBps != null)
                    DsKeyValueRow(
                      label: t('programDetail.streakCeiling'),
                      value: t('programDetail.multiplierValue', options: {
                        'value': (program.streakMultiplierBps! / 10000).toStringAsFixed(1),
                      }),
                    ),
                ],
              ),
            ),
            DsSectionHeader(
              title: t('programDetail.rulesSection'),
              subtitle: t('programDetail.rulesHint'),
            ),
            DsCard(
              child: Column(
                children: [
                  DsKeyValueRow(
                    label: t('wizard.frequency'),
                    value: t('frequency.${program.frequency}'),
                  ),
                  DsKeyValueRow(
                    label: t('wizard.maxPerDay'),
                    value: program.maxPerDay.toString(),
                  ),
                  DsKeyValueRow(
                    label: t('wizard.maxPerWeek'),
                    value: program.maxPerWeek.toString(),
                  ),
                  if (program.difficulty != null)
                    DsKeyValueRow(
                      label: t('wizard.difficulty'),
                      value: t('difficulty.${program.difficulty}'),
                    ),
                  DsKeyValueRow(
                    label: t('wizard.requiresApproval'),
                    value: program.requiresParentApproval ? t('common.yes') : t('common.no'),
                  ),
                ],
              ),
            ),
            DsSpace.gapLg,
            if (!program.isArchived) ...[
              if (program.isActive)
                DsSecondaryButton(
                  label: t('programDetail.pause'),
                  icon: Icons.pause_rounded,
                  onPressed: state.busy ? null : controller.pause,
                )
              else
                DsPrimaryButton(
                  label: t('programDetail.resume'),
                  icon: Icons.play_arrow_rounded,
                  busy: state.busy,
                  onPressed: controller.resume,
                ),
              DsSpace.gapMd,
              DsSecondaryButton(
                label: t('programDetail.archive'),
                icon: Icons.inventory_2_outlined,
                danger: true,
                onPressed: state.busy ? null : () => _confirmArchive(context, t, controller),
              ),
              DsSpace.gapSm,
              Text(t('programDetail.archiveHint'), style: DsText.caption(context)),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _confirmArchive(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ProgramDetailController controller,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(t('programDetail.archiveConfirmTitle')),
        content: Text(t('programDetail.archiveConfirmBody')),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(t('common.cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(t('programDetail.archive')),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.archive();
  }
}
