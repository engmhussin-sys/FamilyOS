import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../domain/reward_program.dart';
import 'program_detail_screen.dart';
import 'program_wizard_screen.dart';

/// THE ASSIGNED GOALS — `GET /reward-programs?childId=`.
///
/// The entry point to the create flow lives here rather than on the
/// dashboard, so "goals" is one place with one list and one plus button.
class ProgramsListScreen extends ConsumerWidget {
  const ProgramsListScreen({super.key, this.childId, this.childName});

  final String? childId;
  final String? childName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(programsControllerProvider(childId));
    final controller = ref.read(programsControllerProvider(childId).notifier);

    return Scaffold(
      appBar: AppBar(
        title: Text(childName == null
            ? t('programs.title')
            : t('programs.titleForChild', options: {'name': childName!})),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh_rounded),
            tooltip: t('common.retry'),
            onPressed: controller.load,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openWizard(context, ref),
        icon: const Icon(Icons.add_rounded),
        label: Text(t('programs.create')),
      ),
      body: RefreshIndicator(
        onRefresh: controller.load,
        child: DsStateView<List<RewardProgram>>(
          state: state,
          arabic: locale.isRtl,
          loadingLabel: t('programs.loading'),
          emptyTitle: t('programs.emptyTitle'),
          emptyBody: t('programs.emptyBody'),
          emptyIcon: Icons.flag_outlined,
          emptyActionLabel: t('programs.create'),
          onEmptyAction: () => _openWizard(context, ref),
          errorTitle: t('programs.errorTitle'),
          retryLabel: t('common.retry'),
          requestIdLabel: t('common.requestId'),
          onRetry: controller.load,
          builder: (context, programs) => ListView(
            padding: const EdgeInsets.fromLTRB(DsSpace.lg, DsSpace.lg, DsSpace.lg, 96),
            children: [
              for (final program in programs)
                ProgramCard(
                  program: program,
                  onTap: () async {
                    await Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => ProgramDetailScreen(programId: program.id),
                      ),
                    );
                    await controller.load();
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _openWizard(BuildContext context, WidgetRef ref) async {
    final created = await Navigator.of(context).push<RewardProgram>(
      MaterialPageRoute(
        builder: (_) => ProgramWizardScreen(
          initialChildId: childId,
          initialChildName: childName,
        ),
      ),
    );
    if (created != null) {
      await ref.read(programsControllerProvider(childId).notifier).load();
    }
  }
}

/// One goal, as a parent reads it: the Arabic target summary the SERVER
/// derived, the duration, the reward, and the status.
class ProgramCard extends ConsumerWidget {
  const ProgramCard({super.key, required this.program, this.onTap});

  final RewardProgram program;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(localeControllerProvider.notifier).t;
    return DsCard(
      onTap: onTap,
      accent: _statusColor(program.status),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  program.targetSummaryAr.isEmpty
                      ? t('category.${program.category}')
                      : program.targetSummaryAr,
                  style: DsText.cardTitle(context),
                ),
              ),
              DsSpace.hGapSm,
              DsBadge(
                label: t('programStatus.${program.status}'),
                color: _statusColor(program.status),
              ),
            ],
          ),
          DsSpace.gapSm,
          Wrap(
            spacing: DsSpace.sm,
            runSpacing: DsSpace.xs,
            children: [
              DsBadge(
                label: t('common.minutesValue', options: {'count': program.durationMinutes}),
                icon: Icons.schedule_rounded,
              ),
              DsBadge(
                label: '${t('rewardType.${program.rewardSpec.type}')} ${program.rewardSpec.amount}',
                icon: Icons.card_giftcard_rounded,
                color: DsColor.accent,
              ),
              DsBadge(
                label: t('programs.perDay', options: {'count': program.maxPerDay}),
                icon: Icons.repeat_rounded,
              ),
              if (!program.isChildSpecific)
                DsBadge(label: t('wizard.allChildren'), icon: Icons.groups_outlined),
            ],
          ),
        ],
      ),
    );
  }

  static Color _statusColor(String status) {
    switch (status) {
      case ProgramStatuses.active:
        return DsColor.stateSuccess;
      case ProgramStatuses.paused:
        return DsColor.statePending;
      case ProgramStatuses.archived:
        return DsColor.stateMuted;
      default:
        return DsColor.ink;
    }
  }
}
