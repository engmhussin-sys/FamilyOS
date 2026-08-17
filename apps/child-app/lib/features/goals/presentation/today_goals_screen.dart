import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/widgets/sparky_mascot.dart';
import '../domain/catalogue_domain.dart';
import '../domain/child_goal.dart';
import 'domain_chooser.dart';
import 'goal_detail_screen.dart';

/// أهداف اليوم — **THE CHILD'S FIRST SCREEN** as of B7.
///
/// THIS SCREEN IS THE ANSWER TO AUDIT PA-M-041 (🔴 High).
///
/// The finding, verbatim: «الشاشة الأولى التي يراها الطفل اسمها "حالة
/// الجهاز" وتعرض: نبض الاتصال، حالة التشغيل، التشخيص، الأذونات،
/// الإمكانيات، استخدام الذاكرة، نسبة البطارية … هذا console مراقبة، لا
/// مدرّب.» A child opened this product and was shown a diagnostics console
/// with their growth and rewards demoted to two buttons in the middle of it.
/// That inverts the entire wedge stated in CONTEXT §1 — the child app is
/// supposed to be a product a child WANTS to open.
///
/// The fix is structural, not cosmetic: `DeviceHomeScreen` is no longer the
/// paired-state landing screen (`app.dart` now lands on `ChildHomeShell`),
/// and everything it showed — permissions, capabilities, memory, battery,
/// enforcement status — now lives behind a single quiet icon in the app
/// bar. Nothing was deleted. It was demoted.
class TodayGoalsScreen extends ConsumerStatefulWidget {
  const TodayGoalsScreen({super.key});

  @override
  ConsumerState<TodayGoalsScreen> createState() => _TodayGoalsScreenState();
}

class _TodayGoalsScreenState extends ConsumerState<TodayGoalsScreen> {
  /// The chosen domain, or `null` for «كل حاجة».
  ///
  /// LOCAL, AND DELIBERATELY NOT PERSISTED. A filter that survives a restart
  /// is a filter a child forgets they set, and the failure mode is a child
  /// opening the app tomorrow and concluding they have no goals.
  String? _category;

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(todayGoalsControllerProvider);
    final controller = ref.read(todayGoalsControllerProvider.notifier);

    return RefreshIndicator(
      onRefresh: controller.load,
      child: KidStateView<List<TodayGoal>>(
        state: state,
        arabic: locale.isRtl,
        loadingLabel: t('today.loading'),
        emptyTitle: t('today.emptyTitle'),
        emptyBody: t('today.emptyBody'),
        errorTitle: t('today.errorTitle'),
        retryLabel: t('common.retry'),
        onRetry: controller.load,
        emptyActionLabel: t('common.retry'),
        onEmptyAction: controller.load,
        builder: (context, goals) {
          // THE REAL DOMAIN VOCABULARY, when it can be read. `valueOrNull` is
          // null while the call is in flight AND after it fails, and both
          // cases fall back to the domains of today's own goals — the chooser
          // is a decoration on this screen, never a reason for it to show a
          // spinner or an error.
          final catalogue = ref.watch(catalogueDomainsProvider).valueOrNull;
          final domains =
              domainsFromCatalogue(catalogue ?? const <CatalogueDomainRow>[], goals);

          // A domain that disappears between two loads must not leave the
          // screen filtered to nothing with no way back — the chip the child
          // tapped would no longer be on screen to un-tap.
          final selected =
              domains.any((d) => d.category == _category) ? _category : null;

          final visible = selected == null
              ? goals
              : goals.where((g) => g.category == selected).toList();

          // The greeting counts THE WHOLE DAY, never the filtered slice.
          // «فاضل لك هدفين» has to mean the day, or a child who filters to
          // one domain is told their day shrank.
          final ready = goals.where((g) => g.available).length;

          return ListView(
            padding: KidSpace.screen,
            children: [
              _Greeting(readyCount: ready, total: goals.length),
              KidSpace.gapLg,
              if (domains.length >= 2) ...[
                DomainChooser(
                  domains: domains,
                  selected: selected,
                  onSelected: (value) => setState(() => _category = value),
                ),
                KidSpace.gapLg,
              ],
              if (visible.isEmpty)
                // Reachable only with a filter on: the unfiltered empty day is
                // `KidStateView`'s own empty state, one level up.
                //
                // THE HONEST LIMIT, SAID OUT LOUD. Now that the chooser shows
                // the REAL catalogue, a child can pick a domain their parent
                // has programmed nothing in — and there is no button that can
                // fix that, because programs are parent-authored and the
                // server is the authority on what exists. So this says what is
                // true and names the actual way forward, which is a person:
                // «لسه مفيش هدف في المجال ده — كلّم ولي أمرك». No request
                // button, no "start something anyway", nothing that would let
                // a child believe they had asked for something when nobody
                // heard them.
                KidCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(t('today.domainEmpty'), style: KidText.body(context)),
                      KidSpace.gapMd,
                      KidQuietButton(
                        label: t('today.allDomains'),
                        icon: Icons.apps_rounded,
                        onPressed: () => setState(() => _category = null),
                      ),
                    ],
                  ),
                )
              else
                for (final goal in visible)
                  GoalCard(goal: goal, onRefresh: controller.load),
            ],
          );
        },
      ),
    );
  }
}

