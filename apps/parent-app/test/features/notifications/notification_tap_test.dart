// WHAT THIS FILE PROVES — a tap on a notification row does BOTH things: it
// marks the row read (the behaviour the row already had, which navigation was
// not allowed to cost) and it lands the parent on the destination the SERVER
// resolved.
//
// The defect it locks down, in one sentence: `notifications_screen.dart`'s row
// `onTap` called `markAsRead` and returned, so every notification this product
// has ever sent ended in a tap that went nowhere.
//
// The five ways the fix can be wrong, one test each:
//   1. it navigates but stops marking read (a silent regression of working
//      behaviour, and an unread badge that never clears);
//   2. it marks read but still does not navigate (the original defect, dressed
//      up);
//   3. an ALREADY-READ row becomes dead — a read notification still has a
//      destination, and `onTap: isUnread ? ... : null` made it untappable;
//   4. an id-scoped destination is squeezed through a named route instead of
//      being constructed with its real argument (`app_routes.dart` documents
//      why that is not allowed);
//   5. a destination this app cannot open produces a blank screen, a crash or
//      nothing at all, instead of leaving the parent in the inbox and SAYING SO.
//
// WHY THE NAMED ROUTES POINT AT STUBS HERE. The MaterialApp below registers the
// same route NAMES `main.dart` registers, against trivial screens. The assertion
// under test is "the router pushed AppRoutes.goals" — pulling the real
// `ProgramsListScreen` in would additionally require its whole repository stack
// and would make a failure ambiguous between the router and that screen. The
// PAGE case is the opposite and uses the REAL `ProgramDetailScreen`, because
// there the thing being asserted is that a real constructor argument arrives.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK, no Dart SDK and no
// pub.dev reachable from the environment this was authored in. STATIC VERIFIED
// by `scripts/dart_preflight.py` only — constructor arity, named parameters,
// member references and import scope — which is not a Dart analyser and
// executes nothing. First execution happens on a CI runner.

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:parent_app/core/di/providers.dart';
import 'package:parent_app/core/localization/locale_controller.dart';
import 'package:parent_app/core/localization/localization_engine.dart';
import 'package:parent_app/core/notifications/push_registration_service.dart';
import 'package:parent_app/core/routing/app_routes.dart';
import 'package:parent_app/core/theme/app_theme.dart';
import 'package:parent_app/features/family/data/child_profile_repository.dart';
import 'package:parent_app/features/family/presentation/child_detail_screen.dart';
import 'package:parent_app/features/notifications/api/notifications_api.dart';
import 'package:parent_app/features/notifications/presentation/notifications_screen.dart';
import 'package:parent_app/features/rewards/domain/achievement.dart';
import 'package:parent_app/features/rewards/domain/reward_program.dart';
import 'package:parent_app/features/rewards/presentation/achievement_review_screen.dart';
import 'package:parent_app/features/rewards/presentation/program_detail_screen.dart';
import 'package:parent_app/features/safety/data/safety_repository.dart';
import 'package:parent_app/features/safety/domain/safety_event.dart';
import 'package:parent_app/features/safety/presentation/safety_screen.dart';

// `show` and nothing more: both harnesses declare `ar` and `pending`, and this
// file has always used the reward harness's pair. Importing the whole of the
// other one would make both names ambiguous.
import '../../support/last_screens_test_harness.dart' show FakeChildProfileRepository;
import '../../support/reward_test_harness.dart';

const String _uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

// ---------------------------------------------------------------------------
// Fakes — `implements` + `noSuchMethod`, the codegen-free pattern the rest of
// this suite uses. `build_runner` needs pub.dev, which answers 403 here.
// ---------------------------------------------------------------------------

class _FakeNotificationsApi implements NotificationsApi {
  _FakeNotificationsApi(this.rows);

  /// Mutable: `markAsRead` stamps `readAt` the way the server would, so the
  /// reload after a tap sees the row as read — which is what makes "the unread
  /// dot clears" a real assertion rather than a wish.
  List<dynamic> rows;

  final List<String> markedRead = <String>[];
  int listCalls = 0;

  @override
  Future<List<dynamic>> list({bool unreadOnly = false}) async {
    listCalls++;
    return rows;
  }

