// TEST SUPPORT for the last four Parent App screens that showed a parent
// raw exception text: delete account, redeem code, contact support, create
// child, and manage consents.
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
// WHY HAND-WRITTEN FAKES AND NOT `mockito`'s CODEGEN — same reason as
// `life_intelligence_test_harness.dart`, whose conventions this file follows
// exactly: `@GenerateMocks` needs `build_runner`, which needs `pub get`,
// which needs pub.dev. `implements` + `noSuchMethod` needs none of them.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:parent_app/core/errors/api_failure.dart';
import 'package:parent_app/core/localization/locale_controller.dart';
import 'package:parent_app/core/localization/localization_engine.dart';
import 'package:parent_app/core/network/api_exception.dart';
import 'package:parent_app/core/theme/app_theme.dart';
import 'package:parent_app/features/billing/api/campaign_api.dart';
import 'package:parent_app/features/billing/data/campaign_repository.dart';
import 'package:parent_app/features/dashboard/api/dashboard_api.dart';
import 'package:parent_app/features/family/api/consent_api.dart';
import 'package:parent_app/features/family/data/child_profile_repository.dart';
import 'package:parent_app/features/pairing/api/pairing_api.dart';
import 'package:parent_app/features/settings/api/account_api.dart';
import 'package:parent_app/features/settings/data/account_repository.dart';
import 'package:parent_app/features/support/api/support_api.dart';
import 'package:parent_app/features/support/data/support_repository.dart';

// ---------------------------------------------------------------------------
// API-level fakes, for testing the REPOSITORIES themselves.
// ---------------------------------------------------------------------------

class FakeAccountApi implements AccountApi {
  FakeAccountApi({this.onDeleteAccount});

  final Future<void> Function()? onDeleteAccount;

  /// What the screen actually typed, so a test can prove the password was
  /// not mangled on its way through the new boundary.
  String? lastPassword;

  @override
  Future<void> deleteAccount(String currentPassword) {
    lastPassword = currentPassword;
    final slot = onDeleteAccount;
    if (slot == null) throw StateError('FakeAccountApi.deleteAccount not stubbed.');
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('FakeAccountApi has no stub for ${invocation.memberName}.');
}

class FakeCampaignApi implements CampaignApi {
  FakeCampaignApi({this.onRedeemCode});

  final Future<Map<String, dynamic>> Function()? onRedeemCode;
  String? lastCode;

  @override
  Future<Map<String, dynamic>> redeemCode(String code) {
    lastCode = code;
    final slot = onRedeemCode;
    if (slot == null) throw StateError('FakeCampaignApi.redeemCode not stubbed.');
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('FakeCampaignApi has no stub for ${invocation.memberName}.');
}

class FakeSupportApi implements SupportApi {
  FakeSupportApi({this.onSubmitRequest});

  final Future<void> Function()? onSubmitRequest;

  @override
  Future<void> submitRequest({
    required String email,
    required String subject,
    required String message,
    String? familyId,
    String? userId,
  }) {
    final slot = onSubmitRequest;
    if (slot == null) throw StateError('FakeSupportApi.submitRequest not stubbed.');
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('FakeSupportApi has no stub for ${invocation.memberName}.');
}

class FakeDashboardApi implements DashboardApi {
  FakeDashboardApi({this.onCreateChild, this.onGetChildren});

  final Future<Map<String, dynamic>> Function()? onCreateChild;
  final Future<List<dynamic>> Function()? onGetChildren;

  @override
  Future<Map<String, dynamic>> createChild({
    required String firstName,
    required String dateOfBirth,
    String? lastName,
  }) {
    final slot = onCreateChild;
    if (slot == null) throw StateError('FakeDashboardApi.createChild not stubbed.');
    return slot();
  }

  @override
  Future<List<dynamic>> getChildren() {
    final slot = onGetChildren;
    if (slot == null) throw StateError('FakeDashboardApi.getChildren not stubbed.');
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('FakeDashboardApi has no stub for ${invocation.memberName}.');
}

class FakePairingApi implements PairingApi {
  FakePairingApi({this.onGrantDefaultConsents});

  final Future<void> Function()? onGrantDefaultConsents;
  int grantCalls = 0;

  @override
  Future<void> grantDefaultConsents(String childId) {
    grantCalls++;
    final slot = onGrantDefaultConsents;
    if (slot == null) return Future<void>.value();
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('FakePairingApi has no stub for ${invocation.memberName}.');
}

class FakeConsentApi implements ConsentApi {
  FakeConsentApi({this.onListConsents, this.onSetConsent});

  final Future<List<dynamic>> Function()? onListConsents;
  final Future<void> Function()? onSetConsent;

  @override
  Future<List<dynamic>> listConsents(String childId) {
    final slot = onListConsents;
    if (slot == null) throw StateError('FakeConsentApi.listConsents not stubbed.');
    return slot();
  }

  @override
  Future<void> setConsent(String childId, String consentType, bool granted) {
    final slot = onSetConsent;
    if (slot == null) return Future<void>.value();
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('FakeConsentApi has no stub for ${invocation.memberName}.');
}

// ---------------------------------------------------------------------------
// Repository-level fakes, for testing the SCREENS.
// ---------------------------------------------------------------------------

class FakeAccountRepository implements AccountRepository {
  FakeAccountRepository({this.onDeleteAccount});

  final Future<void> Function()? onDeleteAccount;
  int deleteCalls = 0;

