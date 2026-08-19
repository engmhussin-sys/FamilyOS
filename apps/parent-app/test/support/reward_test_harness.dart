// TEST SUPPORT for the F4 reward journey screens.
//
// WHY A HAND-WRITTEN FAKE AND NOT `mockito`'s CODEGEN.
// `mockito` is already a dev dependency, but `@GenerateMocks` requires
// `dart run build_runner build`, which requires `pub get`, which requires
// pub.dev — and pub.dev answers 403 to CONNECT from the environment these
// tests were authored in. A generated file that cannot be generated is a
// file that rots. `implements` + `noSuchMethod` is the same pattern mockito
// itself is built on, needs no codegen, and works on any machine.
//
// The fake is DELIBERATELY strict: any repository method a test did not stub
// throws with the method's name in the message, so a screen that starts
// calling a new endpoint fails loudly here instead of silently rendering a
// spinner forever.
//
// HONEST LIMITATION: none of these tests has ever been executed. There is no
// Flutter SDK reachable from the authoring environment (`which flutter` finds
// nothing; the SDK archive host 403s). They are STATIC VERIFIED only — their
// constructor arity, named parameters, member references and imports are
// checked by `scripts/dart_preflight.py`, which is not a Dart analyser and
// does not run code. The first execution happens on a GitHub runner.

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
import 'package:parent_app/core/theme/app_theme.dart';
import 'package:parent_app/features/rewards/data/reward_programs_repository.dart';
import 'package:parent_app/features/rewards/domain/achievement.dart';
import 'package:parent_app/features/rewards/domain/fulfilment.dart';
import 'package:parent_app/features/rewards/domain/reward_program.dart';
import 'package:parent_app/features/screen_time/domain/screen_time_policy.dart';

import 'screen_time_test_harness.dart' show FakeScreenTimeRepository;

/// A repository whose every method is a slot a test fills in.
///
/// `Future<T> Function()?` rather than a value, so a test can hand back a
/// never-completing future and assert the LOADING state — the state this
/// codebase most often got wrong before [UiState] existed (audit PA-M-044).
class FakeRewardProgramsRepository implements RewardProgramsRepository {
  FakeRewardProgramsRepository({
    this.onListPrograms,
    this.onGetProgram,
    this.onListPendingAchievements,
    this.onListAttempts,
    this.onGetAchievementDetail,
    this.onListFulfilments,
    this.onListSuggestions,
    this.onLoadAccount,
    this.onListScreenTimeGrants,
    this.onListAchievementsForChild,
    this.onGetStreaks,
  });

  final Future<List<RewardProgram>> Function()? onListPrograms;
  final Future<RewardProgram> Function()? onGetProgram;
  final Future<List<AchievementRequest>> Function()? onListPendingAchievements;
  final Future<List<VerificationAttempt>> Function()? onListAttempts;
  final Future<AchievementDetail> Function()? onGetAchievementDetail;
  final Future<List<RewardFulfilment>> Function()? onListFulfilments;
  final Future<List<ProgramSuggestion>> Function()? onListSuggestions;
  final Future<RewardsAccount> Function()? onLoadAccount;
  final Future<List<ScreenTimeGrant>> Function()? onListScreenTimeGrants;
  final Future<List<AchievementRequest>> Function()? onListAchievementsForChild;
  final Future<Map<String, int>> Function()? onGetStreaks;

  @override
  Future<List<RewardProgram>> listPrograms({String? childId}) =>
      _need(onListPrograms, 'listPrograms');

  @override
  Future<RewardProgram> getProgram(String programId) =>
      _need(onGetProgram, 'getProgram');

  @override
  Future<List<AchievementRequest>> listPendingAchievements() =>
      _need(onListPendingAchievements, 'listPendingAchievements');

  @override
  Future<List<VerificationAttempt>> listAttempts(String achievementId) =>
      _need(onListAttempts, 'listAttempts');

  @override
  Future<AchievementDetail> getAchievementDetail(String achievementId) =>
      _need(onGetAchievementDetail, 'getAchievementDetail');

  @override
  Future<List<RewardFulfilment>> listFulfilments({String? status}) =>
      _need(onListFulfilments, 'listFulfilments');

