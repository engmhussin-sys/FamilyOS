import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../life_intelligence/presentation/coaching_screen.dart';
import '../../life_intelligence/presentation/learning_progress_screen.dart';
import '../../life_intelligence/presentation/wellbeing_screen.dart';
import '../../screen_time/presentation/screen_time_overview_screen.dart';
import '../data/child_profile_repository.dart';

/// ONE CHILD — THE SCREEN `abny://child/<childId>` HAS BEEN POINTING AT.
///
/// WHAT WAS MISSING. `deep_link_router.dart` listed `child/<id>` under
/// «no parent screen exists at all»: the dashboard's `_ChildCard` fans out to
/// eight child-scoped screens from a bottom sheet, and there was no single
/// place a link could land that says «this is who, and here is what you can
/// look at». A link to a child therefore fell back to the inbox.
///
/// ---------------------------------------------------------------------------
/// WHY IT HOSTS FOUR ONWARD SCREENS, AND WHAT THAT DOES NOT FIX.
///
/// `progress`, `coach` and `screen-time` are surfaces whose screens EXIST
/// (`LearningProgressScreen`, `CoachingScreen`, `WellbeingScreen`, and now
/// `ScreenTimeOverviewScreen`) and which cannot be opened from a link because
/// every one of them requires `childId` AND `childName`, and no `abny://` link
/// carries either — the server pins `notifications.data` identifier-free on
/// purpose. This screen is the host that supplies both: once a parent is on a
/// child, all four are one tap away with real arguments.
///
/// IT DOES NOT, HOWEVER, MAKE `abny://progress` OR `abny://coach` OPENABLE, and
/// pretending otherwise would be the client inventing a child the server did
/// not name. `DeepLinkRouter.resolve` is a pure function of the DESTINATION, and
/// a destination with no id names no child. The two remain `unavailable` and
/// land on the inbox, honestly.
///
/// `abny://screen-time` is the one case that IS wired, and it is wired without
/// breaking that rule: it lands on `ScreenTimeChildrenScreen`, which resolves
/// «which child» from the FAMILY'S OWN DATA — the list when there are several,
/// that child's overview when there is exactly one. The router still invents
/// nothing; the screen asks. (Until this feature existed the same link went to
/// `SafetyScreen`, because there was no screen-time screen to send it to.)
///
/// THE TWO SCREEN-TIME TILES ARE NOT THE SAME THING, and both belong here.
/// `WellbeingScreen` READS — how the device has been used. The screen-time tile
/// below WRITES — the daily limit, bedtime and blocked apps the device
/// enforces. A parent who has just read the first usually wants the second.
///
/// ---------------------------------------------------------------------------
/// WHAT IT SHOWS, AND WHAT IT REFUSES TO. `GET /children/:childId` returns the
/// whole `Child` row, `pinCodeHash` and `familyId` included.
/// [ChildProfile.fromJson] takes five keys and this screen can only render what
/// that type holds. The date of birth becomes an AGE — a birthday has no job on
/// a monitoring screen; an age tells a parent which of two children they are
/// looking at.
class ChildDetailScreen extends ConsumerWidget {
  const ChildDetailScreen({super.key, required this.childId});

  /// Opaque, and never an authorization claim. It says only which row the next
  /// call will ASK for; `ChildrenController.getOne` decides whether this parent
  /// may have it, from the family on their access token.
  final String childId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(childDetailControllerProvider(childId));
    final controller = ref.read(childDetailControllerProvider(childId).notifier);

    final loadedName = state.valueOrNull?.firstName ?? '';

    return Scaffold(
      appBar: AppBar(
        title: Text(loadedName.isEmpty ? t('childDetail.title') : loadedName),
      ),
      body: RefreshIndicator(
        onRefresh: controller.load,
        child: DsStateView<ChildProfile>(
          state: state,
          arabic: locale.isRtl,
          loadingLabel: t('common.loading'),
          // Unreachable from this route — see the controller. Handled anyway,
          // and with the same words as «we could not open this child», because
          // that is what an empty body would mean.
          emptyTitle: t('childDetail.missingTitle'),
          emptyBody: t('childDetail.missingBody'),
          emptyIcon: Icons.person_off_outlined,
          errorTitle: t('childDetail.errorTitle'),
          retryLabel: t('common.retry'),
          requestIdLabel: t('common.requestId'),
          onRetry: controller.load,
          builder: (context, profile) => _ChildBody(profile: profile),
        ),
      ),
    );
  }
}

