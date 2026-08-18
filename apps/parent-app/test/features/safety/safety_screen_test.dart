// WHAT THIS FILE PROVES — the safety surface answers ALL FOUR of [UiState]'s
// cases, it shows a parent the SERVER'S sentence and never a machine value, it
// never reads `data`, and an alert id that names nothing degrades into a
// readable page rather than an empty one or a crash.
//
// The defect it locks down, in one sentence: a parent who received
// `PROTECTION_BYPASS_ATTEMPT`, `ACCESSIBILITY_DISABLED`, `POLICY_VIOLATION` or
// `CHILD_WELLBEING_CHECKIN` had nowhere to go when they tapped it, because no
// safety screen existed at all.
//
// THE FOUR WAYS THE FIX CAN BE WRONG, and why each has a test:
//   1. it shows a raw enum or a status code — a parent must never read
//      `PROTECTION_BYPASS_ATTEMPT` or `CRITICAL`;
//   2. it renders `notifications.data`, which carries a DEVICE-supplied
//      `metadata` object nobody has enumerated, and on the distress path would
//      undo the server's deliberate «generic alert, no payload» guarantee;
//   3. it fails the whole screen when a SECOND, decorative call (the child
//      names) fails — an alert that arrived perfectly well must still be shown;
//   4. it shows nothing at all for an alert id it cannot find, which reads as
//      «that never happened».
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK, no Dart SDK and no
// pub.dev reachable from the environment this was authored in. STATIC VERIFIED
// by `scripts/dart_preflight.py`, `scripts/verify_dart_imports.py` and
// `scripts/verify_l10n_parity.py` only — constructor arity, named parameters,
// member references, import scope and locale-key parity — none of which is a
// Dart analyser and none of which executes anything. First execution happens on
// a CI runner.

import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/design_system/design_system.dart';
import 'package:parent_app/core/di/providers.dart';
import 'package:parent_app/features/family/data/child_profile_repository.dart';
import 'package:parent_app/features/family/presentation/child_detail_screen.dart';
import 'package:parent_app/features/safety/data/safety_repository.dart';
import 'package:parent_app/features/safety/domain/safety_event.dart';
import 'package:parent_app/features/safety/presentation/safety_screen.dart';

import '../../support/last_screens_test_harness.dart';

const String _childId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const String _alertId = '9a0c0305-4f89-11d3-3f25-04e082c33012';

/// `implements` + `noSuchMethod`, the codegen-free pattern the rest of this
/// suite uses: `@GenerateMocks` needs `build_runner`, which needs pub.dev.
class _FakeSafetyRepository implements SafetyRepository {
  _FakeSafetyRepository({this.onListSafetyEvents, this.onChildNames});

  final Future<List<SafetyEvent>> Function()? onListSafetyEvents;
  final Future<Map<String, String>> Function()? onChildNames;

  int listCalls = 0;

  @override
  Future<List<SafetyEvent>> listSafetyEvents() {
    listCalls++;
    final slot = onListSafetyEvents;
    if (slot == null) {
      throw StateError('_FakeSafetyRepository.listSafetyEvents not stubbed.');
    }
    return slot();
  }

  @override
  Future<Map<String, String>> childNamesById() {
    final slot = onChildNames;
    // Unstubbed means «the names call is not what this test is about», and an
    // empty map is exactly what the screen must survive.
    if (slot == null) return Future<Map<String, String>>.value(<String, String>{});
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        '_FakeSafetyRepository has no stub for ${invocation.memberName} — the '
        'screen under test is calling something this test did not expect.',
      );
}

SafetyEvent _event({
  String id = _alertId,
  String type = SafetyEventTypes.protectionBypassAttempt,
  String title = 'محاولة تعطيل الحماية',
  String body = 'سُجّلت محاولة على جهاز محمد.',
  String? childId = _childId,
  bool isUnread = true,
  DateTime? occurredAt,
}) =>
    SafetyEvent(
      id: id,
      type: type,
      title: title,
      body: body,
      isUnread: isUnread,
      childId: childId,
      occurredAt: occurredAt,
    );