  @override
  Future<void> markAsRead(String id) async {
    markedRead.add(id);
    rows = rows.map((dynamic row) {
      final map = Map<String, dynamic>.from(row as Map<String, dynamic>);
      if (map['id'] == id) map['readAt'] = '2026-01-01T00:00:00.000Z';
      return map;
    }).toList();
  }

  @override
  Future<void> markAllAsRead() async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        '_FakeNotificationsApi has no stub for ${invocation.memberName} — the '
        'screen under test is calling an endpoint this test did not expect.',
      );
}

/// Reports `unavailable`, which is the ONE permission state that renders no
/// banner — so every `find` in this file addresses the list and nothing else.
class _FakePushRegistrationService implements PushRegistrationService {
  @override
  Future<ParentNotificationPermissionState> currentPermissionState() async =>
      ParentNotificationPermissionState.unavailable;

  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        '_FakePushRegistrationService has no stub for ${invocation.memberName}.',
      );
}

/// F1 — the safety feed, stubbed to a chosen outcome. The REAL `SafetyScreen`
/// is mounted for the safety route rather than a landing pad: what is being
/// asserted there is that a safety-class notification reaches the safety
/// SCREEN, and a stub bearing the route name would prove only that a string
/// matched.
class _FakeSafetyRepository implements SafetyRepository {
  _FakeSafetyRepository({this.events = const <SafetyEvent>[]});

  final List<SafetyEvent> events;

  @override
  Future<List<SafetyEvent>> listSafetyEvents() async => events;

  @override
  Future<Map<String, String>> childNamesById() async => <String, String>{};

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('_FakeSafetyRepository has no stub for ${invocation.memberName}.');
}

/// A named-route landing pad. Renders its own route name, so an assertion reads
/// «we arrived at AppRoutes.goals» rather than «some screen appeared».
class _StubScreen extends StatelessWidget {
  const _StubScreen(this.label);

  final String label;

  @override
  Widget build(BuildContext context) =>
      Scaffold(body: Center(child: Text(label)));
}

// ---------------------------------------------------------------------------

/// One inbox row, in the exact shape `GET /notifications` returns: the link
/// travels under `data.deepLink`, which is where the server puts it
/// (`NOTIFICATION_DEEP_LINK_DATA_KEY`).
Map<String, dynamic> _row({
  String id = 'n_1',
  String title = 'إشعار',
  String body = 'نص',
  String? deepLink,
  bool read = false,
}) =>
    <String, dynamic>{
      'id': id,
      'title': title,
      'body': body,
      'readAt': read ? '2026-01-01T00:00:00.000Z' : null,
      'data': deepLink == null ? <String, dynamic>{} : <String, dynamic>{'deepLink': deepLink},
    };

