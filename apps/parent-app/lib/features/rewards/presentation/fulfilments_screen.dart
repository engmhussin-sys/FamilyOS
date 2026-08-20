import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../domain/fulfilment.dart';

/// THE FULFILMENT QUEUE — «سلّمتُ المكافأة».
///
/// `GET /reward-programs/fulfilments?status=` and
/// `PATCH /reward-programs/fulfilments/:id`.
///
/// A row here exists because a child EARNED a physical, digital, privilege,
/// approval or custom reward and the ledger already recorded it. What is
/// outstanding is the real-world act — handing over the book, allowing the
/// outing. The state machine is PENDING → APPROVED → FULFILLED | DECLINED
/// and this screen renders exactly the buttons that machine permits from
/// the row's current state, and no others (audit P17).
class FulfilmentsScreen extends ConsumerWidget {
  const FulfilmentsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(fulfilmentsControllerProvider);
    final controller = ref.read(fulfilmentsControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: Text(t('fulfilments.title'))),
      body: Column(
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: DsSpace.lg, vertical: DsSpace.sm),
            child: Row(
              children: [
                ChoiceChip(
                  label: Text(t('fulfilments.filterAll')),
                  selected: state.statusFilter == null,
                  onSelected: (_) => controller.setFilter(null),
                ),
                for (final status in FulfilmentStatuses.all) ...[
                  const SizedBox(width: DsSpace.sm),
                  ChoiceChip(
                    label: Text(t('fulfilmentStatus.$status')),
                    selected: state.statusFilter == status,
                    onSelected: (_) => controller.setFilter(status),
                  ),
                ],
              ],
            ),
          ),
          if (state.lastMovedTo != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: DsSpace.lg),
              child: DsSuccessBanner(
                message: t('fulfilments.moved', options: {
                  'status': t('fulfilmentStatus.${state.lastMovedTo}'),
                }),
                onDismiss: controller.clearMoved,
              ),
            ),
          if (state.actionFailure != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: DsSpace.lg),
              child: DsErrorState(
                failure: state.actionFailure!,
                title: t('fulfilments.actionFailedTitle'),
                retryLabel: t('common.dismiss'),
                requestIdLabel: t('common.requestId'),
                arabic: locale.isRtl,
                compact: true,
                onRetry: controller.clearFailure,
              ),
            ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: controller.load,
              child: DsStateView<List<RewardFulfilment>>(
                state: state.items,
                arabic: locale.isRtl,
                loadingLabel: t('common.loading'),
                emptyTitle: t('fulfilments.emptyTitle'),
                emptyBody: t('fulfilments.emptyBody'),
                emptyIcon: Icons.redeem_outlined,
                errorTitle: t('fulfilments.errorTitle'),
                retryLabel: t('common.retry'),
                requestIdLabel: t('common.requestId'),
                onRetry: controller.load,
                builder: (context, rows) => ListView(
                  padding: DsSpace.screen,
                  children: [
                    for (final row in rows)
                      _FulfilmentCard(
                        fulfilment: row,
                        busy: state.busyId == row.id,
                        onMove: (to) => controller.move(row.id, to),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FulfilmentCard extends ConsumerWidget {
  const _FulfilmentCard({
    required this.fulfilment,
    required this.busy,
    required this.onMove,
  });

  final RewardFulfilment fulfilment;
  final bool busy;
  final void Function(String to) onMove;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(localeControllerProvider.notifier).t;
    return DsCard(
      accent: _color(fulfilment.status),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  fulfilment.description.isEmpty
                      ? t('rewardType.${fulfilment.rewardType}')
                      : fulfilment.description,
                  style: DsText.cardTitle(context),
                ),
              ),
              DsBadge(
                label: t('fulfilmentStatus.${fulfilment.status}'),
                color: _color(fulfilment.status),
              ),
            ],
          ),
          DsSpace.gapSm,
          Wrap(
            spacing: DsSpace.sm,
            runSpacing: DsSpace.xs,
            children: [
              DsBadge(label: t('rewardType.${fulfilment.rewardType}')),
              if (fulfilment.quantity > 1)
                DsBadge(
                  label: t('fulfilments.quantity', options: {'count': fulfilment.quantity}),
                ),
            ],
          ),
          if (fulfilment.isTerminal) ...[
            DsSpace.gapMd,
            Text(t('fulfilments.terminalHint'), style: DsText.caption(context)),
          ] else ...[
            DsSpace.gapLg,
            // EXACTLY the transitions the state machine permits from here.
            for (final next in fulfilment.allowedTransitions)
              Padding(
                padding: const EdgeInsets.only(bottom: DsSpace.sm),
                child: next == FulfilmentStatuses.declined
                    ? DsSecondaryButton(
                        label: t('fulfilments.action.$next'),
                        danger: true,
                        onPressed: busy ? null : () => onMove(next),
                      )
                    : DsPrimaryButton(
                        label: t('fulfilments.action.$next'),
                        busy: busy,
                        onPressed: () => onMove(next),
                      ),
              ),
          ],
        ],
      ),
    );
  }

  static Color _color(String status) {
    switch (status) {
      case FulfilmentStatuses.fulfilled:
        return DsColor.stateSuccess;
      case FulfilmentStatuses.approved:
        return DsColor.accent;
      case FulfilmentStatuses.declined:
        return DsColor.stateMuted;
      default:
        return DsColor.statePending;
    }
  }
}
