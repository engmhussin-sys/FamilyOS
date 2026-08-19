// TEST SUPPORT for the parent's screen-time surface.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK and no Dart SDK
// reachable from the environment this was authored in (`which flutter dart`
// finds nothing; `pub.dev`, `dl.google.com` and `storage.googleapis.com` all
// answer 403 to CONNECT), so `flutter test` cannot be invoked here. Every file
// in this directory is STATIC VERIFIED ONLY, by `scripts/dart_preflight.py` —
// constructor arity, named parameters, member references, import scope — which
// is not a Dart analyser and executes nothing. First execution is on a CI
// runner.
//
// WHY A HAND-WRITTEN FAKE AND NOT `mockito`'s CODEGEN — the same reason
// `reward_test_harness.dart` gives, whose conventions this file follows
// exactly: `@GenerateMocks` needs `build_runner`, which needs `pub get`, which
// needs pub.dev. `implements` + `noSuchMethod` needs none of them and is the
// pattern mockito itself is built on.
//
// The fake is DELIBERATELY STRICT: any repository method a test did not stub
// throws with the method's own name in the message, so a screen that starts
// calling a new endpoint fails loudly here instead of silently rendering a
// spinner forever.

import 'dart:async';

import 'package:parent_app/core/errors/api_failure.dart';
import 'package:parent_app/core/localization/localization_engine.dart';
import 'package:parent_app/features/screen_time/data/screen_time_repository.dart';
import 'package:parent_app/features/screen_time/domain/app_block_rule.dart';
import 'package:parent_app/features/screen_time/domain/screen_time_policy.dart';

/// A repository whose every method is a slot a test fills in.
///
/// `Future<T> Function()?` rather than a value, so a test can hand back a
/// never-completing future and assert the LOADING state — the state this
/// codebase most often got wrong before [UiState] existed (audit PA-M-044).
class FakeScreenTimeRepository implements ScreenTimeRepository {
  FakeScreenTimeRepository({
    this.onGetPolicy,
    this.onGetEffectivePolicy,
    this.onSetPolicy,
    this.onListAppBlockRules,
    this.onBlockPackage,
    this.onDeactivateAppBlockRule,
    this.onListChildApps,
  });

  final Future<ScreenTimePolicy?> Function()? onGetPolicy;
  final Future<EffectiveScreenTimePolicy> Function()? onGetEffectivePolicy;
  final Future<ScreenTimePolicy?> Function()? onSetPolicy;
  final Future<List<AppBlockRule>> Function()? onListAppBlockRules;
  final Future<AppBlockRule> Function()? onBlockPackage;
  final Future<void> Function()? onDeactivateAppBlockRule;
  final Future<List<AppCatalogEntry>> Function()? onListChildApps;

  /// What the last `setPolicy` was called with. The DTO's field names are the
  /// contract, and a test that only asserts «save was called» would not catch
  /// a cleared bedtime being sent as `""` — which `@Matches` refuses.
  Map<String, Object?>? lastSetPolicyArgs;

  /// The package names passed to `blockPackage`, in order.
  final List<String> blockedPackages = <String>[];

  /// The `(childId, ruleId)` pairs passed to `deactivateAppBlockRule`.
  final List<String> deactivatedRuleIds = <String>[];

  @override
  Future<ScreenTimePolicy?> getPolicy(String childId) => _need(onGetPolicy, 'getPolicy');

  @override
  Future<EffectiveScreenTimePolicy> getEffectivePolicy(String childId) =>
      _need(onGetEffectivePolicy, 'getEffectivePolicy');

  @override
  Future<ScreenTimePolicy?> setPolicy(
    String childId, {
    int? dailyLimitMinutes,
    String? bedtimeStart,
    String? bedtimeEnd,
    bool? focusModeEnabled,
  }) {
    lastSetPolicyArgs = <String, Object?>{
      'childId': childId,
      'dailyLimitMinutes': dailyLimitMinutes,
      'bedtimeStart': bedtimeStart,
      'bedtimeEnd': bedtimeEnd,
      'focusModeEnabled': focusModeEnabled,
    };
    return _need(onSetPolicy, 'setPolicy');
  }

  @override
  Future<List<AppBlockRule>> listAppBlockRules(String childId) =>
      _need(onListAppBlockRules, 'listAppBlockRules');

  @override
  Future<AppBlockRule> blockPackage(
    String childId, {
    required String packageName,
    String ruleType = AppRuleTypes.block,
    int? limitMinutes,
  }) {
    blockedPackages.add(packageName);
    return _need(onBlockPackage, 'blockPackage');
  }

  @override
  Future<AppBlockRule> blockCategory(
    String childId, {
    required String category,
    String ruleType = AppRuleTypes.block,
    int? limitMinutes,
  }) =>
      throw StateError(
        'FakeScreenTimeRepository.blockCategory was called. No screen offers a '
        'category rule today — if one now does, stub this slot.',
      );

