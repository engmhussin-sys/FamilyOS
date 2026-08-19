// WHAT THIS FILE PROVES — that the tap on the two most-sent parent
// notifications in this product now lands on something, and that the screen it
// lands on tells the truth in all four of the states it can be in.
//
// THE DEFECT IT LOCKS DOWN, in one sentence: `REWARD_GRANTED` («حصل {childName}
// على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.») and
// `BADGE_EARNED_PARENT` both resolve to `abny://progress`, and
// `deep_link_router.dart` answered that surface with `DeepLinkRoute.unavailable()`
// — so a parent told their child had earned something tapped the notification
// and was returned to the inbox they were already in, under a snackbar.
//
// THE FIVE WAYS THE FIX CAN BE WRONG, one test each:
//   1. it opens a screen but PICKS A CHILD when the family has several — the
//      client inventing the thing the server declined to say;
//   2. it makes a parent with ONE child tap through a one-item list, which is
//      ceremony rather than honesty;
//   3. a family with no children gets a spinner, a blank page or an ERROR
//      instead of an empty state that says what to do;
//   4. `GET /children` failing shows the parent transport text or an
//      `e.toString()` instead of the server's own Arabic sentence;
//   5. a row with a blank `firstName` — a real row — renders a nameless card, a
//      raw `null`, or crashes a screen whose `childName` is required.
//
// WHERE THE ROUTING HALF IS. That `abny://progress` resolves to
// `AppRoutes.progress` at all is `test/core/routing/deep_link_router_test.dart`;
// that a real tap on a real inbox row pushes it is
// `test/features/notifications/notification_tap_test.dart`. This file is about
// what the parent then SEES.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK, no Dart SDK and no
// pub.dev reachable from the environment this was authored in. STATIC VERIFIED
// ONLY, by `scripts/dart_preflight.py`, `scripts/verify_dart_imports.py` and
// `scripts/verify_l10n_parity.py` — constructor arity, named parameters,
// member references, import scope and locale-key parity — none of which is a
// Dart analyser and none of which executes anything. First execution happens on
// a CI runner.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/design_system/design_system.dart';
import 'package:parent_app/core/di/providers.dart';
import 'package:parent_app/features/family/presentation/child_picker.dart';
import 'package:parent_app/features/life_intelligence/presentation/coach_children_screen.dart';
import 'package:parent_app/features/life_intelligence/presentation/coaching_screen.dart';
import 'package:parent_app/features/rewards/presentation/child_rewards_screen.dart';
import 'package:parent_app/features/rewards/presentation/progress_children_screen.dart';

import '../../support/last_screens_test_harness.dart';
// `show` and nothing more: all three harnesses declare `ar` and `pending`, and
// this file uses the pair from `last_screens_test_harness.dart`. Importing
// either of the others whole would make both names ambiguous.
import '../../support/life_intelligence_test_harness.dart'
    show FakeLifeIntelligenceRepository;
import '../../support/reward_test_harness.dart' show FakeRewardProgramsRepository;

const String _muhammad = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const String _maryam = '5c1a2b3d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';

Map<String, dynamic> _child({
  String id = _muhammad,
  String firstName = 'محمد',
  String? lastName,
}) =>
    <String, dynamic>{
      'id': id,
      'firstName': firstName,
      if (lastName != null) 'lastName': lastName,
    };

/// Both child-scoped screens are stubbed to a read that never completes, so
/// each stays in its own loading state. That is deliberate: what is under test
/// here is WHICH screen was reached and with WHICH argument, and a screen that
/// also had to render data would make a failure ambiguous between the picker
/// and it.
Future<void> _pumpProgress(
  WidgetTester tester, {
  required FakeDashboardApi dashboard,
}) =>
    pumpParentScreen(
      tester,
      const ProgressChildrenScreen(),
      overrides: [
        dashboardApiProvider.overrideWithValue(dashboard),
        rewardProgramsRepositoryProvider.overrideWithValue(
          FakeRewardProgramsRepository(onLoadAccount: () => pending()),
        ),
      ],
    );

Future<void> _pumpCoach(
  WidgetTester tester, {
  required FakeDashboardApi dashboard,
}) =>
    pumpParentScreen(
      tester,
      const CoachChildrenScreen(),
      overrides: [
        dashboardApiProvider.overrideWithValue(dashboard),
        lifeIntelligenceRepositoryProvider.overrideWithValue(
          FakeLifeIntelligenceRepository(
            onGetCoachingRecommendations: () => pending(),
          ),
        ),
      ],
    );

