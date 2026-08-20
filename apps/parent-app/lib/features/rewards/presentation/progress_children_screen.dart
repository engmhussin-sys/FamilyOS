import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/localization/locale_controller.dart';
import '../../family/presentation/child_picker.dart';
import 'child_rewards_screen.dart';

/// WHERE `abny://progress` LANDS — THE DEAD TAP ON THE TWO MOST COMMON PARENT
/// NOTIFICATIONS, CLOSED.
///
/// ---------------------------------------------------------------------------
/// WHAT WAS BROKEN, MEASURED RATHER THAN GUESSED.
///
/// `notification-destination.ts` resolves BOTH `REWARD_GRANTED` («حصل
/// {childName} على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.») and
/// `BADGE_EARNED_PARENT` («حصل {childName} على وسام {badgeTitle}. التفاصيل داخل
/// التطبيق.») to `abny://progress`, and `deep_link_router.dart` answered that
/// surface with `DeepLinkRoute.unavailable()`. So the two sentences this
/// product sends a parent most often each ended in a tap that put the parent
/// back in the inbox they were already in, under a snackbar. Both sentences
/// explicitly instruct the parent to open the app.
///
/// ---------------------------------------------------------------------------
/// THE DECISION: `abny://progress` IS THE RIGHT DESTINATION AND THE PARENT APP
/// WAS MISSING ITS ENTRY SCREEN. The alternative was to re-point the two keys
/// at a surface that carries an id, and it does not survive contact with this
/// codebase:
///
///   a. THERE IS NO ID TO CARRY. Every id-bearing surface (`goal`, `approval`,
///      `safety`, `child`) needs a UUID at emission, and `NotificationRewardConsumer`
///      carries none — it holds `achievementSummaryAr`, a title written for
///      humans. `notification-destination.ts` rule 4 forbids manufacturing one,
///      and rule 5 plus `e2e-13 STEP 14` forbid an identifier reaching this
///      payload at all. `abny://child/<childId>` is therefore not a route this
///      product can emit; it is a route it has decided not to emit.
///   b. THE OTHER ID-LESS SURFACES ANSWER A DIFFERENT QUESTION. `abny://rewards`
///      is the FULFILMENT QUEUE in this app — «what do I still owe?» — and a
///      badge is never fulfilled, so half these notifications would land on a
///      list that structurally cannot contain them. `abny://goals` is the
///      program list, and `REWARD_GRANTED` is precisely the key emitted when NO
///      goal is known (`REWARD_GRANTED_WITH_GOAL` is the one that is).
///
/// So the destination file is left alone and the missing screen is built —
/// which is also the smaller change, and the one that does not put a second
/// opinion about product meaning into a client.
///
/// ---------------------------------------------------------------------------
/// AND IT WIRES TO A SCREEN THAT ALREADY EXISTS RATHER THAN DUPLICATING ONE.
/// `ChildRewardsScreen` is this app's «what this child has earned»: the points
/// balance and level from `GET /life-intelligence/rewards/:childId/account`,
/// the five streak buckets from `GET /reward-programs/streaks/:childId`, the
/// verified achievements from `GET /reward-programs/achievements?childId=`, and
/// the fulfilments. That is the answer to «حصل {childName} على مكافأة جديدة» —
/// the parent is being invited to ENCOURAGE, and this is the page that shows
/// them what there is to encourage.
///
/// NOT `LearningProgressScreen`, which is the other candidate and is narrower:
/// sessions, minutes and assessment scores from the LEARNING engine. A reward
/// granted for a habit tick or a streak does not appear on it at all.
///
/// STATED HONESTLY, because the badge sentence deserves it: this app has no
/// BADGE SHELF, and no backend route serving one was invented to give it one.
/// `BADGE_EARNED_PARENT` lands on the record of what the child has earned —
/// points, level, streaks and completed goals — which is where the badge's own
/// cause is visible. It is the nearest truthful landing, not a perfect one.
///
/// ---------------------------------------------------------------------------
/// WHICH CHILD? THE FAMILY'S DATA ANSWERS, NOT THIS CLIENT. The link names no
/// child and never will, so this screen is a [ChildPicker]: the list when there
/// are several, that child's page directly when there is exactly one, an empty
/// state when there are none. `DeepLinkRouter.resolve` stays a pure function of
/// the DESTINATION and invents nothing; the screen ASKS. That is the mechanism
/// `ScreenTimeChildrenScreen` established for `abny://screen-time`, and the
/// argument for it is the same one, unchanged.
///
/// ARGUMENT-FREE BY CONSTRUCTION, which is what lets it be a NAMED route under
/// `app_routes.dart`'s rule — no id is smuggled through `settings.arguments`.
class ProgressChildrenScreen extends ConsumerWidget {
  const ProgressChildrenScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return ChildPicker(
      title: t('childRewards.pickChildTitle'),
      hint: t('childRewards.pickChildHint'),
      errorTitle: t('childRewards.pickChildErrorTitle'),
      emptyTitle: t('childRewards.noChildrenTitle'),
      emptyBody: t('childRewards.noChildrenBody'),
      icon: Icons.emoji_events_outlined,
      childScreenBuilder: (childId, childName) => ChildRewardsScreen(
        childId: childId,
        childName: childName.isEmpty ? null : childName,
      ),
    );
  }
}