class _ChildBody extends ConsumerWidget {
  const _ChildBody({required this.profile});

  final ChildProfile profile;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;
    final name = profile.firstName.isEmpty ? t('childDetail.unnamed') : profile.firstName;
    final age = profile.ageInYearsAt(DateTime.now());

    return ListView(
      padding: DsSpace.screen,
      children: [
        DsCard(
          accent: DsColor.accent,
          child: Row(
            children: [
              _Initial(name: name),
              DsSpace.hGapMd,
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name, style: DsText.cardTitle(context)),
                    if (age != null) ...[
                      DsSpace.gapXs,
                      Text(
                        t('childDetail.age', count: age),
                        style: DsText.caption(context),
                      ),
                    ],
                  ],
                ),
              ),
              if (!profile.isActive)
                DsBadge(label: t('childDetail.inactive'), color: DsColor.stateMuted),
            ],
          ),
        ),
        DsSpace.gapLg,
        DsSectionHeader(
          title: t('childDetail.sectionTitle'),
          subtitle: t('childDetail.sectionSubtitle'),
        ),
        _OnwardTile(
          icon: Icons.trending_up_rounded,
          title: t('learningProgress.title'),
          body: t('childDetail.progressHint'),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => LearningProgressScreen(
                childId: profile.id,
                childName: name,
              ),
            ),
          ),
        ),
        _OnwardTile(
          icon: Icons.forum_outlined,
          title: t('coaching.title'),
          body: t('childDetail.coachHint'),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => CoachingScreen(
                childId: profile.id,
                childName: name,
              ),
            ),
          ),
        ),
        _OnwardTile(
          icon: Icons.insights_outlined,
          title: t('wellbeing.title'),
          body: t('childDetail.wellbeingHint'),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => WellbeingScreen(
                childId: profile.id,
                childName: name,
              ),
            ),
          ),
        ),
        // THE ENTRY POINT THIS FEATURE DID NOT HAVE. The backend's Screen Time
        // API had no parent screen at all until now; this tile and
        // `abny://screen-time` are the two ways into it.
        _OnwardTile(
          icon: Icons.phonelink_lock_outlined,
          title: t('screenTime.title'),
          body: t('childDetail.screenTimeHint'),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => ScreenTimeOverviewScreen(
                childId: profile.id,
                childName: name,
              ),
            ),
          ),
        ),
        DsSpace.gapLg,
        Text(t('childDetail.footnote'), style: DsText.caption(context)),
      ],
    );
  }
}

/// The same first-letter avatar the dashboard's child card uses, so a parent
/// arriving here from a link recognises the same person they see at home.
class _Initial extends StatelessWidget {
  const _Initial({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 44,
      decoration: const BoxDecoration(color: DsColor.accent, shape: BoxShape.circle),
      alignment: Alignment.center,
      child: Text(
        name.isEmpty ? '?' : name.characters.first,
        // Was an inline `fontSize: 18, w700` — that is `sectionTitle`.
        style: DsText.sectionTitle(context).copyWith(color: DsColor.onDark),
      ),
    );
  }
}

class _OnwardTile extends StatelessWidget {
  const _OnwardTile({
    required this.icon,
    required this.title,
    required this.body,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String body;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return DsCard(
      onTap: onTap,
      child: Row(
        children: [
          Icon(icon, color: DsColor.accent),
          DsSpace.hGapMd,
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: DsText.cardTitle(context)),
                DsSpace.gapXs,
                Text(body, style: DsText.caption(context)),
              ],
            ),
          ),
          // Was a hard right-pointing chevron: in Arabic, which is this
          // product's default, "onward" points LEFT.
          DsIcons.disclosure(context),
        ],
      ),
    );
  }
}