  @override
  Future<void> deleteAccount(String currentPassword) {
    deleteCalls++;
    final slot = onDeleteAccount;
    if (slot == null) throw StateError('FakeAccountRepository.deleteAccount not stubbed.');
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('FakeAccountRepository has no stub for ${invocation.memberName}.');
}

class FakeCampaignRepository implements CampaignRepository {
  FakeCampaignRepository({this.onRedeemCode});

  final Future<CampaignRedemption> Function()? onRedeemCode;

  @override
  Future<CampaignRedemption> redeemCode(String code) {
    final slot = onRedeemCode;
    if (slot == null) throw StateError('FakeCampaignRepository.redeemCode not stubbed.');
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('FakeCampaignRepository has no stub for ${invocation.memberName}.');
}

class FakeSupportRepository implements SupportRepository {
  FakeSupportRepository({this.onSubmitRequest});

  final Future<void> Function()? onSubmitRequest;

  @override
  Future<void> submitRequest({
    required String email,
    required String subject,
    required String message,
    String? familyId,
    String? userId,
  }) {
    final slot = onSubmitRequest;
    if (slot == null) throw StateError('FakeSupportRepository.submitRequest not stubbed.');
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('FakeSupportRepository has no stub for ${invocation.memberName}.');
}

class FakeChildProfileRepository implements ChildProfileRepository {
  FakeChildProfileRepository({
    this.onCreateChild,
    this.onGrantDefaultConsents,
    this.onListChildren,
    this.onListConsents,
    this.onSetConsent,
  });

  final Future<String> Function()? onCreateChild;
  final Future<void> Function()? onGrantDefaultConsents;
  final Future<List<ChildSummary>> Function()? onListChildren;
  final Future<List<ChildConsent>> Function()? onListConsents;
  final Future<void> Function()? onSetConsent;

  int grantCalls = 0;

  @override
  Future<String> createChild({
    required String firstName,
    required String dateOfBirth,
    String? lastName,
  }) =>
      _need(onCreateChild, 'createChild');

  @override
  Future<void> grantDefaultConsents(String childId) {
    grantCalls++;
    final slot = onGrantDefaultConsents;
    if (slot == null) return Future<void>.value();
    return slot();
  }

  @override
  Future<List<ChildSummary>> listChildren() => _need(onListChildren, 'listChildren');

  @override
  Future<List<ChildConsent>> listConsents(String childId) =>
      _need(onListConsents, 'listConsents');

  @override
  Future<void> setConsent(String childId, String consentType, bool granted) {
    final slot = onSetConsent;
    if (slot == null) return Future<void>.value();
    return slot();
  }

  Future<T> _need<T>(Future<T> Function()? slot, String name) {
    if (slot == null) {
      throw StateError(
        'FakeChildProfileRepository.$name was called but this test did not '
        'stub it. Either stub it, or the screen under test is calling an '
        'endpoint it should not.',
      );
    }
    return slot();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        'FakeChildProfileRepository has no stub for ${invocation.memberName}.',
      );
}

// ---------------------------------------------------------------------------
// Canned outcomes, named for what they mean rather than how they are built.
// ---------------------------------------------------------------------------

/// A future that never completes — the screen stays in its submitting state.
Future<T> pending<T>() => Completer<T>().future;

/// THE SERVER ANSWERED AND SAID NO. A 4xx through the B3 filter, which is
/// what `isServerRefusal` is true for and what licenses a screen to state
/// what did not happen as a fact.
ApiFailure refusalFailure({
  int statusCode = 400,
  String messageAr = 'كلمة السر غير صحيحة.',
  String code = 'BAD_REQUEST',
}) =>
    ApiFailure.from(ApiException(
      'The request could not be accepted as sent.',
      messageAr: messageAr,
      code: code,
      statusCode: statusCode,
      requestId: 'req_refusal_1',
    ));

/// THE SERVER NEVER ANSWERED. A proxy's HTML page, so nothing in the
/// response is a B3 envelope and the only text available is Dio's own —
/// «The request returned an invalid status code of 502». Built by running
/// the REAL conversion over the REAL shape rather than by hand, so this
/// tests the code and not the test.
ApiFailure proxyFailure() => ApiFailure.from(ApiException(
      'The request returned an invalid status code of 502.',
      statusCode: 502,
    ));

/// The throttle answered. Says nothing about whether what was submitted is
/// valid — which is the whole reason the redeem screen separates it out.
ApiFailure rateLimitFailure() => ApiFailure.from(ApiException(
      'Too many requests. Please wait a moment and try again.',
      messageAr: 'عدد المحاولات كبير الآن. انتظر قليلًا ثم أعد المحاولة.',
      code: 'RATE_LIMITED',
      statusCode: 429,
    ));

Future<T> failingWith<T>(ApiFailure failure) => Future<T>.error(failure);

// ---------------------------------------------------------------------------
// The pump helper.
// ---------------------------------------------------------------------------

/// Builds [screen] inside the same MaterialApp shape `main.dart` uses.
/// [locale] defaults to Arabic — the product's first language.
Future<void> pumpParentScreen(
  WidgetTester tester,
  Widget screen, {
  required List<Override> overrides,
  AppLocale locale = AppLocale.ar,
}) async {
  // No network in `flutter test`. Without this, google_fonts attempts an
  // HTTP fetch per font and logs a failure — noise that hides a real one.
  GoogleFonts.config.allowRuntimeFetching = false;

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        localeControllerProvider.overrideWith(
          (ref) => LocaleController(storage: InMemoryLocaleStorage(locale)),
        ),
        ...overrides,
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
  await tester.pump();
}

/// The Arabic string [key] resolves to, so an assertion names the KEY and no
/// test hard-codes a sentence that a copy change would break.
String ar(String key) => translate(AppLocale.ar, key);
