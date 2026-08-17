// WHAT THIS FILE PROVES — the parent is told whether pairing worked, and
// the screen does not leave a timer running behind it.
//
// The defect it locks down: `AddChildScreen` called `POST /pairing/invite`,
// printed the code, ran a countdown and stopped. Whether the child's device
// ever paired was never shown, never polled for, and never revocable.
//
// The three things asserted here are the three ways the fix can be wrong:
//   1. it never stops polling once it has its answer (a screen that keeps
//      hitting the network after it is done);
//   2. it never stops polling when the invite has expired (an unbounded
//      loop against a code that can no longer be redeemed);
//   3. the timer outlives the State (a `Timer.periodic` firing `setState`
//      on a defunct element — an assertion in debug, a leak in release).
//
// `flutter_test` fails a test outright when a timer is still pending at the
// end, so (3) is enforced by the framework as well as asserted here.
//
// EXECUTION STATUS: NEVER RUN. No Flutter SDK is reachable from the
// environment this was authored in. STATIC VERIFIED by
// `scripts/dart_preflight.py` only — that script checks constructor arity,
// named parameters, member references and import scope, is not a Dart
// analyser, and executes nothing. First execution happens on a CI runner.

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:parent_app/core/di/providers.dart';
import 'package:parent_app/core/localization/locale_controller.dart';
import 'package:parent_app/core/localization/localization_engine.dart';
import 'package:parent_app/core/theme/app_theme.dart';
import 'package:parent_app/features/dashboard/api/dashboard_api.dart';
import 'package:parent_app/features/pairing/api/pairing_api.dart';
import 'package:parent_app/features/pairing/presentation/add_child_screen.dart';

// ---------------------------------------------------------------------------
// Fakes. `implements` + `noSuchMethod`, the same codegen-free pattern
// `test/support/reward_test_harness.dart` uses — `build_runner` cannot be run
// from an environment with no pub.dev.
// ---------------------------------------------------------------------------

class _FakeDashboardApi implements DashboardApi {
  _FakeDashboardApi({required this.children, required this.devices});

  final List<dynamic> children;

  /// Mutable so a test can make a device appear between two polls, which is
  /// exactly what happens when a child finally types the code in.
  List<dynamic> devices;

  /// Every `GET /pairing/devices`, counted. "Polling stopped" is a claim
  /// about this number not growing.
  int getDevicesCalls = 0;

  @override
  Future<List<dynamic>> getChildren() async => children;

  @override
  Future<List<dynamic>> getDevices() async {
    getDevicesCalls++;
    return devices;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        '_FakeDashboardApi has no stub for ${invocation.memberName}.',
      );
}

class _FakePairingApi implements PairingApi {
  _FakePairingApi({this.expiresInSeconds = 120});

  final int expiresInSeconds;
  final List<String> revoked = <String>[];
  int inviteCalls = 0;

  @override
  Future<Map<String, dynamic>> generateInviteCode(String childId) async {
    inviteCalls++;
    return <String, dynamic>{'code': '482913', 'expiresInSeconds': expiresInSeconds};
  }

  @override
  Future<void> revokeDevice(String deviceId, {String? reason}) async {
    revoked.add(deviceId);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        '_FakePairingApi has no stub for ${invocation.memberName}.',
      );
}

const List<dynamic> _oneChild = <dynamic>[
  <String, dynamic>{'id': 'child_1', 'firstName': 'يوسف'},
];

Map<String, dynamic> _device({
  String id = 'dev_1',
  String childId = 'child_1',
  String status = 'PENDING_PAIRING',
}) =>
    <String, dynamic>{'id': id, 'childId': childId, 'status': status};

String _ar(String key, {Map<String, Object>? options}) =>
    translate(AppLocale.ar, key, options: options);

Future<void> _pumpScreen(
  WidgetTester tester, {
  required _FakeDashboardApi dashboard,
  required _FakePairingApi pairing,
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        dashboardApiProvider.overrideWithValue(dashboard),
        pairingApiProvider.overrideWithValue(pairing),
        localeControllerProvider.overrideWith(
          (ref) => LocaleController(storage: InMemoryLocaleStorage(AppLocale.ar)),
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        locale: const Locale('ar'),
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: const [Locale('ar'), Locale('en')],
        home: const AddChildScreen(),
      ),
    ),
  );

  // One frame for the tree, one for `_loadChildren`'s future.
  await tester.pump();
  await tester.pump();
}

Future<void> _tapGenerate(WidgetTester tester) async {
  await tester.tap(find.text(_ar('pairing.generateCode')));
  // Two awaits inside `_generateCode`: the baseline device read, then the
  // invite itself.
  await tester.pump();
  await tester.pump();
  await tester.pump();
}

/// Advances the fake clock by whole polling intervals, letting each poll's
/// own future settle before the next tick.
Future<void> _advancePolls(WidgetTester tester, int ticks) async {
  for (var i = 0; i < ticks; i++) {
    await tester.pump(AddChildScreen.pollInterval);
    await tester.pump();
  }
}

