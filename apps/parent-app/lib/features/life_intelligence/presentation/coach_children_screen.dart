import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/localization/locale_controller.dart';
import '../../family/presentation/child_picker.dart';
import 'coaching_screen.dart';

/// WHERE `abny://coach` LANDS — the second of the parent app's two refused
/// surfaces, closed by the same mechanism as the first.
///
/// ---------------------------------------------------------------------------
/// WHY IT IS FIXED IN THE SAME CHANGE AS `progress`, AND NOT LATER.
///
/// `coach` was refused for exactly the reason `progress` was: `CoachingScreen`
/// requires `childId` AND `childName`, an `abny://` link carries neither, and
/// the router — a pure function of the destination — is not allowed to pick a
/// child the server declined to name. That reasoning is answered by
/// [ChildPicker], which does not pick: it ASKS the family's own data, and only
/// resolves to one child when the family HAS one child.
///
/// Leaving `coach` refused after that would have been leaving a known dead tap
/// in place because the argument for it had already been written down. It also
/// would not have held: `notification-producer-chain.guard.spec.ts` asserts
/// `parentRouting.unansweredSurfaces` is EMPTY once the dead-destination ledger
/// is, so «a surface the parent app cannot open» is a build failure now, not a
/// ledger row.
///
/// ---------------------------------------------------------------------------
/// WHAT IT DOES AND DOES NOT CHANGE ON THE SERVER SIDE. No copy key resolves to
/// `abny://coach` today: `CHILD_WELLBEING_CHECKIN` used to and was moved to
/// `safetyDestination`, for a reason `notification-destination.ts` argues at
/// length and which this screen does not reopen — the distress alert belongs
/// next to the parent's other safety alerts, where they can act. This screen
/// makes the SURFACE openable; it does not campaign for anything to be sent
/// there.
///
/// `CoachingScreen` reads `GET /life-intelligence/coaching/:childId` through
/// `LifeIntelligenceRepository`, which converts and logs, so the failure a
/// parent sees is the server's own Arabic sentence and never an
/// `e.toString()`.
///
/// ARGUMENT-FREE BY CONSTRUCTION, which is what lets it be a NAMED route under
/// `app_routes.dart`'s rule.
class CoachChildrenScreen extends ConsumerWidget {
  const CoachChildrenScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return ChildPicker(
      title: t('coaching.pickChildTitle'),
      hint: t('coaching.pickChildHint'),
      errorTitle: t('coaching.pickChildErrorTitle'),
      emptyTitle: t('coaching.noChildrenTitle'),
      emptyBody: t('coaching.noChildrenBody'),
      icon: Icons.forum_outlined,
      childScreenBuilder: (childId, childName) => CoachingScreen(
        childId: childId,
        // `CoachingScreen` requires a NON-EMPTY name for its own heading, and a
        // `GET /children` row with a blank `firstName` is a real row. The
        // localised «طفلك» is the same fallback `ChildPicker`'s list uses, so
        // the parent sees one word for one child on both screens.
        childName: childName.isEmpty ? t('childDetail.unnamed') : childName,
      ),
    );
  }
}
