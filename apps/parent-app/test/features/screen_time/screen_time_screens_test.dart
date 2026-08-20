// THE SMOKE + BEHAVIOUR LAYER FOR THE PARENT'S SCREEN-TIME SURFACE.
//
// WHAT THIS FILE CLAIMS TO BE. For each of the three screens it asserts the
// four things a screen can get wrong before it gets anything right — it BUILDS,
// it renders LOADING, it renders EMPTY in Arabic when the answer is legitimately
// «nothing», and it renders ERROR with the SERVER's own sentence — plus the
// handful of behaviours that are specific to this surface and that a smoke test
// would miss:
//
//   * CONFIGURED ≠ EFFECTIVE. The number the parent set and the number the
//     device enforces are different values on any day the child has earned
//     something, and the screen has to show BOTH and name the difference. A
//     screen showing only one of them is the defect this feature exists to
//     avoid, and it would pass a build-only test.
//   * THE DTO's REAL BOUNDS. `dailyLimitMinutes` is `@Min(0) @Max(1440)` and
//     the bedtimes are `HH:mm` — the form has to refuse locally rather than
//     collect a 400, and it has to send an OMITTED key rather than `""` for a
//     cleared bedtime, because `@Matches` refuses an empty string.
//   * THE EMPTY APP CATALOGUE. `GET /children/:childId/apps` answering with
//     nothing is the COMMON case on day one — no device paired, or paired and
//     not yet synced — and an empty picker with no explanation is the exact
//     failure the catalogue route was built to remove.
//   * DEACTIVATE, NOT DELETE. The confirmation copy must not claim a delete
//     the server does not perform.
//
// WHAT IT DOES NOT CLAIM. It does not exercise the deep-link retarget (that is
// `test/core/routing/deep_link_router_test.dart` and
// `test/features/notifications/notification_tap_test.dart`, both updated), and
// it does not test the modal picker's own bottom-sheet presentation, only the
// controller-facing states behind it.
//
// EXECUTION STATUS: NEVER RUN. No Flutter SDK, no Dart SDK and no pub.dev are
// reachable from the environment this was authored in. STATIC VERIFIED ONLY, by
// `scripts/dart_preflight.py` — which is not a Dart analyser and executes
// nothing. First execution happens on a CI runner.

import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/design_system/design_system.dart';
import 'package:parent_app/core/di/providers.dart';
import 'package:parent_app/core/localization/localization_engine.dart';
import 'package:parent_app/features/screen_time/application/screen_time_policy_editor_controller.dart';
import 'package:parent_app/features/screen_time/domain/app_block_rule.dart';
import 'package:parent_app/features/screen_time/domain/screen_time_policy.dart';
import 'package:parent_app/features/family/presentation/child_picker.dart';
import 'package:parent_app/features/screen_time/presentation/blocked_apps_screen.dart';
import 'package:parent_app/features/screen_time/presentation/screen_time_children_screen.dart';
import 'package:parent_app/features/screen_time/presentation/screen_time_grant_row.dart';
import 'package:parent_app/features/screen_time/presentation/screen_time_overview_screen.dart';
import 'package:parent_app/features/screen_time/presentation/screen_time_policy_editor_screen.dart';

import '../../support/last_screens_test_harness.dart';
import '../../support/screen_time_test_harness.dart';

const String _childId = 'child_1';