  @override
  Future<List<ProgramSuggestion>> listSuggestions(String childId) =>
      _need(onListSuggestions, 'listSuggestions');

  @override
  Future<RewardsAccount> loadAccount(String childId) =>
      _need(onLoadAccount, 'loadAccount');

  @override
  Future<List<ScreenTimeGrant>> listScreenTimeGrants(String childId) =>
      _need(onListScreenTimeGrants, 'listScreenTimeGrants');

  @override
  Future<List<AchievementRequest>> listAchievementsForChild(String childId) =>
      _need(onListAchievementsForChild, 'listAchievementsForChild');

  @override
  Future<Map<String, int>> getStreaks(String childId) =>
      _need(onGetStreaks, 'getStreaks');

  Future<T> _need<T>(Future<T> Function()? slot, String name) {
    if (slot == null) {
      throw StateError(
        'FakeRewardProgramsRepository.$name was called but this test did not '
        'stub it. Either stub it, or the screen under test is calling an '
        'endpoint it should not.',
      );
    }
    return slot();
  }

  /// Everything not listed above. Throwing by name is the point: a silent
  /// `null` here would show up three layers away as an empty screen.
  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        'FakeRewardProgramsRepository has no stub for '
        '${invocation.memberName} — add one to the harness.',
      );
}

// ---------------------------------------------------------------------------
// Canned outcomes, named for what they mean rather than how they are built.
// ---------------------------------------------------------------------------

/// A future that never completes — the screen stays in its LOADING state.
Future<T> pending<T>() => Completer<T>().future;

/// The server said no, in Arabic, with a request id — which is the whole
/// reason `DsErrorState` exists (B3 error envelope).
Future<T> failing<T>({
  String message = 'Upstream refused',
  String messageAr = 'حدث خطأ غير متوقع',
  String code = 'INTERNAL_ERROR',
  String requestId = 'req_test_0001',
}) =>
    Future<T>.error(ApiFailure(
      message: message,
      messageAr: messageAr,
      code: code,
      statusCode: 500,
      requestId: requestId,
    ));

const ApiFailure testFailure = ApiFailure(
  message: 'Upstream refused',
  messageAr: 'حدث خطأ غير متوقع',
  code: 'INTERNAL_ERROR',
  statusCode: 500,
  requestId: 'req_test_0001',
);

// ---------------------------------------------------------------------------
// Domain fixtures. Minimal but VALID — every required field supplied, so the
// preflight's CTOR-REQUIRED check keeps them honest as the models change.
// ---------------------------------------------------------------------------

RewardProgram testProgram({
  String id = 'prog_1',
  String status = 'ACTIVE',
  String targetSummaryAr = 'حفظ سورة الفاتحة',
  String? childId = 'child_1',
}) =>
    RewardProgram(
      id: id,
      childId: childId,
      category: 'FAITH',
      activity: 'QURAN_MEMORIZE_SURAH',
      targetSummaryAr: targetSummaryAr,
      durationMinutes: 15,
      verificationLevel: 'PARENT',
      rewardSpec: const RewardSpec(type: 'POINTS', amount: 50),
      status: status,
      frequency: 'DAILY',
      maxPerDay: 1,
      maxPerWeek: 5,
      requiresParentApproval: true,
    );

AchievementRequest testAchievement({
  String id = 'ach_1',
  String programId = 'prog_1',
  String status = 'SUBMITTED',
}) =>
    AchievementRequest(
      id: id,
      programId: programId,
      childId: 'child_1',
      status: status,
      attemptNo: 1,
    );

RewardFulfilment testFulfilment({
  String id = 'ful_1',
  String status = 'PENDING',
}) =>
    RewardFulfilment(
      id: id,
      childId: 'child_1',
      rewardType: 'PHYSICAL',
      description: 'دفتر جديد',
      quantity: 1,
      status: status,
    );

