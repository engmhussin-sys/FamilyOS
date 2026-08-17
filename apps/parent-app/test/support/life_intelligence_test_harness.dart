// TEST SUPPORT for the ten Life Intelligence screens.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter or Dart SDK reachable
// from the environment these were authored in — `pub.dev`, `dl.google.com`
// and `storage.googleapis.com` all answer 403 to CONNECT, so the SDK cannot
// be installed and `flutter test` cannot be invoked. Every file in this
// directory is STATIC VERIFIED ONLY: `scripts/dart_preflight.py` checked
// constructor arity, named parameters, member references and import scope,
// which is not a Dart analyser and executes nothing. The first execution of
// these tests happens on a GitHub runner.
//
// WHY A HAND-WRITTEN FAKE AND NOT `mockito`'s CODEGEN — same reason as
// `reward_test_harness.dart`, whose conventions this file follows exactly:
// `@GenerateMocks` needs `build_runner`, which needs `pub get`, which needs
// pub.dev. `implements` + `noSuchMethod` needs none of them.
//
// The fake is strict on purpose: an unstubbed method throws with its own
// name in the message, so a screen that starts calling a new endpoint fails
// loudly here rather than rendering a spinner forever.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:parent_app/core/di/providers.dart';
import 'package:parent_app/core/errors/api_failure.dart';
import 'package:parent_app/core/localization/locale_controller.dart';
import 'package:parent_app/core/localization/localization_engine.dart';
import 'package:parent_app/core/network/api_exception.dart';
import 'package:parent_app/core/theme/app_theme.dart';
import 'package:parent_app/features/life_intelligence/api/life_intelligence_api.dart';
import 'package:parent_app/features/life_intelligence/data/life_intelligence_repository.dart';

/// A repository whose every method is a slot a test fills in.
///
/// `Future<T> Function()?` rather than a value, so a test can hand back a
/// never-completing future and assert the LOADING state.
class FakeLifeIntelligenceRepository implements LifeIntelligenceRepository {
  FakeLifeIntelligenceRepository({
    this.onGetCoachingRecommendations,
    this.onGetDigitalTwin,
    this.onGetHabits,
    this.onCompleteHabit,
    this.onGetFaithPractices,
    this.onGetHealthScore,
    this.onGetFamilyStore,
    this.onGetTimeline,
    this.onGetLearningProgress,
    this.onGetWellbeingSnapshot,
    this.onGetWellbeingInsight,
    this.onGetPendingMessages,
    this.onApproveMessage,
    this.onRejectMessage,
  });

  final Future<List<dynamic>> Function()? onGetCoachingRecommendations;
  final Future<Map<String, dynamic>> Function()? onGetDigitalTwin;
  final Future<List<dynamic>> Function()? onGetHabits;
  final Future<void> Function()? onCompleteHabit;
  final Future<List<dynamic>> Function()? onGetFaithPractices;
  final Future<Map<String, dynamic>> Function()? onGetHealthScore;
  final Future<List<dynamic>> Function()? onGetFamilyStore;
  final Future<List<dynamic>> Function()? onGetTimeline;
  final Future<Map<String, dynamic>> Function()? onGetLearningProgress;
  final Future<Map<String, dynamic>?> Function()? onGetWellbeingSnapshot;
  final Future<Map<String, dynamic>?> Function()? onGetWellbeingInsight;
  final Future<List<dynamic>> Function()? onGetPendingMessages;
  final Future<void> Function()? onApproveMessage;
  final Future<void> Function()? onRejectMessage;

  @override
  Future<List<dynamic>> getCoachingRecommendations(String childId) =>
      _need(onGetCoachingRecommendations, 'getCoachingRecommendations');

  @override
  Future<Map<String, dynamic>> getDigitalTwin(String childId) =>
      _need(onGetDigitalTwin, 'getDigitalTwin');

  @override
  Future<List<dynamic>> getHabits(String childId) => _need(onGetHabits, 'getHabits');

  @override
  Future<void> completeHabit(String childId, String habitId) =>
      _need(onCompleteHabit, 'completeHabit');

  @override
  Future<List<dynamic>> getFaithPractices(String childId) =>
      _need(onGetFaithPractices, 'getFaithPractices');

  @override
  Future<Map<String, dynamic>> getHealthScore(String childId) =>
      _need(onGetHealthScore, 'getHealthScore');

  @override
  Future<List<dynamic>> getFamilyStore(String familyId) =>
      _need(onGetFamilyStore, 'getFamilyStore');

  @override
  Future<List<dynamic>> getTimeline(String childId, {String? category}) =>
      _need(onGetTimeline, 'getTimeline');

  @override
  Future<Map<String, dynamic>> getLearningProgress(String childId) =>
      _need(onGetLearningProgress, 'getLearningProgress');

  @override
  Future<Map<String, dynamic>?> getWellbeingSnapshot(String childId) =>
      _need(onGetWellbeingSnapshot, 'getWellbeingSnapshot');

  @override
  Future<Map<String, dynamic>?> getWellbeingInsight(String childId, {String? date}) =>
      _need(onGetWellbeingInsight, 'getWellbeingInsight');

  @override
  Future<List<dynamic>> getPendingMessages() =>
      _need(onGetPendingMessages, 'getPendingMessages');

  @override
  Future<void> approveMessage(String childId, String messageId) =>
      _need(onApproveMessage, 'approveMessage');