void main() {
  testWidgets('polling stops as soon as the child device appears', (tester) async {
    final dashboard = _FakeDashboardApi(children: _oneChild, devices: const <dynamic>[]);
    final pairing = _FakePairingApi();

    await _pumpScreen(tester, dashboard: dashboard, pairing: pairing);
    await _tapGenerate(tester);

    // The snapshot taken before the invite: one call, no devices.
    expect(pairing.inviteCalls, 1);
    expect(dashboard.getDevicesCalls, 1);
    expect(find.text(_ar('pairing.waitingTitle')), findsOneWidget);

    // The child types the code in; the device shows up on the next poll.
    dashboard.devices = <dynamic>[_device()];
    await _advancePolls(tester, 1);

    expect(find.text(_ar('pairing.connectedTitle')), findsOneWidget);
    expect(find.text(_ar('pairing.connectedPendingBody')), findsOneWidget);
    expect(find.text(_ar('pairing.waitingTitle')), findsNothing);

    final callsAtSuccess = dashboard.getDevicesCalls;

    // THE ASSERTION THAT MATTERS: no further polls, ever.
    await _advancePolls(tester, 12);
    expect(dashboard.getDevicesCalls, callsAtSuccess);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a device the child already owned is not mistaken for a new pairing',
      (tester) async {
    // The baseline exists precisely so this cannot happen: re-pairing a
    // second phone must not be "confirmed" by the first one.
    final dashboard = _FakeDashboardApi(
      children: _oneChild,
      devices: <dynamic>[_device(id: 'dev_old', status: 'ACTIVE')],
    );
    final pairing = _FakePairingApi();

    await _pumpScreen(tester, dashboard: dashboard, pairing: pairing);
    await _tapGenerate(tester);

    await _advancePolls(tester, 3);

    expect(find.text(_ar('pairing.connectedTitle')), findsNothing);
    expect(find.text(_ar('pairing.waitingTitle')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('polling stops when the invite has outlived its expiry', (tester) async {
    final dashboard = _FakeDashboardApi(children: _oneChild, devices: const <dynamic>[]);
    // 120s of validity + AddChildScreen.pollGrace (60s) = 180s of watching,
    // i.e. 36 ticks of the 5s interval.
    final pairing = _FakePairingApi(expiresInSeconds: 120);

    await _pumpScreen(tester, dashboard: dashboard, pairing: pairing);
    await _tapGenerate(tester);

    await _advancePolls(tester, 40);

    expect(find.text(_ar('pairing.notYetTitle')), findsOneWidget);
    expect(find.text(_ar('pairing.waitingTitle')), findsNothing);

    final callsAtTimeout = dashboard.getDevicesCalls;
    await _advancePolls(tester, 12);
    expect(dashboard.getDevicesCalls, callsAtTimeout);

    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('both timers are cancelled when the screen is disposed', (tester) async {
    final dashboard = _FakeDashboardApi(children: _oneChild, devices: const <dynamic>[]);
    final pairing = _FakePairingApi();

    await _pumpScreen(tester, dashboard: dashboard, pairing: pairing);
    await _tapGenerate(tester);
    await _advancePolls(tester, 2);

    final callsBeforeDispose = dashboard.getDevicesCalls;
    expect(callsBeforeDispose, greaterThan(1), reason: 'the watch should be running');

    // Navigating away, in the bluntest possible form.
    await tester.pumpWidget(const SizedBox.shrink());

    // Neither the poll timer nor the one-second countdown may fire again.
    // If either survived, this pump would either bump the counter or throw
    // `setState() called after dispose()`; and `flutter_test` fails the
    // test at teardown on any timer still pending.
    await tester.pump(const Duration(minutes: 5));
    expect(dashboard.getDevicesCalls, callsBeforeDispose);
  });

  testWidgets('the confirmed device can be unlinked through POST /pairing/revoke',
      (tester) async {
    final dashboard = _FakeDashboardApi(children: _oneChild, devices: const <dynamic>[]);
    final pairing = _FakePairingApi();

    await _pumpScreen(tester, dashboard: dashboard, pairing: pairing);
    await _tapGenerate(tester);

    dashboard.devices = <dynamic>[_device(id: 'dev_new')];
    await _advancePolls(tester, 1);
    expect(find.text(_ar('pairing.connectedTitle')), findsOneWidget);

    await tester.ensureVisible(find.text(_ar('pairing.revokeAction')));
    await tester.tap(find.text(_ar('pairing.revokeAction')));
    // Not pumpAndSettle: the one-second countdown schedules a frame every
    // second, so "settled" would mean "the code expired". 300ms covers the
    // dialog's 150ms transition.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // The dialog's confirm button carries the same label as the trigger, so
    // target the one inside the AlertDialog.
    await tester.tap(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text(_ar('pairing.revokeAction')),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(pairing.revoked, <String>['dev_new']);
    expect(find.text(_ar('pairing.revokedTitle')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
  });
}