void main() {
  // =========================================================================
  group('ScreenTimeOverviewScreen — the two numbers', () {
    testWidgets('renders the loading state while the effective read is silent',
        (tester) async {
      await _pumpOverview(
        tester,
        FakeScreenTimeRepository(
          onGetPolicy: () async => testPolicy(),
          onGetEffectivePolicy: () => stalled<EffectiveScreenTimePolicy>(),
        ),
      );

      expect(find.byType(DsLoadingState), findsOneWidget);
      expect(find.byType(DsErrorState), findsNothing);
    });

    testWidgets('CONFIGURED and EFFECTIVE are BOTH on screen, and the difference '
        'is named — the whole reason this screen exists', (tester) async {
      await _pumpOverview(
        tester,
        FakeScreenTimeRepository(
          onGetPolicy: () async => testPolicy(dailyLimitMinutes: 120),
          onGetEffectivePolicy: () async => testEffective(base: 120, bonus: 30),
        ),
      );
      await tester.pump();

      // The configured limit, the earned bonus, and the total — three separate
      // statements, not one merged number.
      expect(find.text(ar('screenTime.configuredLimit')), findsOneWidget);
      expect(find.text(ar('screenTime.earnedBonus')), findsOneWidget);
      expect(find.text(ar('common.minutesValue', options: {'count': 120})),
          findsWidgets);
      expect(find.text(ar('common.minutesValue', options: {'count': 30})),
          findsOneWidget);
      expect(find.text(ar('common.minutesValue', options: {'count': 150})),
          findsWidgets);
      // …and the arithmetic is SPELLED OUT rather than left for the parent to
      // do, because «why is today different» is the question this screen
      // answers.
      expect(
        find.text(ar('screenTime.differenceExplained',
            options: {'base': 120, 'bonus': 30, 'total': 150})),
        findsOneWidget,
      );
      // ONE ROW WIDGET FOR ONE GRANT. The child's rewards page draws the same
      // widget for the same database row; each screen used to have its own,
      // with its own answer to «is this grant live» and its own copy of the
      // timestamp cut. Every grant on THIS route is one the server counts, so
      // the row reads «فعّالة» rather than a locally decided standing.
      expect(find.byType(ScreenTimeGrantRow), findsOneWidget);
      expect(find.text(ar('screenTime.grantActive')), findsOneWidget);
    });

    testWidgets('with no bonus earned, it says so instead of implying one',
        (tester) async {
      await _pumpOverview(
        tester,
        FakeScreenTimeRepository(
          onGetPolicy: () async => testPolicy(dailyLimitMinutes: 90),
          onGetEffectivePolicy: () async => testEffective(base: 90, bonus: 0),
        ),
      );
      await tester.pump();

      expect(find.text(ar('screenTime.differenceNone')), findsOneWidget);
      expect(find.text(ar('screenTime.differenceExplained',
          options: {'base': 90, 'bonus': 0, 'total': 90})), findsNothing);
    });

    testWidgets('NO BASE LIMIT — the one case where a reward buys nothing is '
        'stated, not rendered as a dash', (tester) async {
      // `ScreenTimeService.getEffectivePolicy` keeps `effectiveDailyLimitMinutes`
      // null when there is no base limit, rather than inventing a cap the parent
      // never set. The screen has to say that out loud.
      await _pumpOverview(
        tester,
        FakeScreenTimeRepository(
          onGetPolicy: () async => testPolicy(dailyLimitMinutes: null),
          onGetEffectivePolicy: () async => testEffective(base: null, bonus: 45),
        ),
      );
      await tester.pump();

      expect(find.text(ar('screenTime.noLimitValue')), findsWidgets);
      expect(find.text(ar('screenTime.differenceNoLimit')), findsOneWidget);
    });

    testWidgets('EMPTY — no policy and no bonus is an empty state, not an error',
        (tester) async {
      await _pumpOverview(
        tester,
        FakeScreenTimeRepository(
          onGetPolicy: () async => null,
          onGetEffectivePolicy: () async =>
              const EffectiveScreenTimePolicy(bonusMinutes: 0),
        ),
      );
      await tester.pump();

      expect(find.byType(DsEmptyState), findsOneWidget);
      expect(find.text(ar('screenTime.emptyTitle')), findsOneWidget);
      // The distinction this codebase historically got wrong.
      expect(find.byType(DsErrorState), findsNothing);
      // …and the action that fixes it is offered right there.
      expect(find.text(ar('screenTime.setPolicy')), findsOneWidget);
    });

    testWidgets("ERROR — the server's own Arabic sentence, never transport text",
        (tester) async {
      await _pumpOverview(
        tester,
        FakeScreenTimeRepository(
          onGetPolicy: () async => null,
          onGetEffectivePolicy: () => refused<EffectiveScreenTimePolicy>(),
        ),
      );
      await tester.pump();

      expect(find.byType(DsErrorState), findsOneWidget);
      expect(find.text(ar('screenTime.errorTitle')), findsOneWidget);
      // NOT a client-invented sentence and NOT an `e.toString()`: the
      // envelope's own `messageAr`.
      expect(find.text(screenTimeFailure.messageAr!), findsOneWidget);
      expect(find.byType(DsEmptyState), findsNothing);
    });

    testWidgets('PARTIAL FAILURE — the configured read failing does not blank '
        'the screen, and does not claim «no policy set»', (tester) async {
      await _pumpOverview(
        tester,
        FakeScreenTimeRepository(
          onGetPolicy: () => refused<ScreenTimePolicy?>(),
          onGetEffectivePolicy: () async => testEffective(base: 120, bonus: 30),
        ),
      );
      await tester.pump();

      // The effective allowance still renders…
      expect(find.text(ar('screenTime.effectiveLimit')), findsOneWidget);
      expect(find.byType(DsErrorState), findsNothing);
      // …and the policy card falls back to the copy embedded in the effective
      // response rather than to the false «nothing is set».
      expect(find.text(ar('screenTime.noPolicy')), findsNothing);
    });

    testWidgets('honours the English locale for its own chrome', (tester) async {
      await _pumpOverview(
        tester,
        FakeScreenTimeRepository(
          onGetPolicy: () async => null,
          onGetEffectivePolicy: () async =>
              const EffectiveScreenTimePolicy(bonusMinutes: 0),
        ),
        locale: AppLocale.en,
      );
      await tester.pump();
      await tester.pump();

      expect(find.text(en('screenTime.emptyTitle')), findsOneWidget);
    });
  });

  // =========================================================================
  group('ScreenTimePolicyEditorScreen — the DTO bounds are the form bounds', () {
    testWidgets('loading, then the form seeded from the CONFIGURED policy',
        (tester) async {
      await _pumpEditor(
        tester,
        FakeScreenTimeRepository(onGetPolicy: () => stalled<ScreenTimePolicy?>()),
      );
      expect(find.byType(DsLoadingState), findsOneWidget);
    });

    testWidgets("ERROR — the seed read failing shows the server's sentence",
        (tester) async {
      await _pumpEditor(
        tester,
        FakeScreenTimeRepository(onGetPolicy: () => refused<ScreenTimePolicy?>()),
      );
      await tester.pump();

      expect(find.byType(DsErrorState), findsOneWidget);
      expect(find.text(ar('screenTimeEdit.errorTitle')), findsOneWidget);
      expect(find.text(screenTimeFailure.messageAr!), findsOneWidget);
    });

    testWidgets('a policy that has never been set is a usable BLANK FORM, not '
        'an error and not an empty state', (tester) async {
      await _pumpEditor(
        tester,
        FakeScreenTimeRepository(onGetPolicy: () async => null),
      );
      await tester.pump();

      expect(find.text(ar('screenTimeEdit.save')), findsOneWidget);
      expect(find.byType(DsErrorState), findsNothing);
      expect(find.byType(DsEmptyState), findsNothing);
    });

    testWidgets('it warns BEFORE the save that per-day overrides will be dropped',
        (tester) async {
      // `setPolicy` REPLACES the row and this app sends no `weekdaySchedule`,
      // so a save really does drop them. Saying so afterwards would be too late.
      await _pumpEditor(
        tester,
        FakeScreenTimeRepository(
          onGetPolicy: () async => testPolicy(hasWeekdaySchedule: true),
        ),
      );
      await tester.pump();

      expect(find.text(ar('screenTimeEdit.weekdayScheduleWarning')), findsOneWidget);
    });

    testWidgets('a failed save keeps the form and shows the envelope sentence',
        (tester) async {
      final repository = FakeScreenTimeRepository(
        onGetPolicy: () async => testPolicy(),
        onSetPolicy: () => refused<ScreenTimePolicy?>(),
      );
      await _pumpEditor(tester, repository);
      await tester.pump();

      await tester.tap(find.text(ar('screenTimeEdit.save')));
      await tester.pump();

      expect(find.text(ar('screenTimeEdit.saveFailedTitle')), findsOneWidget);
      expect(find.text(screenTimeFailure.messageAr!), findsOneWidget);
      // THE FORM SURVIVED. A failed save must not cost the parent their input.
      expect(find.text(ar('screenTimeEdit.save')), findsOneWidget);
    });

    testWidgets('a save sends the DTO field values it was given', (tester) async {
      final repository = FakeScreenTimeRepository(
        onGetPolicy: () async =>
            testPolicy(dailyLimitMinutes: 120, bedtimeStart: '21:00', bedtimeEnd: '06:30'),
        onSetPolicy: () async => testPolicy(),
      );
      await _pumpEditor(tester, repository);
      await tester.pump();

      await tester.tap(find.text(ar('screenTimeEdit.save')));
      await tester.pump();

      expect(repository.lastSetPolicyArgs?['dailyLimitMinutes'], 120);
      expect(repository.lastSetPolicyArgs?['bedtimeStart'], '21:00');
      expect(repository.lastSetPolicyArgs?['bedtimeEnd'], '06:30');
      expect(repository.lastSetPolicyArgs?['focusModeEnabled'], false);
    });
  });

  // =========================================================================
  // The bounds themselves, asserted directly against the DTO's numbers. These
  // need no widget: they are the claim that this client mirrors
  // `SetScreenTimePolicyDto` rather than guessing at it.
  group('PolicyEditorState — mirrors SetScreenTimePolicyDto exactly', () {
    test('@Min(0) @Max(1440) — 0 and 1440 are LEGAL, 1441 and -1 are not', () {
      expect(const PolicyEditorState(dailyLimitText: '0').problems, isEmpty);
      expect(const PolicyEditorState(dailyLimitText: '1440').problems, isEmpty);
      expect(
        const PolicyEditorState(dailyLimitText: '1441').problems,
        contains(PolicyFormProblem.dailyLimitOutOfRange),
      );
      expect(
        const PolicyEditorState(dailyLimitText: '-1').problems,
        contains(PolicyFormProblem.dailyLimitOutOfRange),
      );
    });

    test('a BLANK daily limit is valid and means «send no key at all»', () {
      // An absent key and an explicit null are not the same thing to
      // `class-validator`: `@IsOptional()` skips the former and validates the
      // latter. Blank therefore has to survive as `null`, not as 0.
      const state = PolicyEditorState(dailyLimitText: '   ');
      expect(state.problems, isEmpty);
      expect(state.dailyLimitMinutes, isNull);
    });

    test('a non-numeric daily limit is caught locally, not sent', () {
      expect(
        const PolicyEditorState(dailyLimitText: 'مئة').problems,
        contains(PolicyFormProblem.dailyLimitNotANumber),
      );
    });

    test('the bedtime pattern is the DTO regex — 24h, zero-padded', () {
      expect(const PolicyEditorState(bedtimeStart: '21:00').problems, isEmpty);
      expect(const PolicyEditorState(bedtimeStart: '00:00').problems, isEmpty);
      expect(const PolicyEditorState(bedtimeStart: '23:59').problems, isEmpty);
      // Refused by `/^([01]\d|2[0-3]):([0-5]\d)$/`, every one of them.
      for (final bad in <String>['24:00', '9:00', '21:60', '2100', '21:0']) {
        expect(
          PolicyEditorState(bedtimeStart: bad).problems,
          contains(PolicyFormProblem.bedtimeStartFormat),
          reason: bad,
        );
      }
    });

    test('an EMPTY bedtime is valid — that is how a parent clears one', () {
      const state = PolicyEditorState(bedtimeStart: '', bedtimeEnd: '');
      expect(state.problems, isEmpty);
      expect(state.bedtimeIncomplete, isFalse);
    });

    test('one end of the bedtime window without the other is ADVISORY, never '
        'a blocked save', () {
      // The DTO accepts each independently, so refusing to send it would be
      // this client inventing a rule the server does not have.
      const state = PolicyEditorState(bedtimeStart: '21:00');
      expect(state.bedtimeIncomplete, isTrue);
      expect(state.problems, isEmpty);
      expect(state.isValid, isTrue);
    });

    test('every problem is reported at once, not just the first', () {
      const state = PolicyEditorState(
        dailyLimitText: '5000',
        bedtimeStart: 'nope',
        bedtimeEnd: '99:99',
      );
      expect(state.problems, hasLength(3));
    });
  });

  // =========================================================================
  group('BlockedAppsScreen — rules, and the picker that makes them usable', () {
    testWidgets('loading', (tester) async {
      await _pumpBlocked(
        tester,
        FakeScreenTimeRepository(
          onListAppBlockRules: () => stalled<List<AppBlockRule>>(),
        ),
      );
      expect(find.byType(DsLoadingState), findsOneWidget);
    });

    testWidgets('EMPTY — no rules is an empty state with a way out, not an error',
        (tester) async {
      await _pumpBlocked(
        tester,
        FakeScreenTimeRepository(
          onListAppBlockRules: () async => const <AppBlockRule>[],
        ),
      );
      await tester.pump();

      expect(find.byType(DsEmptyState), findsOneWidget);
      expect(find.text(ar('blockedApps.emptyTitle')), findsOneWidget);
      expect(find.byType(DsErrorState), findsNothing);
    });

    testWidgets("ERROR — the server's own Arabic sentence", (tester) async {
      await _pumpBlocked(
        tester,
        FakeScreenTimeRepository(
          onListAppBlockRules: () => refused<List<AppBlockRule>>(),
        ),
      );
      await tester.pump();

      expect(find.byType(DsErrorState), findsOneWidget);
      expect(find.text(ar('blockedApps.errorTitle')), findsOneWidget);
      expect(find.text(screenTimeFailure.messageAr!), findsOneWidget);
    });

    testWidgets('a rule renders its RAW package name, untranslated', (tester) async {
      // A package name is an identifier the device enforces on. Translating it
      // or localising it would make it stop matching.
      await _pumpBlocked(
        tester,
        FakeScreenTimeRepository(
          onListAppBlockRules: () async =>
              <AppBlockRule>[testRule(packageName: 'com.example.game')],
        ),
      );
      await tester.pump();

      expect(find.text('com.example.game'), findsOneWidget);
      expect(find.text(ar('appRuleType.BLOCK')), findsOneWidget);
      expect(find.text(ar('blockedApps.targetPackage')), findsOneWidget);
    });

    testWidgets('the removal copy says STOP, never DELETE — the server '
        'deactivates the row and keeps it', (tester) async {
      final repository = FakeScreenTimeRepository(
        onListAppBlockRules: () async => <AppBlockRule>[testRule()],
        onDeactivateAppBlockRule: () async {},
      );
      await _pumpBlocked(tester, repository);
      await tester.pump();

      await tester.tap(find.text(ar('blockedApps.stop')));
      await tester.pump();

      expect(find.text(ar('blockedApps.stopConfirmTitle')), findsOneWidget);
      expect(
        find.text(ar('blockedApps.stopConfirmBody',
            options: {'target': 'com.example.game'})),
        findsOneWidget,
      );

      await tester.tap(find.text(ar('blockedApps.stop')).last);
      await tester.pump();
      await tester.pump();

      expect(repository.deactivatedRuleIds, <String>['rule_1']);
    });

    testWidgets('an unknown ruleType falls back to a readable label — never '
        '«appRuleType.FOO» on a parent screen', (tester) async {
      await _pumpBlocked(
        tester,
        FakeScreenTimeRepository(
          onListAppBlockRules: () async =>
              <AppBlockRule>[testRule(ruleType: 'SOMETHING_NEW')],
        ),
      );
      await tester.pump();

      expect(find.text(ar('appRuleType.unknown')), findsOneWidget);
      expect(find.text('appRuleType.SOMETHING_NEW'), findsNothing);
    });
  });

  // =========================================================================
  group('The app picker — an empty catalogue is EXPLAINED, never fabricated', () {
    testWidgets('EMPTY — it names both causes: no device paired, or not synced',
        (tester) async {
      await _pumpBlocked(
        tester,
        FakeScreenTimeRepository(
          onListAppBlockRules: () async => const <AppBlockRule>[],
          onListChildApps: () async => const <AppCatalogEntry>[],
        ),
      );
      await tester.pump();

      await tester.tap(find.text(ar('blockedApps.addAction')).first);
      await tester.pump();
      await tester.pump();

      expect(find.text(ar('appPicker.emptyTitle')), findsOneWidget);
      expect(find.text(ar('appPicker.emptyBody')), findsOneWidget);
      // NOTHING IS FABRICATED to fill it. A placeholder list would be package
      // names this app invented, which a parent could then block on a device
      // that does not have them.
      expect(find.text('com.example.game'), findsNothing);
      expect(find.byType(DsErrorState), findsNothing);
    });

    testWidgets('ERROR — a failed catalogue read is not shown as «no apps»',
        (tester) async {
      await _pumpBlocked(
        tester,
        FakeScreenTimeRepository(
          onListAppBlockRules: () async => const <AppBlockRule>[],
          onListChildApps: () => refused<List<AppCatalogEntry>>(),
        ),
      );
      await tester.pump();

      await tester.tap(find.text(ar('blockedApps.addAction')).first);
      await tester.pump();
      await tester.pump();

      expect(find.text(ar('appPicker.errorTitle')), findsOneWidget);
      expect(find.text(screenTimeFailure.messageAr!), findsOneWidget);
      expect(find.text(ar('appPicker.emptyTitle')), findsNothing);
    });

    testWidgets('picking an app blocks THAT package — no typing required',
        (tester) async {
      final repository = FakeScreenTimeRepository(
        onListAppBlockRules: () async => const <AppBlockRule>[],
        onListChildApps: () async => <AppCatalogEntry>[
          testApp(packageName: 'com.example.game', appName: 'لعبة'),
        ],
        onBlockPackage: () async => testRule(),
      );
      await _pumpBlocked(tester, repository);
      await tester.pump();

      await tester.tap(find.text(ar('blockedApps.addAction')).first);
      await tester.pump();
      await tester.pump();

      // The device's own label AND the raw identifier, so a parent can tell two
      // apps with the same name apart.
      expect(find.text('لعبة'), findsOneWidget);
      expect(find.text('com.example.game'), findsOneWidget);

      await tester.tap(find.text('لعبة'));
      await tester.pump();
      await tester.pump();

      expect(repository.blockedPackages, <String>['com.example.game']);
    });
  });

  // =========================================================================
  // ONE «WHICH CHILD?» FLOW, NOT TWO.
  //
  // `ChildPicker` was extracted FROM this screen for `abny://progress` and
  // `abny://coach`, and this original caller kept its own byte-identical copy
  // of the three-way resolution — the same rule, the same row parsing, the
  // same «drop a row with no id» guard, maintained twice. These tests assert
  // the SHARED widget is what answers `abny://screen-time` now, and that the
  // three outcomes a family can have still come out the same.
  // =========================================================================
  group('ScreenTimeChildrenScreen — where `abny://screen-time` lands', () {
    testWidgets('it delegates to the shared picker rather than resolving on '
        'its own', (tester) async {
      await _pumpChildren(tester, onGetChildren: () => pending());

      expect(find.byType(ChildPicker), findsOneWidget);
    });

    testWidgets('NO CHILDREN — an empty state that says so, not an error',
        (tester) async {
      await _pumpChildren(
        tester,
        onGetChildren: () async => const <dynamic>[],
      );
      await tester.pump();

      expect(find.byType(DsEmptyState), findsOneWidget);
      expect(find.text(ar('screenTime.noChildrenTitle')), findsOneWidget);
      expect(find.text(ar('screenTime.noChildrenBody')), findsOneWidget);
      expect(find.byType(DsErrorState), findsNothing);
    });

    testWidgets('EXACTLY ONE CHILD — that child\'s overview IS this route, '
        'with no one-item list to tap through', (tester) async {
      await _pumpChildren(
        tester,
        onGetChildren: () async => <dynamic>[
          <String, dynamic>{'id': _childId, 'firstName': 'محمد'},
        ],
      );
      await tester.pump();

      final opened = tester.widget<ScreenTimeOverviewScreen>(
          find.byType(ScreenTimeOverviewScreen));
      expect(opened.childId, _childId);
      expect(opened.childName, 'محمد');
    });

    testWidgets('SEVERAL CHILDREN — it ASKS, and names every one of them',
        (tester) async {
      await _pumpChildren(
        tester,
        onGetChildren: () async => <dynamic>[
          <String, dynamic>{'id': _childId, 'firstName': 'محمد'},
          <String, dynamic>{'id': 'child_2', 'firstName': 'مريم'},
        ],
      );
      await tester.pump();

      expect(find.text(ar('screenTime.pickChildHint')), findsOneWidget);
      expect(find.text('محمد'), findsOneWidget);
      expect(find.text('مريم'), findsOneWidget);
      expect(find.byType(ScreenTimeOverviewScreen), findsNothing);
    });

    testWidgets("ERROR — the server's own Arabic sentence, never transport "
        'text', (tester) async {
      final failure = refusalFailure(
        statusCode: 403,
        messageAr: 'لا تملك صلاحية عرض هذه العائلة.',
        code: 'FORBIDDEN',
      );
      await _pumpChildren(
        tester,
        onGetChildren: () => failingWith<List<dynamic>>(failure),
      );
      await tester.pump();

      expect(find.text(ar('screenTime.pickChildErrorTitle')), findsOneWidget);
      expect(find.text(failure.messageAr!), findsOneWidget);
      expect(find.byType(DsEmptyState), findsNothing);
    });
  });
}