/// One row of the child's grant HISTORY, exactly as
/// `GET /reward-programs/screen-time-grants/:childId` returns it — that route
/// filters nothing, so revoked and long-expired rows arrive here too. Whether
/// a row is live is not this fixture's business and not the screen's: it is
/// the server's, via the effective-policy response.
ScreenTimeGrant testGrant({
  String id = 'grant_1',
  int minutes = 15,
  DateTime? expiresAt,
  DateTime? revokedAt,
}) =>
    ScreenTimeGrant(
      id: id,
      childId: 'child_1',
      minutes: minutes,
      grantedAt: DateTime.utc(2026, 1, 1, 9),
      expiresAt: expiresAt,
      revokedAt: revokedAt,
    );

ProgramSuggestion testSuggestion({String id = 'sug_1'}) => ProgramSuggestion(
      suggestionId: id,
      previewAr: 'قراءة عشر صفحات كل يوم',
      rationaleAr: 'لأن القراءة اليومية أثبتت أثرًا على التحصيل',
    );

// ---------------------------------------------------------------------------
// The pump helper.
// ---------------------------------------------------------------------------

/// Builds [screen] inside the same MaterialApp shape `main.dart` uses — same
/// theme, same delegates, same Arabic-first `supportedLocales` — because a
/// screen that only renders under a bespoke test wrapper has not been tested.
///
/// [locale] defaults to Arabic: it is the product's first language
/// (CONTEXT §1), so it is the default the tests assert against.
/// The effective policy every reward-screen test gets unless it says
/// otherwise: no bonus at all, no live grants. `ChildRewardsScreen` reads the
/// SERVER's bonus total from this route rather than re-summing the grant rows
/// it lists, so a screen test has to supply it — and a default of «nothing
/// earned» keeps the other screens' assertions unchanged.
EffectiveScreenTimePolicy noBonus() => const EffectiveScreenTimePolicy(
      baseDailyLimitMinutes: 120,
      effectiveDailyLimitMinutes: 120,
      bonusMinutes: 0,
      bonusGrants: <ScreenTimeBonusGrant>[],
    );

/// The server's answer to «how many bonus minutes does this child hold right
/// now», with the ids it counts as live. [ChildRewardsScreen] must render
/// [bonusMinutes] verbatim; deriving it from the grant list is the defect this
/// argument exists to catch.
EffectiveScreenTimePolicy serverBonus({
  required int bonusMinutes,
  List<String> activeGrantIds = const [],
}) =>
    EffectiveScreenTimePolicy(
      baseDailyLimitMinutes: 120,
      effectiveDailyLimitMinutes: 120 + bonusMinutes,
      bonusMinutes: bonusMinutes,
      bonusGrants: [
        for (final id in activeGrantIds)
          ScreenTimeBonusGrant(id: id, minutes: bonusMinutes),
      ],
    );

Future<void> pumpRewardScreen(
  WidgetTester tester,
  Widget screen, {
  required FakeRewardProgramsRepository repository,
  AppLocale locale = AppLocale.ar,
  Future<EffectiveScreenTimePolicy> Function()? onEffectivePolicy,
  List<Override> extraOverrides = const [],
}) async {
  // No network in `flutter test`. Without this, google_fonts attempts an HTTP
  // fetch per font, logs a failure and falls back — noise that makes a real
  // failure harder to see.
  GoogleFonts.config.allowRuntimeFetching = false;

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        rewardProgramsRepositoryProvider.overrideWithValue(repository),
        screenTimeRepositoryProvider.overrideWithValue(
          FakeScreenTimeRepository(
            onGetEffectivePolicy:
                onEffectivePolicy ?? () async => noBonus(),
          ),
        ),
        // InMemoryLocaleStorage exists in locale_controller.dart precisely so
        // a widget test never has to fake the SharedPreferences channel.
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
  // One frame for the widget tree, one for LocaleController's async restore
  // and the controller's own `load()`. NOT pumpAndSettle: the loading state
  // contains an indeterminate CircularProgressIndicator, whose animation
  // never settles, and asserting the loading state is half the point here.
  await tester.pump();
}

/// The Arabic string [key] resolves to, so an assertion names the KEY and the
/// test does not have to hard-code a sentence that a copy change will break.
String ar(String key, {int? count, Map<String, Object>? options}) =>
    translate(AppLocale.ar, key, count: count, options: options);

String en(String key, {int? count, Map<String, Object>? options}) =>
    translate(AppLocale.en, key, count: count, options: options);