class _Greeting extends ConsumerWidget {
  const _Greeting({required this.readyCount, required this.total});

  final int readyCount;
  final int total;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(localeControllerProvider.notifier).t;
    return Row(
      children: [
        SparkyMascot(
          mood: readyCount > 0 ? SparkyMood.happy : SparkyMood.neutral,
          size: 64,
        ),
        KidSpace.hGapMd,
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(t('today.title'), style: KidText.screenTitle(context)),
              KidSpace.gapXs,
              Text(
                readyCount > 0
                    ? t('today.readyCount', options: {'count': readyCount})
                    : t('today.allDoneForNow'),
                style: KidText.caption(context),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// One goal, as a child reads it: the Arabic target, how long, what they
/// get. Nothing about verification methods, nothing about programs, nothing
/// about ids.
class GoalCard extends ConsumerWidget {
  const GoalCard({super.key, required this.goal, required this.onRefresh});

  final TodayGoal goal;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final reason = goal.unavailableReason;

    return KidCard(
      dimmed: !goal.available,
      accent: goal.available ? KidColor.primary : null,
      onTap: () async {
        await Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => GoalDetailScreen(goal: goal)),
        );
        await onRefresh();
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            goal.targetSummaryAr.isEmpty
                ? locale.tOrElse(
                    'category.${goal.category}',
                    t('category.unknown'),
                  )
                : goal.targetSummaryAr,
            style: KidText.cardTitle(context),
          ),
          KidSpace.gapSm,
          Wrap(
            spacing: KidSpace.sm,
            runSpacing: KidSpace.xs,
            children: [
              KidBadge(
                label: t('common.minutesValue', options: {'count': goal.durationMinutes}),
                icon: Icons.schedule_rounded,
              ),
              KidBadge(
                label: goal.reward.isPoints
                    ? t('today.pointsReward', options: {'count': goal.reward.amount})
                    : goal.reward.isScreenTime
                        ? t('today.screenTimeReward', options: {'count': goal.reward.amount})
                        : t('rewardType.${goal.reward.type}'),
                icon: Icons.star_rounded,
                color: KidColor.highlight,
              ),
            ],
          ),
          KidSpace.gapMd,
          if (goal.available)
            KidBadge(
              label: t('today.readyNow'),
              icon: Icons.play_circle_outline_rounded,
              color: KidColor.done,
            )
          else if (reason != null)
            // THE NON-PUNITIVE LINE, STRAIGHT FROM THE SERVER.
            // «أكملت هذا البرنامج مرة اليوم — وهذا هو الحد اليومي. نراك
            // غدًا!» is what F4 wrote; this widget renders it and adds
            // nothing. No lock icon, no strikethrough, no red.
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(KidSpace.md),
              decoration: BoxDecoration(
                color: KidColor.notNow.withOpacity(0.16),
                borderRadius: KidRadius.controlBorder,
              ),
              child: Row(
                children: [
                  Icon(
                    reason.isDoneForToday
                        ? Icons.check_circle_outline_rounded
                        : Icons.watch_later_outlined,
                    size: 20,
                    color: KidColor.ink,
                  ),
                  KidSpace.hGapSm,
                  Expanded(
                    child: Text(
                      reason.messageAr.isEmpty ? t('today.notNow') : reason.messageAr,
                      style: KidText.caption(context),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