/// The picker's own screen. The overview it can reach is stalled on purpose:
/// what is asserted here is WHICH screen was reached with WHICH argument, and
/// a screen that also had to render data would make a failure ambiguous
/// between the picker and it.
Future<void> _pumpChildren(
  WidgetTester tester, {
  required Future<List<dynamic>> Function() onGetChildren,
}) =>
    pumpParentScreen(
      tester,
      const ScreenTimeChildrenScreen(),
      overrides: [
        dashboardApiProvider
            .overrideWithValue(FakeDashboardApi(onGetChildren: onGetChildren)),
        screenTimeRepositoryProvider.overrideWithValue(
          FakeScreenTimeRepository(
            onGetPolicy: () => stalled<ScreenTimePolicy?>(),
            onGetEffectivePolicy: () => stalled<EffectiveScreenTimePolicy>(),
          ),
        ),
      ],
    );

// ---------------------------------------------------------------------------
// Pump helpers. All three reuse `pumpParentScreen`, so these screens are built
// inside the SAME MaterialApp shape `main.dart` uses — same theme, same
// delegates, same Arabic-first `supportedLocales`. A screen that only renders
// under a bespoke wrapper has not been tested.
// ---------------------------------------------------------------------------

/// TWO PUMPS, NOT ONE, and only here. `ScreenTimeOverviewController.load()`
/// awaits the configured read and THEN the effective read — two sequential
/// futures, not one — so a single frame is not guaranteed to have seen both
/// resolve. The loading assertion is unaffected: it stalls the effective read,
/// which never completes however many frames are pumped.
Future<void> _pumpOverview(
  WidgetTester tester,
  FakeScreenTimeRepository repository, {
  AppLocale locale = AppLocale.ar,
}) async {
  await pumpParentScreen(
    tester,
    const ScreenTimeOverviewScreen(childId: _childId, childName: 'محمد'),
    overrides: [screenTimeRepositoryProvider.overrideWithValue(repository)],
    locale: locale,
  );
  await tester.pump();
}

Future<void> _pumpEditor(
  WidgetTester tester,
  FakeScreenTimeRepository repository,
) =>
    pumpParentScreen(
      tester,
      const ScreenTimePolicyEditorScreen(childId: _childId, childName: 'محمد'),
      overrides: [screenTimeRepositoryProvider.overrideWithValue(repository)],
    );

Future<void> _pumpBlocked(
  WidgetTester tester,
  FakeScreenTimeRepository repository,
) =>
    pumpParentScreen(
      tester,
      const BlockedAppsScreen(childId: _childId, childName: 'محمد'),
      overrides: [screenTimeRepositoryProvider.overrideWithValue(repository)],
    );