  @override
  Future<void> rejectMessage(String childId, String messageId) =>
      _need(onRejectMessage, 'rejectMessage');

  Future<T> _need<T>(Future<T> Function()? slot, String name) {
    if (slot == null) {
      throw StateError(
        'FakeLifeIntelligenceRepository.$name was called but this test did '
        'not stub it. Either stub it, or the screen under test is calling an '
        'endpoint it should not.',
      );
    }
    return slot();
  }

  /// Everything not listed above. Throwing by name is the point: a silent
  /// `null` here would surface three layers away as an empty screen.
  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        'FakeLifeIntelligenceRepository has no stub for '
        '${invocation.memberName} — add one to the harness.',
      );
}

/// The API layer, for testing the repository ITSELF rather than a screen.
/// Only the methods a repository test drives are stubbed.
class FakeLifeIntelligenceApi implements LifeIntelligenceApi {
  FakeLifeIntelligenceApi({this.onGetHabits, this.onCompleteHabit});

  final Future<List<dynamic>> Function()? onGetHabits;
  final Future<void> Function()? onCompleteHabit;

  @override
  Future<List<dynamic>> getHabits(String childId) {
    final slot = onGetHabits;
    if (slot == null) throw StateError('FakeLifeIntelligenceApi.getHabits not stubbed.');
    return slot();
  }

  @override
  Future<void> completeHabit(String childId, String habitId) {
    final slot = onCompleteHabit;
    if (slot == null) throw StateError('FakeLifeIntelligenceApi.completeHabit not stubbed.');
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        'FakeLifeIntelligenceApi has no stub for ${invocation.memberName}.',
      );
}

// ---------------------------------------------------------------------------
// Canned outcomes, named for what they mean rather than how they are built.
// ---------------------------------------------------------------------------

/// A future that never completes — the screen stays in its LOADING state.
Future<T> pending<T>() => Completer<T>().future;

/// THE GOOD CASE FOR ERROR HANDLING: the backend refused in Arabic, through
/// the B3 envelope, with a request id. This is the failure whose sentence
/// must reach the screen word for word.
const ApiFailure envelopeFailure = ApiFailure(
  message: 'This program has already been completed the maximum number of times today.',
  messageAr: 'أكملت هذا البرنامج مرتين اليوم — نراك غدًا!',
  code: 'MAX_PER_DAY_REACHED',
  statusCode: 409,
  requestId: 'req_test_envelope_1',
  diagnostic: 'This program has already been completed the maximum number of times today.',
);

/// THE HARD CASE: a proxy answered with an HTML page, so nothing in the
/// response is a B3 envelope and the only text available is Dio's own.
///
/// Built by running the REAL conversion over the REAL shape
/// `ApiClient._fromErrorEnvelope` produces for a non-Map body, rather than
/// by hand — a hand-built `ApiFailure` would test the test, not the code.
ApiFailure proxyFailure() => ApiFailure.from(
      ApiException(
        'The request returned an invalid status code of 502.',
        statusCode: 502,
      ),
    );

/// THE OTHER HARD CASE: the socket went away mid-request, so there is no
/// response at all. `ApiClient` classifies this before the envelope parser
/// ever runs.
ApiFailure droppedSocketFailure() => ApiFailure.from(
      ApiException(
        'Connection closed before full header was received',
        code: 'CLIENT_OFFLINE',
      ),
    );

/// Fails a stubbed call with [failure].
Future<T> failingWith<T>(ApiFailure failure) => Future<T>.error(failure);

// ---------------------------------------------------------------------------
// The pump helper.
// ---------------------------------------------------------------------------

/// Builds [screen] inside the same MaterialApp shape `main.dart` uses — same
/// theme, same delegates, same Arabic-first `supportedLocales`.
///
/// [locale] defaults to Arabic: it is the product's first language, so it is
/// the default these tests assert against.
Future<void> pumpLifeScreen(
  WidgetTester tester,
  Widget screen, {
  required FakeLifeIntelligenceRepository repository,
  AppLocale locale = AppLocale.ar,
  List<Override> extraOverrides = const [],
}) async {
  // No network in `flutter test`. Without this, google_fonts attempts an
  // HTTP fetch per font and logs a failure — noise that hides a real one.
  GoogleFonts.config.allowRuntimeFetching = false;

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        lifeIntelligenceRepositoryProvider.overrideWithValue(repository),
        localeControllerProvider.overrideWith(
          (ref) => LocaleController(storage: InMemoryLocaleStorage(locale)),
        ),
        ...extraOverrides,
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        locale: locale == AppLocale.ar ? const Locale('ar') : const Locale('en'),
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: const [Locale('ar'), Locale('en')],
        home: screen,
      ),
    ),
  );
  // One frame for the tree, one for LocaleController's async restore and the
  // screen's own `_load()`. NOT pumpAndSettle: the loading state holds an
  // indeterminate CircularProgressIndicator whose animation never settles.
  await tester.pump();
}

/// The Arabic string [key] resolves to, so an assertion names the KEY and no
/// test hard-codes a sentence that a copy change would break.
String ar(String key, {int? count, Map<String, Object>? options}) =>
    translate(AppLocale.ar, key, count: count, options: options);

String en(String key, {int? count, Map<String, Object>? options}) =>
    translate(AppLocale.en, key, count: count, options: options);
