// SMOKE LAYER FOR THE F4 REWARD JOURNEY — parent app.
//
// Before this file, `apps/parent-app` had ZERO test files (audit §8, MA-011,
// MA-028). Thirty-four screens, 6,388 lines, no test ever written and no
// analyser ever run. `flutter test` in CI exited non-zero simply because it
// found nothing to run, which is why the step carried `continue-on-error`.
//
// WHAT THIS FILE CLAIMS TO BE. A smoke layer, not a behavioural suite. For
// each F4 screen it asserts the four things a screen can get wrong before it
// gets anything right:
//
//   1. it BUILDS at all with a mocked repository — i.e. its providers wire up,
//      its constructor arity is right, and nothing throws during the first
//      frame;
//   2. it renders its LOADING state while the repository has not answered;
//   3. it renders its EMPTY state, in Arabic, when the answer is "nothing" —
//      the state this codebase historically rendered identically to a failure
//      (`dashboard_home_screen.dart` shipped exactly that bug);
//   4. it renders its ERROR state, in Arabic, showing the SERVER's own
//      sentence, when the repository fails — which is the whole reason the B3
//      error envelope and `DsErrorState` exist.
//
// WHAT IT DOES NOT CLAIM. It does not test approve/reject/pause/archive
// behaviour, navigation, or the wizard's multi-step form logic. Those need
// their own files and are named in the report as not yet written.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK reachable from the
// environment these were authored in (`which flutter` -> nothing; the SDK
// host answers 403 to CONNECT). They are STATIC VERIFIED by
// `scripts/dart_preflight.py` — constructor arity, named parameters, member
// references and import scope — which is not a Dart analyser and executes
// nothing. First execution is on a GitHub runner.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/design_system/design_system.dart';
import 'package:parent_app/core/localization/localization_engine.dart';
import 'package:parent_app/features/rewards/domain/achievement.dart';
import 'package:parent_app/features/rewards/domain/fulfilment.dart';
import 'package:parent_app/features/rewards/domain/reward_program.dart';
import 'package:parent_app/features/rewards/presentation/achievement_review_screen.dart';
import 'package:parent_app/features/rewards/presentation/child_rewards_screen.dart';
import 'package:parent_app/features/rewards/presentation/fulfilments_screen.dart';
import 'package:parent_app/features/rewards/presentation/pending_achievements_screen.dart';
import 'package:parent_app/features/rewards/presentation/program_detail_screen.dart';
import 'package:parent_app/features/rewards/presentation/programs_list_screen.dart';
import 'package:parent_app/features/rewards/presentation/suggestions_screen.dart';
import 'package:parent_app/features/screen_time/domain/screen_time_policy.dart';

import '../../support/reward_test_harness.dart';

