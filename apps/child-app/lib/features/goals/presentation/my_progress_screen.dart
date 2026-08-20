import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../application/progress_controller.dart';
import '../domain/child_rewards.dart';
import 'my_attempts_screen.dart';

/// «تقدّمي» — points, level, the five streaks, and badges.
///
/// ON BADGES: audit C10 marked this ⛔ («`ChildBadgeAward` يُكتب خادميًا ولا
/// يقرؤه أحد») — the awards had been written server-side since Sprint 13
/// and no client could read one. B7's first pass said so honestly and shipped
/// a placeholder rather than inventing a client-side badge rule. The backend
/// agent then added `GET /self/achievements/badges` in B5, so this section is
/// now a real list of real awards, titled with the SERVER's own `title` and
/// `description` — the client has no badge catalogue and must not invent a
/// name for an id it does not recognise.
class MyProgressScreen extends ConsumerWidget {
  const MyProgressScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(progressControllerProvider);
    final controller = ref.read(progressControllerProvider.notifier);

    return RefreshIndicator(
      onRefresh: controller.load,
      child: KidStateView<ProgressSnapshot>(
        state: state,
        arabic: locale.isRtl,
        loadingLabel: t('progress.loading'),
        emptyTitle: t('progress.emptyTitle'),
        emptyBody: t('progress.emptyBody'),
        errorTitle: t('progress.errorTitle'),
        retryLabel: t('common.retry'),
        onRetry: controller.load,
        builder: (context, snapshot) => ListView(
          padding: KidSpace.screen,
          children: [
            KidSectionHeader(title: t('progress.pointsSection')),
            if (snapshot.account == null)
              KidCard(child: Text(t('progress.pointsUnavailable'), style: KidText.caption(context)))
            else
              Row(
                children: [
                  Expanded(
                    child: KidStatTile(
                      value: snapshot.account!.points.toString(),
                      label: t('progress.points'),
                      icon: Icons.star_rounded,
                      color: KidColor.highlight,
                    ),
                  ),
                  KidSpace.hGapMd,
                  Expanded(
                    child: KidStatTile(
                      value: snapshot.account!.level.toString(),
                      label: t('progress.level'),
                      icon: Icons.military_tech_rounded,
                      color: KidColor.magic,
                    ),
                  ),
                ],
              ),
            KidSpace.gapLg,
            KidSectionHeader(
              title: t('progress.streaksSection'),
              subtitle: t('progress.streaksHint'),
            ),
            if (snapshot.streaks == null)
              KidCard(child: Text(t('progress.streaksUnavailable'), style: KidText.caption(context)))
            else if (snapshot.streaks!.isEmpty)
              KidCard(child: Text(t('progress.streaksNoneYet'), style: KidText.body(context)))
            else
              for (final kind in StreakSet.kinds)
                KidCard(
                  padding: const EdgeInsets.all(KidSpace.md),
                  accent: snapshot.streaks!.of(kind) > 0 ? KidColor.done : null,
                  child: Row(
                    children: [
                      Icon(_streakIcon(kind), color: KidColor.primary),
                      KidSpace.hGapMd,
                      Expanded(
                        child: Text(t('streak.$kind'), style: KidText.cardTitle(context)),
                      ),
                      KidBadge(
                        label: t('progress.streakDays',
                            options: {'count': snapshot.streaks!.of(kind)}),
                        color: snapshot.streaks!.of(kind) > 0 ? KidColor.done : KidColor.mutedInk,
                        icon: Icons.local_fire_department_rounded,
                      ),
                    ],
                  ),
                ),
            KidSpace.gapLg,
            KidSectionHeader(
              title: t('progress.badgesSection'),
              subtitle: t('progress.badgesHint'),
            ),
            if (snapshot.badges.isEmpty)
              KidCard(
                child: Row(
                  children: [
                    const Icon(Icons.workspace_premium_outlined, color: KidColor.magic, size: 28),
                    KidSpace.hGapMd,
                    Expanded(
                      child: Text(t('progress.badgesNoneYet'), style: KidText.body(context)),
                    ),
                  ],
                ),
              )
            else
              for (final badge in snapshot.badges)
                KidCard(
                  padding: const EdgeInsets.all(KidSpace.md),
                  accent: KidColor.magic,
                  child: Row(
                    children: [
                      const Icon(Icons.workspace_premium_rounded, color: KidColor.magic, size: 30),
                      KidSpace.hGapMd,
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              // Server-authored. A missing title falls back to
                              // a neutral word, never to the raw badge id.
                              badge.title?.isNotEmpty == true
                                  ? badge.title!
                                  : t('progress.badgeUnnamed'),
                              style: KidText.cardTitle(context),
                            ),
                            if (badge.description?.isNotEmpty == true) ...[
                              KidSpace.gapXs,
                              Text(badge.description!, style: KidText.caption(context)),
                            ],
                          ],
                        ),
                      ),
                      if (badge.isGroupAchievement)
                        KidBadge(
                          label: t('progress.badgeShared'),
                          color: KidColor.warm,
                          icon: Icons.groups_rounded,
                        ),
                    ],
                  ),
                ),
            KidSpace.gapLg,
            KidQuietButton(
              label: t('progress.openAttempts'),
              icon: Icons.history_rounded,
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const MyAttemptsScreen()),
              ),
            ),
          ],
        ),
      ),
    );
  }

  static IconData _streakIcon(String kind) {
    switch (kind) {
      case 'quran':
        return Icons.menu_book_rounded;
      case 'reading':
        return Icons.auto_stories_rounded;
      case 'exercise':
        return Icons.directions_run_rounded;
      case 'behaviour':
        return Icons.volunteer_activism_rounded;
      default:
        return Icons.school_rounded;
    }
  }
}
