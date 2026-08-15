import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../domain/child_achievement.dart';

/// «محاولاتي» — `GET /self/achievements/mine`.
///
/// A child's own record of what they tried. Every status is phrased as a
/// stage, never as a verdict: «خلصت!», «عند ولي أمرك», «شغّالة عليها»,
/// «مش دلوقتي». There is no «مرفوض» in this list, because F4 keeps a
/// rejected attempt's program open for tomorrow and calling it a rejection
/// would tell the child something the system does not mean.
class MyAttemptsScreen extends ConsumerWidget {
  const MyAttemptsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(myAttemptsControllerProvider);
    final controller = ref.read(myAttemptsControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: Text(t('attempts.title'))),
      body: RefreshIndicator(
        onRefresh: controller.load,
        child: KidStateView<List<MyAttempt>>(
          state: state,
          arabic: locale.isRtl,
          loadingLabel: t('common.loading'),
          emptyTitle: t('attempts.emptyTitle'),
          emptyBody: t('attempts.emptyBody'),
          errorTitle: t('attempts.errorTitle'),
          retryLabel: t('common.retry'),
          onRetry: controller.load,
          builder: (context, attempts) => ListView(
            padding: KidSpace.screen,
            children: [
              for (final attempt in attempts)
                KidCard(
                  padding: const EdgeInsets.all(KidSpace.md),
                  accent: attempt.isVerified
                      ? KidColor.done
                      : attempt.isWaiting
                          ? KidColor.waiting
                          : null,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              attempt.localDate ?? t('attempts.noDate'),
                              style: KidText.cardTitle(context),
                              // A stored business date, LTR.
                              textDirection: TextDirection.ltr,
                            ),
                          ),
                          KidBadge(
                            label: t('attemptStage.${attempt.status}'),
                            color: attempt.isVerified
                                ? KidColor.done
                                : attempt.isWaiting
                                    ? KidColor.waiting
                                    : KidColor.primary,
                          ),
                        ],
                      ),
                      KidSpace.gapSm,
                      Wrap(
                        spacing: KidSpace.sm,
                        runSpacing: KidSpace.xs,
                        children: [
                          if (attempt.elapsedMinutes != null)
                            KidBadge(
                              label: t('common.minutesValue',
                                  options: {'count': attempt.elapsedMinutes!}),
                              icon: Icons.schedule_rounded,
                            ),
                          if (attempt.grantedAmount != null && attempt.grantedAmount! > 0)
                            KidBadge(
                              label: t('attempts.earned',
                                  options: {'count': attempt.grantedAmount!}),
                              icon: Icons.star_rounded,
                              color: KidColor.highlight,
                            ),
                          if (attempt.streakDaysAtVerification != null &&
                              attempt.streakDaysAtVerification! > 0)
                            KidBadge(
                              label: t('attempts.streakThen',
                                  options: {'count': attempt.streakDaysAtVerification!}),
                              icon: Icons.local_fire_department_rounded,
                              color: KidColor.warm,
                            ),
                        ],
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