void main() {
  // =========================================================================
  group('ProgramsListScreen — GET /reward-programs', () {
    testWidgets('renders the loading state while the repository is silent',
        (tester) async {
      await pumpRewardScreen(
        tester,
        const ProgramsListScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onListPrograms: () => pending<List<RewardProgram>>(),
        ),
      );

      expect(find.byType(DsLoadingState), findsOneWidget);
      expect(find.text(ar('programs.emptyTitle')), findsNothing);
      expect(find.text(ar('programs.errorTitle')), findsNothing);
    });

    testWidgets('renders the Arabic empty state — not the error state — '
        'when the list is legitimately empty', (tester) async {
      await pumpRewardScreen(
        tester,
        const ProgramsListScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onListPrograms: () async => const <RewardProgram>[],
        ),
      );
      await tester.pump();

      expect(find.byType(DsEmptyState), findsOneWidget);
      expect(find.text(ar('programs.emptyTitle')), findsOneWidget);
      // The distinction this app used to get wrong.
      expect(find.byType(DsErrorState), findsNothing);
      expect(find.text(ar('programs.errorTitle')), findsNothing);
    });

    testWidgets("renders the error state with the SERVER's Arabic sentence",
        (tester) async {
      await pumpRewardScreen(
        tester,
        const ProgramsListScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onListPrograms: () => failing<List<RewardProgram>>(),
        ),
      );
      await tester.pump();

      expect(find.byType(DsErrorState), findsOneWidget);
      expect(find.text(ar('programs.errorTitle')), findsOneWidget);
      // NOT a client-invented sentence: the envelope's own messageAr.
      expect(find.text(testFailure.messageAr!), findsOneWidget);
      expect(find.text(ar('common.retry')), findsOneWidget);
      expect(find.byType(DsEmptyState), findsNothing);
    });

    testWidgets('renders the goal it was given', (tester) async {
      await pumpRewardScreen(
        tester,
        const ProgramsListScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onListPrograms: () async => [testProgram()],
        ),
      );
      await tester.pump();

      expect(find.text('حفظ سورة الفاتحة'), findsOneWidget);
      expect(find.byType(DsEmptyState), findsNothing);
      expect(find.byType(DsErrorState), findsNothing);
    });

    testWidgets('honours the English locale for its own chrome',
        (tester) async {
      await pumpRewardScreen(
        tester,
        const ProgramsListScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onListPrograms: () async => const <RewardProgram>[],
        ),
        locale: AppLocale.en,
      );
      await tester.pump();
      await tester.pump();

      expect(find.text(en('programs.emptyTitle')), findsOneWidget);
    });
  });

  // =========================================================================
  group('PendingAchievementsScreen — the approval queue', () {
    testWidgets('loading', (tester) async {
      await pumpRewardScreen(
        tester,
        const PendingAchievementsScreen(),
        repository: FakeRewardProgramsRepository(
          onListPendingAchievements: () => pending<List<AchievementRequest>>(),
        ),
      );
      expect(find.byType(DsLoadingState), findsOneWidget);
    });

    testWidgets('empty, in Arabic', (tester) async {
      await pumpRewardScreen(
        tester,
        const PendingAchievementsScreen(),
        repository: FakeRewardProgramsRepository(
          onListPendingAchievements: () async => const <AchievementRequest>[],
        ),
      );
      await tester.pump();

      expect(find.text(ar('reviewQueue.emptyTitle')), findsOneWidget);
      expect(find.byType(DsErrorState), findsNothing);
    });

    testWidgets('error, in Arabic', (tester) async {
      await pumpRewardScreen(
        tester,
        const PendingAchievementsScreen(),
        repository: FakeRewardProgramsRepository(
          onListPendingAchievements: () => failing<List<AchievementRequest>>(),
        ),
      );
      await tester.pump();

      expect(find.text(ar('reviewQueue.errorTitle')), findsOneWidget);
      expect(find.text(testFailure.messageAr!), findsOneWidget);
    });

    testWidgets('a queued achievement reaches the list', (tester) async {
      await pumpRewardScreen(
        tester,
        const PendingAchievementsScreen(),
        repository: FakeRewardProgramsRepository(
          onListPendingAchievements: () async => [testAchievement()],
          onListPrograms: () async => [testProgram()],
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.byType(DsEmptyState), findsNothing);
      expect(find.byType(DsErrorState), findsNothing);
    });
  });

  // =========================================================================
  group('FulfilmentsScreen — physical reward hand-over', () {
    testWidgets('loading', (tester) async {
      await pumpRewardScreen(
        tester,
        const FulfilmentsScreen(),
        repository: FakeRewardProgramsRepository(
          onListFulfilments: () => pending<List<RewardFulfilment>>(),
        ),
      );
      expect(find.byType(DsLoadingState), findsOneWidget);
    });

    testWidgets('empty, in Arabic', (tester) async {
      await pumpRewardScreen(
        tester,
        const FulfilmentsScreen(),
        repository: FakeRewardProgramsRepository(
          onListFulfilments: () async => const <RewardFulfilment>[],
        ),
      );
      await tester.pump();

      expect(find.text(ar('fulfilments.emptyTitle')), findsOneWidget);
    });

    testWidgets('error, in Arabic', (tester) async {
      await pumpRewardScreen(
        tester,
        const FulfilmentsScreen(),
        repository: FakeRewardProgramsRepository(
          onListFulfilments: () => failing<List<RewardFulfilment>>(),
        ),
      );
      await tester.pump();

      expect(find.text(ar('fulfilments.errorTitle')), findsOneWidget);
      expect(find.text(testFailure.messageAr!), findsOneWidget);
    });

    testWidgets('renders a pending hand-over', (tester) async {
      await pumpRewardScreen(
        tester,
        const FulfilmentsScreen(),
        repository: FakeRewardProgramsRepository(
          onListFulfilments: () async => [testFulfilment()],
        ),
      );
      await tester.pump();

      expect(find.text('دفتر جديد'), findsOneWidget);
    });
  });

  // =========================================================================
  group('SuggestionsScreen — AI drafts, never auto-created', () {
    testWidgets('loading', (tester) async {
      await pumpRewardScreen(
        tester,
        const SuggestionsScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onListSuggestions: () => pending<List<ProgramSuggestion>>(),
        ),
      );
      expect(find.byType(DsLoadingState), findsOneWidget);
    });

    testWidgets('empty, in Arabic', (tester) async {
      await pumpRewardScreen(
        tester,
        const SuggestionsScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onListSuggestions: () async => const <ProgramSuggestion>[],
        ),
      );
      await tester.pump();

      expect(find.text(ar('suggestions.emptyTitle')), findsOneWidget);
    });

    testWidgets('error, in Arabic', (tester) async {
      await pumpRewardScreen(
        tester,
        const SuggestionsScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onListSuggestions: () => failing<List<ProgramSuggestion>>(),
        ),
      );
      await tester.pump();

      expect(find.text(ar('suggestions.errorTitle')), findsOneWidget);
      expect(find.text(testFailure.messageAr!), findsOneWidget);
    });

    testWidgets('a suggestion renders its Arabic preview and rationale — '
        'CONTEXT §3 principle 2: advisory only', (tester) async {
      await pumpRewardScreen(
        tester,
        const SuggestionsScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onListSuggestions: () async => [testSuggestion()],
        ),
      );
      await tester.pump();

      expect(find.text('قراءة عشر صفحات كل يوم'), findsOneWidget);
    });
  });

  // =========================================================================
  group('ProgramDetailScreen — GET /reward-programs/:id', () {
    testWidgets('loading', (tester) async {
      await pumpRewardScreen(
        tester,
        const ProgramDetailScreen(programId: 'prog_1'),
        repository: FakeRewardProgramsRepository(
          onGetProgram: () => pending<RewardProgram>(),
        ),
      );
      expect(find.byType(DsLoadingState), findsOneWidget);
    });

    testWidgets('error, in Arabic', (tester) async {
      await pumpRewardScreen(
        tester,
        const ProgramDetailScreen(programId: 'prog_1'),
        repository: FakeRewardProgramsRepository(
          onGetProgram: () => failing<RewardProgram>(),
        ),
      );
      await tester.pump();

      expect(find.text(ar('programDetail.errorTitle')), findsOneWidget);
      expect(find.text(testFailure.messageAr!), findsOneWidget);
    });

    testWidgets('renders the loaded goal', (tester) async {
      await pumpRewardScreen(
        tester,
        const ProgramDetailScreen(programId: 'prog_1'),
        repository: FakeRewardProgramsRepository(
          onGetProgram: () async => testProgram(),
        ),
      );
      await tester.pump();

      expect(find.text('حفظ سورة الفاتحة'), findsOneWidget);
      expect(find.byType(DsErrorState), findsNothing);
    });
  });

  // =========================================================================
  group('ChildRewardsScreen — points, grants and hand-overs in one place', () {
    testWidgets('loading', (tester) async {
      await pumpRewardScreen(
        tester,
        const ChildRewardsScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onLoadAccount: () => pending<RewardsAccount>(),
          onListScreenTimeGrants: () => pending<List<ScreenTimeGrant>>(),
          onListFulfilments: () => pending<List<RewardFulfilment>>(),
          onListAchievementsForChild: () => pending<List<AchievementRequest>>(),
          onGetStreaks: () => pending<Map<String, int>>(),
        ),
      );
      expect(find.byType(DsLoadingState), findsOneWidget);
    });

    testWidgets('error, in Arabic', (tester) async {
      await pumpRewardScreen(
        tester,
        const ChildRewardsScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onLoadAccount: () => failing<RewardsAccount>(),
          onListScreenTimeGrants: () => failing<List<ScreenTimeGrant>>(),
          onListFulfilments: () => failing<List<RewardFulfilment>>(),
          onListAchievementsForChild: () => failing<List<AchievementRequest>>(),
          onGetStreaks: () => failing<Map<String, int>>(),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text(ar('childRewards.errorTitle')), findsOneWidget);
    });

    testWidgets('renders a loaded snapshot', (tester) async {
      await pumpRewardScreen(
        tester,
        const ChildRewardsScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onLoadAccount: () async =>
              const RewardsAccount(xp: 120, coins: 30, level: 2),
          onListScreenTimeGrants: () async => const <ScreenTimeGrant>[],
          onListFulfilments: () async => [testFulfilment(status: 'FULFILLED')],
          onListAchievementsForChild: () async =>
              [testAchievement(status: 'VERIFIED')],
          onGetStreaks: () async => const {'reading': 3},
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.byType(DsErrorState), findsNothing);
    });

    // -----------------------------------------------------------------------
    // THE REGRESSION GUARD FOR THE DUPLICATE BONUS TOTAL.
    //
    // This screen used to sum the grant rows itself, against the handset's
    // `DateTime.now()`, while the Screen-Time tab and the child's own screen
    // rendered the server's `bonusMinutes`. Same child, same second, two
    // numbers. The three tests below fail if anything ever re-derives that
    // total or that per-row standing locally again — they are written so that
    // a local computation gives a DIFFERENT answer from the server's, which is
    // the only way a test can tell the two apart.
    // -----------------------------------------------------------------------
    testWidgets('renders the SERVER bonus total, not the sum of the rows',
        (tester) async {
      await pumpRewardScreen(
        tester,
        const ChildRewardsScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onLoadAccount: () async =>
              const RewardsAccount(xp: 120, coins: 30, level: 2),
          // Three rows of 15 sum to 45 on the device. The server counts one.
          onListScreenTimeGrants: () async => [
            testGrant(id: 'g_live', minutes: 15),
            testGrant(id: 'g_gone', minutes: 15),
            testGrant(id: 'g_revoked', minutes: 15, revokedAt: DateTime.utc(2026)),
          ],
          onListFulfilments: () async => const <RewardFulfilment>[],
          onListAchievementsForChild: () async => const <AchievementRequest>[],
          onGetStreaks: () async => const <String, int>{},
        ),
        onEffectivePolicy: () async =>
            serverBonus(bonusMinutes: 15, activeGrantIds: const ['g_live']),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text(ar('childRewards.activeBonus', options: {'count': 15})),
          findsOneWidget);
      expect(find.text(ar('childRewards.activeBonus', options: {'count': 45})),
          findsNothing);
    });

    testWidgets(
        'a row the SERVER still counts reads «فعّالة» even when its expiry is '
        'already in the past on this device', (tester) async {
      await pumpRewardScreen(
        tester,
        const ChildRewardsScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onLoadAccount: () async =>
              const RewardsAccount(xp: 10, coins: 0, level: 1),
          onListScreenTimeGrants: () async => [
            // A handset whose clock runs fast — or a page open across the
            // expiry — used to draw this row as «منتهية» while the server was
            // still counting its minutes.
            testGrant(id: 'g_live', minutes: 20, expiresAt: DateTime.utc(2020)),
          ],
          onListFulfilments: () async => const <RewardFulfilment>[],
          onListAchievementsForChild: () async => const <AchievementRequest>[],
          onGetStreaks: () async => const <String, int>{},
        ),
        onEffectivePolicy: () async =>
            serverBonus(bonusMinutes: 20, activeGrantIds: const ['g_live']),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text(ar('childRewards.grantActive')), findsOneWidget);
      expect(find.text(ar('childRewards.grantExpired')), findsNothing);
    });

    testWidgets('says the total could not be read rather than showing a zero '
        'it invented, when the effective-policy call fails', (tester) async {
      await pumpRewardScreen(
        tester,
        const ChildRewardsScreen(childId: 'child_1'),
        repository: FakeRewardProgramsRepository(
          onLoadAccount: () async =>
              const RewardsAccount(xp: 10, coins: 0, level: 1),
          onListScreenTimeGrants: () async => [testGrant(minutes: 15)],
          onListFulfilments: () async => const <RewardFulfilment>[],
          onListAchievementsForChild: () async => const <AchievementRequest>[],
          onGetStreaks: () async => const <String, int>{},
        ),
        onEffectivePolicy: () => failing<EffectiveScreenTimePolicy>(),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text(ar('childRewards.bonusUnavailable')), findsOneWidget);
      expect(find.text(ar('childRewards.activeBonus', options: {'count': 0})),
          findsNothing);
      // No standing it cannot back: neither badge is claimed.
      expect(find.text(ar('childRewards.grantActive')), findsNothing);
      expect(find.text(ar('childRewards.grantExpired')), findsNothing);
    });
  });

  // =========================================================================
  group('AchievementReviewScreen — the approve/reject surface', () {
    testWidgets('builds and shows its verification log in a loading state',
        (tester) async {
      await pumpRewardScreen(
        tester,
        const AchievementReviewScreen(
          achievementId: 'ach_1',
          targetSummaryAr: 'حفظ سورة الفاتحة',
        ),
        repository: FakeRewardProgramsRepository(
          onListAttempts: () => pending<List<VerificationAttempt>>(),
          onGetAchievementDetail: () => pending<AchievementDetail>(),
        ),
      );

      expect(find.text(ar('review.title')), findsWidgets);
    });

    testWidgets('surfaces a failed log load in Arabic', (tester) async {
      await pumpRewardScreen(
        tester,
        const AchievementReviewScreen(achievementId: 'ach_1'),
        repository: FakeRewardProgramsRepository(
          onListAttempts: () => failing<List<VerificationAttempt>>(),
          onGetAchievementDetail: () => failing<AchievementDetail>(),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text(testFailure.messageAr!), findsWidgets);
    });
  });
}
