// WHAT THIS FILE PROVES — the child device registers its push token exactly
// once per distinct token, and never invents one.
//
// The gap it closes: `POST /pairing/device/push-token` shipped complete and
// no Flutter code called it, so the child half of the notification engine had
// no delivery address. The risk in closing it is the opposite one — a client
// that re-registers an unchanged token on every `onTokenRefresh` (which some
// devices fire on every cold start) against a route throttled to 10/min.
//
// EXECUTION STATUS: NEVER RUN. No Flutter or Dart SDK is reachable from the
// environment this was authored in. STATIC VERIFIED by
// `scripts/dart_preflight.py` only — that script checks constructor arity,
// named parameters, member references and import scope, is not a Dart
// analyser, and executes nothing. First execution happens on a CI runner.

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/features/pairing/api/pairing_api.dart';
import 'package:child_app/features/pairing/application/push_token_registration_service.dart';

/// The same `implements` + `noSuchMethod` fake style the rest of this suite
/// uses — `build_runner` cannot run without pub.dev.
class _FakeSecureStorage implements FlutterSecureStorage {
  final Map<String, String> values = {};

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      values[key];

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      values.remove(key);
    } else {
      values[key] = value;
    }
  }

  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    values.remove(key);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakePairingApi implements PairingApi {
  final List<String> registered = [];
  bool shouldThrow = false;

  @override
  Future<void> registerPushToken(String pushToken) async {
    if (shouldThrow) throw Exception('network error');
    registered.add(pushToken);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  late _FakePairingApi api;
  late _FakeSecureStorage storage;
  late PushTokenRegistrationService service;

  setUp(() {
    api = _FakePairingApi();
    storage = _FakeSecureStorage();
    service = PushTokenRegistrationService(api, storage);
  });

  test('a token that has never been registered is sent', () async {
    final sent = await service.onTokenAvailable('fcm-token-1');

    expect(sent, isTrue);
    expect(api.registered, ['fcm-token-1']);
  });

  test('an unchanged token is NOT sent again', () async {
    await service.onTokenAvailable('fcm-token-1');
    final sentAgain = await service.onTokenAvailable('fcm-token-1');

    expect(sentAgain, isFalse);
    expect(api.registered, ['fcm-token-1'],
        reason: 'onTokenRefresh fires on every cold start on some devices');
  });

  test('an unchanged token is not sent again after a restart either', () async {
    await service.onTokenAvailable('fcm-token-1');

    // A brand-new instance over the SAME storage: this is a process restart.
    final afterRestart = PushTokenRegistrationService(api, storage);
    final sent = await afterRestart.onTokenAvailable('fcm-token-1');

    expect(sent, isFalse);
    expect(api.registered, ['fcm-token-1']);
  });

  test('a rotated token IS sent', () async {
    await service.onTokenAvailable('fcm-token-1');
    final sent = await service.onTokenAvailable('fcm-token-2');

    expect(sent, isTrue);
    expect(api.registered, ['fcm-token-1', 'fcm-token-2']);
  });

  test('surrounding whitespace does not make a token look new', () async {
    await service.onTokenAvailable('fcm-token-1');
    final sent = await service.onTokenAvailable('  fcm-token-1  ');

    expect(sent, isFalse);
    expect(api.registered, ['fcm-token-1']);
  });

  test('an empty token is never sent — there is nothing to register', () async {
    expect(await service.onTokenAvailable(''), isFalse);
    expect(await service.onTokenAvailable('   '), isFalse);
    expect(api.registered, isEmpty);
  });

  test('a failed send is not remembered as delivered', () async {
    api.shouldThrow = true;
    await expectLater(service.onTokenAvailable('fcm-token-1'), throwsException);
    expect(storage.values, isEmpty);

    api.shouldThrow = false;
    final sent = await service.onTokenAvailable('fcm-token-1');

    expect(sent, isTrue, reason: 'the retry must not be suppressed by a failure');
    expect(api.registered, ['fcm-token-1']);
  });

  test('forgetting the last token makes the same string send again', () async {
    await service.onTokenAvailable('fcm-token-1');
    await service.forgetLastRegisteredToken();

    // Re-pairing creates a different Device row server-side even when FCM
    // hands back the identical token string.
    final sent = await service.onTokenAvailable('fcm-token-1');

    expect(sent, isTrue);
    expect(api.registered, ['fcm-token-1', 'fcm-token-1']);
    expect(storage.values.values, contains('fcm-token-1'));
  });
}