  @override
  Future<void> deactivateAppBlockRule(String childId, String ruleId) {
    deactivatedRuleIds.add(ruleId);
    return _need(onDeactivateAppBlockRule, 'deactivateAppBlockRule');
  }

  @override
  Future<List<AppCatalogEntry>> listChildApps(String childId) =>
      _need(onListChildApps, 'listChildApps');

  Future<T> _need<T>(Future<T> Function()? slot, String name) {
    if (slot == null) {
      throw StateError(
        'FakeScreenTimeRepository.$name was called but this test did not stub '
        'it. Either stub it, or the screen under test is calling an endpoint '
        'it should not.',
      );
    }
    return slot();
  }

  /// Everything not listed above. Throwing by name is the point: a silent
  /// `null` here would show up three layers away as an empty screen.
  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError(
        'FakeScreenTimeRepository has no stub for ${invocation.memberName} — '
        'add one to the harness.',
      );
}

// ---------------------------------------------------------------------------
// Canned outcomes, named for what they mean rather than how they are built.
// ---------------------------------------------------------------------------

/// A future that never completes — the screen stays in its LOADING state.
Future<T> stalled<T>() => Completer<T>().future;

/// The server said no, in Arabic, with a request id — which is the whole reason
/// `DsErrorState` exists (the B3 error envelope).
Future<T> refused<T>() => Future<T>.error(screenTimeFailure);

const ApiFailure screenTimeFailure = ApiFailure(
  message: 'Upstream refused',
  messageAr: 'حدث خطأ غير متوقع',
  code: 'INTERNAL_ERROR',
  statusCode: 500,
  requestId: 'req_test_st_1',
);

// ---------------------------------------------------------------------------
// Domain fixtures. Minimal but VALID — every required field supplied, so the
// preflight's CTOR-REQUIRED check keeps them honest as the models change.
// ---------------------------------------------------------------------------

ScreenTimePolicy testPolicy({
  String id = 'stp_1',
  int? dailyLimitMinutes = 120,
  String? bedtimeStart = '21:00',
  String? bedtimeEnd = '06:30',
  bool focusModeEnabled = false,
  bool hasWeekdaySchedule = false,
}) =>
    ScreenTimePolicy(
      id: id,
      dailyLimitMinutes: dailyLimitMinutes,
      bedtimeStart: bedtimeStart,
      bedtimeEnd: bedtimeEnd,
      focusModeEnabled: focusModeEnabled,
      hasWeekdaySchedule: hasWeekdaySchedule,
    );

/// The default is the case the overview screen exists FOR: a configured limit
/// of 120 and 30 earned minutes on top, so `configured != effective` and the
/// difference has to be explained rather than hidden.
EffectiveScreenTimePolicy testEffective({
  int? base = 120,
  int bonus = 30,
  ScreenTimePolicy? policy,
  List<ScreenTimeGrant>? grants,
}) =>
    EffectiveScreenTimePolicy(
      policy: policy ?? testPolicy(dailyLimitMinutes: base),
      baseDailyLimitMinutes: base,
      bonusMinutes: bonus,
      effectiveDailyLimitMinutes: base == null ? null : base + bonus,
      bonusGrants: grants ??
          (bonus > 0
              ? <ScreenTimeGrant>[
                  ScreenTimeGrant(
                    id: 'grant_1',
                    minutes: bonus,
                    expiresAt: DateTime.utc(2026, 1, 2, 20),
                  ),
                ]
              : const <ScreenTimeGrant>[]),
    );

AppBlockRule testRule({
  String id = 'rule_1',
  String packageName = 'com.example.game',
  String ruleType = AppRuleTypes.block,
  int? limitMinutes,
}) =>
    AppBlockRule(
      id: id,
      childId: 'child_1',
      ruleType: ruleType,
      packageName: packageName,
      limitMinutes: limitMinutes,
    );

AppCatalogEntry testApp({
  String id = 'app_1',
  String packageName = 'com.example.game',
  String appName = 'لعبة',
  String? iconUrl,
}) =>
    AppCatalogEntry(
      id: id,
      packageName: packageName,
      appName: appName,
      iconUrl: iconUrl,
      lastUsedAt: DateTime.utc(2026, 1, 1, 12),
    );

/// The ENGLISH string [key] resolves to. `last_screens_test_harness.dart`
/// already exports `ar(...)`; it has no English twin, and the locale-parity
/// assertion this surface needs is «the chrome switches», which cannot be
/// written without one.
String en(String key, {int? count, Map<String, Object>? options}) =>
    translate(AppLocale.en, key, count: count, options: options);