void main() {
  testWidgets('LOADING — a spinner while the feed is being fetched', (tester) async {
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () => pending<List<SafetyEvent>>(),
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(),
      overrides: [safetyRepositoryProvider.overrideWithValue(repository)],
    );

    expect(find.byType(DsLoadingState), findsOneWidget);
    expect(repository.listCalls, 1);
  });

  testWidgets('EMPTY — no alerts reads as reassurance, not as a failure',
      (tester) async {
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () async => const <SafetyEvent>[],
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(),
      overrides: [safetyRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();

    expect(find.byType(DsEmptyState), findsOneWidget);
    expect(find.text(ar('safety.emptyTitle')), findsOneWidget);
    expect(find.text(ar('safety.emptyBody')), findsOneWidget);
    // An empty feed and a failed fetch must never render identically — the bug
    // `dashboard_home_screen.dart` carried until its own review caught it.
    expect(find.byType(DsErrorState), findsNothing);
  });

  testWidgets('EMPTY — an empty feed reached FROM A LINK does not say «no alerts»',
      (tester) async {
    // The two empties mean opposite things. A parent who tapped an alert and is
    // told «nothing has come through» has been told their alert did not happen.
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () async => const <SafetyEvent>[],
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(alertId: _alertId),
      overrides: [safetyRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();

    expect(find.byType(DsEmptyState), findsOneWidget);
    expect(find.text(ar('safety.notInRecentTitle')), findsOneWidget);
    expect(find.text(ar('safety.notInRecent')), findsOneWidget);
    expect(find.text(ar('safety.emptyTitle')), findsNothing);
  });

  testWidgets('ERROR — the server\'s own Arabic, with a retry, never e.toString()',
      (tester) async {
    final failure = refusalFailure(
      statusCode: 403,
      code: 'FORBIDDEN',
      messageAr: 'لا تملك صلاحية عرض هذه التنبيهات.',
    );
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () => failingWith<List<SafetyEvent>>(failure),
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(),
      overrides: [safetyRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();

    expect(find.byType(DsErrorState), findsOneWidget);
    expect(find.text('لا تملك صلاحية عرض هذه التنبيهات.'), findsOneWidget);
    expect(find.text(ar('safety.errorTitle')), findsOneWidget);
    // No status code anywhere on the screen.
    expect(find.textContaining('403'), findsNothing);
  });

  testWidgets('ERROR — a transport failure never puts raw English on the screen',
      (tester) async {
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () => failingWith<List<SafetyEvent>>(proxyFailure()),
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(),
      overrides: [safetyRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();

    expect(find.textContaining('502'), findsNothing);
    expect(find.textContaining('invalid status code'), findsNothing);
    expect(find.text('تعذّر إتمام الطلب. حاول مرة أخرى بعد قليل.'), findsOneWidget);
  });

  testWidgets('DATA — the server sentence renders verbatim and the type never does',
      (tester) async {
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () async => <SafetyEvent>[_event()],
      onChildNames: () async => <String, String>{_childId: 'محمد'},
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(),
      overrides: [safetyRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();
    await tester.pump();

    // 1. THE SERVER'S WORDS, UNTOUCHED — not passed through `t()`.
    expect(find.text('محاولة تعطيل الحماية'), findsOneWidget);
    expect(find.text('سُجّلت محاولة على جهاز محمد.'), findsOneWidget);
    // 2. The app's own label for the KIND of event, and the band.
    expect(find.text(ar('safetyType.PROTECTION_BYPASS_ATTEMPT')), findsOneWidget);
    expect(find.text(ar('safetyBand.needsAttention')), findsOneWidget);
    // 3. What the parent can do.
    expect(find.text(ar('safetyGuidance.PROTECTION_BYPASS_ATTEMPT')), findsOneWidget);
    // 4. AND THE RAW TYPE IS NOWHERE, which is the whole rule.
    expect(find.textContaining('PROTECTION_BYPASS_ATTEMPT'), findsNothing);
    expect(find.textContaining('CRITICAL'), findsNothing);
    // The child is named, not identified.
    expect(find.text('محمد'), findsWidgets);
    expect(find.textContaining(_childId), findsNothing);
  });

  testWidgets('DATA — the distress check-in states the privacy guarantee out loud',
      (tester) async {
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () async => <SafetyEvent>[
        _event(
          type: SafetyEventTypes.wellbeingCheckin,
          // The GENERIC sentence `distressParentAlert` really sends — it names
          // the child and says nothing about what the child wrote.
          title: 'اطمئن على محمد',
          body: 'ظهرت إشارات تستحق اطمئنانك على محمد الآن.',
        ),
      ],
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(),
      overrides: [safetyRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();
    await tester.pump();

    expect(find.text(ar('safetyType.CHILD_WELLBEING_CHECKIN')), findsOneWidget);
    expect(find.text(ar('safetyGuidance.CHILD_WELLBEING_CHECKIN')), findsOneWidget);
    // It is the highest band, because the server classifies this one DELIVER.
    expect(find.text(ar('safetyBand.needsAttention')), findsOneWidget);
  });

  testWidgets('DATA — the child names failing does NOT fail the screen',
      (tester) async {
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () async => <SafetyEvent>[_event()],
      onChildNames: () => failingWith<Map<String, String>>(proxyFailure()),
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(),
      overrides: [safetyRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();
    await tester.pump();

    // The alert is on screen; only the decoration is missing.
    expect(find.text('محاولة تعطيل الحماية'), findsOneWidget);
    expect(find.byType(DsErrorState), findsNothing);
    // The child link is still offered — it just cannot name the child.
    expect(find.text(ar('safety.openChild')), findsOneWidget);
  });

  testWidgets('DATA — the child link opens the child page with the id off the row',
      (tester) async {
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () async => <SafetyEvent>[_event()],
      onChildNames: () async => <String, String>{_childId: 'محمد'},
    );
    // The child page will ask for the child; leaving it pending keeps it in its
    // loading state, which is all this test needs it to reach.
    final children = FakeChildProfileRepository(
      onGetChild: () => pending<ChildProfile>(),
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(),
      overrides: [
        safetyRepositoryProvider.overrideWithValue(repository),
        childProfileRepositoryProvider.overrideWithValue(children),
      ],
    );
    await tester.pump();
    await tester.pump();

    await tester.tap(
      find.text(ar('safety.openChildNamed', options: {'name': 'محمد'})),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final child = tester.widget<ChildDetailScreen>(find.byType(ChildDetailScreen));
    expect(child.childId, _childId);
  });

  testWidgets('an alertId that matches nothing still shows the recent list, and says so',
      (tester) async {
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () async => <SafetyEvent>[_event(id: 'another-alert')],
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(alertId: _alertId),
      overrides: [safetyRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();
    await tester.pump();

    expect(find.text(ar('safety.notInRecent')), findsOneWidget);
    // NOT an empty page: the alert that IS there is still shown.
    expect(find.text('محاولة تعطيل الحماية'), findsOneWidget);
    expect(find.byType(DsEmptyState), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an alertId that matches is shown FIRST, and nothing is hidden',
      (tester) async {
    final repository = _FakeSafetyRepository(
      onListSafetyEvents: () async => <SafetyEvent>[
        _event(id: 'older', title: 'تنبيه أقدم', type: SafetyEventTypes.policyViolation),
        _event(id: _alertId, title: 'التنبيه المقصود'),
      ],
    );

    await pumpParentScreen(
      tester,
      const SafetyScreen(alertId: _alertId),
      overrides: [safetyRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();
    await tester.pump();

    expect(find.text(ar('safety.notInRecent')), findsNothing);
    expect(find.text('التنبيه المقصود'), findsOneWidget);
    // The rest of the feed is still there — one alert is rarely the whole story.
    expect(find.text('تنبيه أقدم'), findsOneWidget);
  });

  group('the ordering helper', () {
    test('the focused event leads and every other row survives', () {
      final a = _event(id: 'a');
      final b = _event(id: 'b');
      final c = _event(id: 'c');
      final rows = <SafetyEvent>[a, b, c];

      final focused = SafetyScreenOrdering.focusedIn(rows, 'b');
      expect(focused, isNotNull);
      final ordered = SafetyScreenOrdering.ordered(rows, focused);
      expect(ordered.length, 3);
      expect(ordered.first.id, 'b');
      expect(ordered.map((e) => e.id).toList(), <String>['b', 'a', 'c']);
    });

    test('no alertId, or one nothing matches, leaves the server order alone', () {
      final rows = <SafetyEvent>[_event(id: 'a'), _event(id: 'b')];
      expect(SafetyScreenOrdering.focusedIn(rows, null), isNull);
      expect(SafetyScreenOrdering.focusedIn(rows, 'nope'), isNull);
      expect(SafetyScreenOrdering.ordered(rows, null), rows);
    });
  });

  group('SafetyEvent.fromJson — the filter and the whitelist', () {
    test('a safety-class row is read, and `data` is not one of the keys', () {
      final row = <String, dynamic>{
        'id': _alertId,
        'type': SafetyEventTypes.accessibilityDisabled,
        'title': 'Protection turned off',
        'body': 'Device protection was disabled.',
        'childId': _childId,
        'readAt': null,
        'createdAt': '2026-08-17T19:40:00.000Z',
        // The device-supplied payload. There is no field to hold it.
        'data': <String, dynamic>{'metadata': 'whatever the device sent'},
        // The database value that must never be read.
        'priority': 'CRITICAL',
      };
      final event = SafetyEvent.fromJson(row);

      expect(event, isNotNull);
      expect(event!.id, _alertId);
      expect(event.type, SafetyEventTypes.accessibilityDisabled);
      expect(event.title, 'Protection turned off');
      expect(event.childId, _childId);
      expect(event.isUnread, isTrue);
      expect(event.band, SafetyBand.needsAttention);
    });

    test('a non-safety row is dropped rather than rendered', () {
      final reward = <String, dynamic>{
        'id': 'n_1',
        'type': 'REWARD_GRANTED',
        'title': 'مبروك',
        'body': 'حصل محمد على مكافأة.',
      };
      // `CHILD_REQUEST` is SAFETY-category server-side but belongs to the
      // approval queue, not here — see SafetyEventTypes' own docstring.
      final request = <String, dynamic>{
        'id': 'n_2',
        'type': 'CHILD_REQUEST',
        'title': 'طلب',
        'body': 'أرسل محمد طلبًا.',
      };
      expect(SafetyEvent.fromJson(reward), isNull);
      expect(SafetyEvent.fromJson(request), isNull);
    });

    test('a malformed row is dropped, never half-rendered', () {
      final noId = <String, dynamic>{'type': SafetyEventTypes.policyViolation};
      final noType = <String, dynamic>{'id': 'n_1'};
      expect(SafetyEvent.fromJson(noId), isNull);
      expect(SafetyEvent.fromJson(noType), isNull);
      expect(SafetyEvent.fromJson('not a map'), isNull);
      expect(SafetyEvent.fromJson(null), isNull);
    });

    test('a missing title, body, child or timestamp is absence, not a crash', () {
      final sparse = <String, dynamic>{
        'id': 'n_1',
        'type': SafetyEventTypes.runtimeAlert,
        'createdAt': 'not a date',
      };
      final event = SafetyEvent.fromJson(sparse);
      expect(event, isNotNull);
      expect(event!.title, '');
      expect(event.body, '');
      expect(event.childId, isNull);
      expect(event.occurredAt, isNull);
      expect(event.band, SafetyBand.forInformation);
    });

    test('the bands follow the server\'s own quiet-hours classification', () {
      expect(safetyBandOf(SafetyEventTypes.accessibilityDisabled),
          SafetyBand.needsAttention);
      expect(safetyBandOf(SafetyEventTypes.protectionBypassAttempt),
          SafetyBand.needsAttention);
      expect(safetyBandOf(SafetyEventTypes.wellbeingCheckin),
          SafetyBand.needsAttention);
      expect(safetyBandOf(SafetyEventTypes.policyViolation),
          SafetyBand.worthReviewing);
      expect(safetyBandOf(SafetyEventTypes.screenTimeExceeded),
          SafetyBand.worthReviewing);
      expect(safetyBandOf(SafetyEventTypes.runtimeAlert),
          SafetyBand.forInformation);
    });
  });
}