void main() {
  // =========================================================================
  // The parse, on its own. No widget needed: «a row without an id is dropped»
  // is a claim about data, and asserting it through three frames of a
  // ListView would be asserting it badly.
  // =========================================================================
  group('childPickerEntries — what a `GET /children` row becomes', () {
    test('first and last name are joined; a missing last name is not «null»', () {
      final entries = childPickerEntries(<dynamic>[
        _child(firstName: 'محمد', lastName: 'أحمد'),
        _child(id: _maryam, firstName: 'مريم'),
      ]);
      expect(entries.map((e) => e.name).toList(), <String>['محمد أحمد', 'مريم']);
    });

    test('A ROW WITH NO ID IS DROPPED — a card that cannot name a child cannot '
        'open one', () {
      final entries = childPickerEntries(<dynamic>[
        <String, dynamic>{'firstName': 'بلا معرّف'},
        _child(),
      ]);
      expect(entries.map((e) => e.id).toList(), <String>[_muhammad]);
    });

    test('a row that is not a map at all is ignored rather than thrown on', () {
      // `GET /children` is read as `List<dynamic>`. A response shape nobody
      // expected must not become a `TypeError` three widgets deep.
      final entries = childPickerEntries(<dynamic>['nonsense', 42, null, _child()]);
      expect(entries, hasLength(1));
    });

    test('a blank firstName survives as a blank name, not as a crash', () {
      final entries = childPickerEntries(<dynamic>[_child(firstName: '')]);
      expect(entries.single.name, '');
      expect(entries.single.id, _muhammad);
    });
  });

  // =========================================================================
  group('ProgressChildrenScreen — where `abny://progress` now lands', () {
    testWidgets('LOADING while `GET /children` is silent', (tester) async {
      await _pumpProgress(
        tester,
        dashboard: FakeDashboardApi(onGetChildren: () => pending()),
      );

      expect(find.byType(DsLoadingState), findsOneWidget);
      expect(find.byType(DsErrorState), findsNothing);
      expect(find.byType(DsEmptyState), findsNothing);
    });

    testWidgets("ERROR — the SERVER's own Arabic sentence, never transport text "
        'and never an `e.toString()`', (tester) async {
      final failure = refusalFailure(
        statusCode: 403,
        messageAr: 'لا تملك صلاحية عرض هذه العائلة.',
        code: 'FORBIDDEN',
      );
      await _pumpProgress(
        tester,
        dashboard: FakeDashboardApi(
          onGetChildren: () => failingWith<List<dynamic>>(failure),
        ),
      );
      await tester.pump();

      expect(find.byType(DsErrorState), findsOneWidget);
      expect(find.text(ar('childRewards.pickChildErrorTitle')), findsOneWidget);
      expect(find.text(failure.messageAr!), findsOneWidget);
      // The two states an error is most often confused with.
      expect(find.byType(DsEmptyState), findsNothing);
      expect(find.byType(ChildRewardsScreen), findsNothing);
    });

    testWidgets('NO CHILDREN — an empty state that says so, not an error and '
        'not a blank page', (tester) async {
      await _pumpProgress(
        tester,
        dashboard: FakeDashboardApi(onGetChildren: () async => const <dynamic>[]),
      );
      await tester.pump();

      expect(find.byType(DsEmptyState), findsOneWidget);
      expect(find.text(ar('childRewards.noChildrenTitle')), findsOneWidget);
      expect(find.text(ar('childRewards.noChildrenBody')), findsOneWidget);
      expect(find.byType(DsErrorState), findsNothing);
    });

    testWidgets('SEVERAL CHILDREN — it ASKS, and names every one of them',
        (tester) async {
      // THE RULE THIS PROTECTS: the link names no child, so picking one on the
      // parent's behalf would be this client deciding what the server declined
      // to say. It lists them instead, and says why it is asking.
      await _pumpProgress(
        tester,
        dashboard: FakeDashboardApi(
          onGetChildren: () async => <dynamic>[
            _child(firstName: 'محمد'),
            _child(id: _maryam, firstName: 'مريم'),
          ],
        ),
      );
      await tester.pump();

      expect(find.text(ar('childRewards.pickChildTitle')), findsOneWidget);
      expect(find.text(ar('childRewards.pickChildHint')), findsOneWidget);
      expect(find.text('محمد'), findsOneWidget);
      expect(find.text('مريم'), findsOneWidget);
      // NOTHING was opened on the parent's behalf.
      expect(find.byType(ChildRewardsScreen), findsNothing);
    });

    testWidgets('picking one of several opens THAT child, with a real id',
        (tester) async {
      await _pumpProgress(
        tester,
        dashboard: FakeDashboardApi(
          onGetChildren: () async => <dynamic>[
            _child(firstName: 'محمد'),
            _child(id: _maryam, firstName: 'مريم'),
          ],
        ),
      );
      await tester.pump();

      await tester.tap(find.text('مريم'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      final opened = tester.widget<ChildRewardsScreen>(find.byType(ChildRewardsScreen));
      expect(opened.childId, _maryam);
      expect(opened.childName, 'مريم');
    });

    testWidgets('EXACTLY ONE CHILD — that child directly, with no one-item list '
        'to tap through', (tester) async {
      // NOT the same act as picking: with one child there is only one possible
      // referent, so the destination is determined by the FAMILY'S DATA rather
      // than chosen by this client.
      await _pumpProgress(
        tester,
        dashboard: FakeDashboardApi(
          onGetChildren: () async => <dynamic>[_child(firstName: 'محمد')],
        ),
      );
      await tester.pump();

      final opened = tester.widget<ChildRewardsScreen>(find.byType(ChildRewardsScreen));
      expect(opened.childId, _muhammad);
      expect(opened.childName, 'محمد');
      // And it was RENDERED rather than pushed, so the back button still has
      // exactly one thing to pop and nothing navigated as a side effect of a
      // network read landing.
      expect(find.text(ar('childRewards.pickChildHint')), findsNothing);
    });

    testWidgets('one child with a BLANK name still opens, and the screen is not '
        'handed an empty string as a name', (tester) async {
      await _pumpProgress(
        tester,
        dashboard: FakeDashboardApi(
          onGetChildren: () async => <dynamic>[_child(firstName: '')],
        ),
      );
      await tester.pump();

      final opened = tester.widget<ChildRewardsScreen>(find.byType(ChildRewardsScreen));
      expect(opened.childId, _muhammad);
      // `null`, not `''` — `ChildRewardsScreen` titles itself «المكافآت
      // والنقاط» for a null name, and «مكافآت » with a dangling space for an
      // empty one.
      expect(opened.childName, isNull);
    });
  });

  // =========================================================================
  group('CoachChildrenScreen — the other surface that used to be refused', () {
    testWidgets('SEVERAL CHILDREN — the coaching picker, in its own words',
        (tester) async {
      await _pumpCoach(
        tester,
        dashboard: FakeDashboardApi(
          onGetChildren: () async => <dynamic>[
            _child(firstName: 'محمد'),
            _child(id: _maryam, firstName: 'مريم'),
          ],
        ),
      );
      await tester.pump();

      expect(find.text(ar('coaching.pickChildTitle')), findsOneWidget);
      expect(find.text(ar('coaching.pickChildHint')), findsOneWidget);
      expect(find.byType(CoachingScreen), findsNothing);
    });

    testWidgets('EXACTLY ONE CHILD — the coaching screen, with both arguments '
        'the link could not carry', (tester) async {
      await _pumpCoach(
        tester,
        dashboard: FakeDashboardApi(
          onGetChildren: () async => <dynamic>[_child(firstName: 'محمد')],
        ),
      );
      await tester.pump();

      final opened = tester.widget<CoachingScreen>(find.byType(CoachingScreen));
      expect(opened.childId, _muhammad);
      expect(opened.childName, 'محمد');
    });

    testWidgets('a blank name becomes the LOCALISED «طفلك», never an empty '
        'heading', (tester) async {
      // `CoachingScreen.childName` is required and non-null, and a
      // `GET /children` row with a blank `firstName` is a real row.
      await _pumpCoach(
        tester,
        dashboard: FakeDashboardApi(
          onGetChildren: () async => <dynamic>[_child(firstName: '')],
        ),
      );
      await tester.pump();

      final opened = tester.widget<CoachingScreen>(find.byType(CoachingScreen));
      expect(opened.childName, ar('childDetail.unnamed'));
      expect(opened.childName, isNot(''));
    });

    testWidgets('NO CHILDREN — its own empty state, not the rewards one',
        (tester) async {
      await _pumpCoach(
        tester,
        dashboard: FakeDashboardApi(onGetChildren: () async => const <dynamic>[]),
      );
      await tester.pump();

      expect(find.text(ar('coaching.noChildrenTitle')), findsOneWidget);
      expect(find.text(ar('coaching.noChildrenBody')), findsOneWidget);
      expect(find.text(ar('childRewards.noChildrenBody')), findsNothing);
    });
  });
}