Future<void> _pumpInbox(
  WidgetTester tester, {
  required _FakeNotificationsApi api,
  FakeRewardProgramsRepository? repository,
  _FakeSafetyRepository? safety,
  FakeChildProfileRepository? children,
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;

  await tester.pumpWidget(
    ProviderScope(
      overrides: <Override>[
        notificationsApiProvider.overrideWithValue(api),
        pushRegistrationServiceProvider.overrideWithValue(_FakePushRegistrationService()),
        rewardProgramsRepositoryProvider
            .overrideWithValue(repository ?? FakeRewardProgramsRepository()),
        safetyRepositoryProvider.overrideWithValue(safety ?? _FakeSafetyRepository()),
        childProfileRepositoryProvider
            .overrideWithValue(children ?? FakeChildProfileRepository()),
        localeControllerProvider.overrideWith(
          (ref) => LocaleController(storage: InMemoryLocaleStorage(AppLocale.ar)),
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        locale: const Locale('ar'),
        localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: const <Locale>[Locale('ar'), Locale('en')],
        // `initialRoute` rather than `home:` on purpose — the router asks
        // `ModalRoute.of(context)?.settings.name` whether it is already on the
        // inbox, and `home:` would name this route '/' and defeat that check.
        initialRoute: AppRoutes.notifications,
        routes: <String, WidgetBuilder>{
          AppRoutes.notifications: (_) => const NotificationsScreen(),
          AppRoutes.goals: (_) => const _StubScreen(AppRoutes.goals),
          AppRoutes.goalReviewQueue: (_) => const _StubScreen(AppRoutes.goalReviewQueue),
          AppRoutes.fulfilments: (_) => const _StubScreen(AppRoutes.fulfilments),
          AppRoutes.subscription: (_) => const _StubScreen(AppRoutes.subscription),
          // THE REAL SCREEN, for the reason given above `_FakeSafetyRepository`.
          AppRoutes.safety: (_) => const SafetyScreen(),
        },
      ),
    ),
  );

  // One frame for the tree, one for `_load()` and the permission read. NOT
  // `pumpAndSettle` — the loading state holds an indeterminate progress
  // indicator, whose animation never settles.
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('a tap marks the row read AND navigates to the destination', (tester) async {
    final api = _FakeNotificationsApi(<dynamic>[_row(deepLink: 'abny://goals')]);
    await _pumpInbox(tester, api: api);

    expect(find.text('إشعار'), findsOneWidget);

    await tester.tap(find.text('إشعار'));
    await tester.pump(); // the awaited markAsRead
    await tester.pump(); // the push
    await tester.pump(const Duration(seconds: 1)); // the route transition

    // 1. it marked read — the behaviour that existed before, unchanged.
    expect(api.markedRead, <String>['n_1']);
    // 2. it navigated — the behaviour that did not exist at all.
    expect(find.text(AppRoutes.goals), findsOneWidget);
    // …and it reloaded the list, so the unread dot clears behind the push.
    expect(api.listCalls, greaterThan(1));
  });

  testWidgets('an ALREADY-READ row still navigates, and is not marked read twice',
      (tester) async {
    final api = _FakeNotificationsApi(<dynamic>[
      _row(deepLink: 'abny://subscription', read: true),
    ]);
    await _pumpInbox(tester, api: api);

    await tester.tap(find.text('إشعار'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expect(find.text(AppRoutes.subscription), findsOneWidget);
    expect(api.markedRead, isEmpty);
  });

  testWidgets('an id-scoped link opens the REAL screen with its real argument',
      (tester) async {
    final api = _FakeNotificationsApi(<dynamic>[_row(deepLink: 'abny://goal/$_uuid')]);
    // The detail screen will ask for the program; leaving it pending keeps it in
    // its loading state, which is all this test needs it to reach.
    final repository = FakeRewardProgramsRepository(
      onGetProgram: () => pending<RewardProgram>(),
    );

    await _pumpInbox(tester, api: api, repository: repository);

    await tester.tap(find.text('إشعار'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final detail = tester.widget<ProgramDetailScreen>(find.byType(ProgramDetailScreen));
    expect(detail.programId, _uuid);
    expect(api.markedRead, <String>['n_1']);
  });

  testWidgets('an approval link opens the review screen with the achievement id',
      (tester) async {
    final api = _FakeNotificationsApi(<dynamic>[_row(deepLink: 'abny://approval/$_uuid')]);
    final repository = FakeRewardProgramsRepository(
      onGetAchievementDetail: () => pending<AchievementDetail>(),
      onListAttempts: () => pending<List<VerificationAttempt>>(),
    );

    await _pumpInbox(tester, api: api, repository: repository);

    await tester.tap(find.text('إشعار'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final review = tester.widget<AchievementReviewScreen>(find.byType(AchievementReviewScreen));
    expect(review.achievementId, _uuid);
  });

  testWidgets('a SAFETY-class notification now reaches the safety screen, not the inbox',
      (tester) async {
    // THE TAP THIS WHOLE SURFACE EXISTS FOR. `PROTECTION_BYPASS_ATTEMPT`,
    // `ACCESSIBILITY_DISABLED` and `POLICY_VIOLATION` all resolve server-side
    // through `safetyDestination`, which degrades to `abny://screen-time`
    // because no producer carries an `alertId` — so this link is what a parent
    // actually receives today, and it used to land back in the inbox.
    final api = _FakeNotificationsApi(<dynamic>[
      _row(title: 'محاولة تعطيل الحماية', deepLink: 'abny://screen-time'),
    ]);
    await _pumpInbox(tester, api: api);

    await tester.tap(find.text('محاولة تعطيل الحماية'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(SafetyScreen), findsOneWidget);
    // And it is NOT the honest-fallback path any more.
    expect(find.text(ar('deepLink.unavailable')), findsNothing);
    // The row is still marked read — the behaviour navigation was never allowed
    // to cost.
    expect(api.markedRead, <String>['n_1']);
  });

  testWidgets('an id-scoped safety link opens the safety screen with the alert id',
      (tester) async {
    final api = _FakeNotificationsApi(<dynamic>[_row(deepLink: 'abny://safety/$_uuid')]);
    await _pumpInbox(tester, api: api);

    await tester.tap(find.text('إشعار'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final safety = tester.widget<SafetyScreen>(find.byType(SafetyScreen));
    expect(safety.alertId, _uuid);
  });

  testWidgets('a safety link whose alert is not in the feed degrades, never crashes',
      (tester) async {
    // An alert that has scrolled past the server's 100-row window, or an id
    // from a table this screen does not read. The screen must say so and still
    // show what it has — never a blank page and never an exception.
    final api = _FakeNotificationsApi(<dynamic>[_row(deepLink: 'abny://safety/$_uuid')]);
    await _pumpInbox(tester, api: api, safety: _FakeSafetyRepository());

    await tester.tap(find.text('إشعار'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.byType(SafetyScreen), findsOneWidget);
  });

  testWidgets('a child link opens the child page with the id off the link',
      (tester) async {
    final api = _FakeNotificationsApi(<dynamic>[_row(deepLink: 'abny://child/$_uuid')]);
    // The child page will ask for the child; leaving it pending keeps it in its
    // loading state, which is all this test needs it to reach.
    final children = FakeChildProfileRepository(
      onGetChild: () => pending<ChildProfile>(),
    );
    await _pumpInbox(tester, api: api, children: children);

    await tester.tap(find.text('إشعار'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    final child = tester.widget<ChildDetailScreen>(find.byType(ChildDetailScreen));
    expect(child.childId, _uuid);
    expect(children.requestedChildIds, <String>[_uuid]);
  });

  testWidgets('a child link whose id is not an id never reaches a screen at all',
      (tester) async {
    // `parseDeepLink` rejects the shape before the router ever sees it, so this
    // is the inbox — not a child page asking the API for garbage.
    final api = _FakeNotificationsApi(<dynamic>[
      _row(deepLink: 'abny://child/not an id'),
    ]);
    final children = FakeChildProfileRepository();
    await _pumpInbox(tester, api: api, children: children);

    await tester.tap(find.text('إشعار'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(tester.takeException(), isNull);
    expect(find.byType(ChildDetailScreen), findsNothing);
    expect(find.byType(NotificationsScreen), findsOneWidget);
    // Nothing was asked of the server on behalf of an id we could not read.
    expect(children.requestedChildIds, isEmpty);
  });

  testWidgets('a destination with no screen leaves the parent in the inbox, and says so',
      (tester) async {
    // `progress` is a REAL server destination (`REWARD_GRANTED` resolves to it)
    // whose parent screen cannot be built from a link — see DeepLinkRouter's
    // header. It must be honest, not silent.
    final api = _FakeNotificationsApi(<dynamic>[_row(deepLink: 'abny://progress')]);
    await _pumpInbox(tester, api: api);

    await tester.tap(find.text('إشعار'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(NotificationsScreen), findsOneWidget);
    expect(find.text(ar('deepLink.unavailable')), findsOneWidget);
    // Still marked read: the parent has seen it, whatever the tap could open.
    expect(api.markedRead, <String>['n_1']);
  });

  testWidgets('a row with no link at all falls back to the inbox without throwing',
      (tester) async {
    final api = _FakeNotificationsApi(<dynamic>[_row()]);
    await _pumpInbox(tester, api: api);

    await tester.tap(find.text('إشعار'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    // The inbox destination while already ON the inbox is a no-op, by design:
    // pushing a second copy of this screen onto itself is how a back button
    // stops working. No exception, no navigation, no snackbar.
    expect(find.byType(NotificationsScreen), findsOneWidget);
    expect(find.text(ar('deepLink.unavailable')), findsNothing);
    expect(api.markedRead, <String>['n_1']);
  });

  testWidgets('a malformed link cannot crash the tap', (tester) async {
    final api = _FakeNotificationsApi(<dynamic>[
      _row(deepLink: 'https://evil.example/steal'),
    ]);
    await _pumpInbox(tester, api: api);

    await tester.tap(find.text('إشعار'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(tester.takeException(), isNull);
    expect(find.byType(NotificationsScreen), findsOneWidget);
  });
}
