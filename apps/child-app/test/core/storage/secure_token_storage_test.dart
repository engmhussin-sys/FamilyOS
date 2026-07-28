import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:child_app/core/storage/secure_token_storage.dart';

/// Fakes the storage backend with a plain in-memory Map — the same
/// well-known "map-backed fake" pattern used throughout the backend's
/// repository-port tests, applied here to Dart's `FlutterSecureStorage`
/// interface instead of a TS interface.
class _FakeSecureStorage implements FlutterSecureStorage {
  final Map<String, String> _values = {};

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async => _values[key];

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
      _values.remove(key);
    } else {
      _values[key] = value;
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
    _values.remove(key);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('SecureTokenStorage', () {
    late SecureTokenStorage storage;

    setUp(() {
      storage = SecureTokenStorage(_FakeSecureStorage());
    });

    test('has no session before saveSession is called', () async {
      expect(await storage.hasSession(), isFalse);
      expect(await storage.getAccessToken(), isNull);
      expect(await storage.getRefreshToken(), isNull);
    });

    test('saveSession persists all three values and hasSession becomes true', () async {
      await storage.saveSession(
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        deviceId: 'device-1',
      );

      expect(await storage.getAccessToken(), 'access-1');
      expect(await storage.getRefreshToken(), 'refresh-1');
      expect(await storage.getDeviceId(), 'device-1');
      expect(await storage.hasSession(), isTrue);
    });

    test('updateAccessToken changes only the access token', () async {
      await storage.saveSession(
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        deviceId: 'device-1',
      );

      await storage.updateAccessToken('access-2');

      expect(await storage.getAccessToken(), 'access-2');
      expect(await storage.getRefreshToken(), 'refresh-1'); // unchanged
    });

    test('clear() removes everything including deviceId', () async {
      await storage.saveSession(
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        deviceId: 'device-1',
      );

      await storage.clear();

      expect(await storage.getAccessToken(), isNull);
      expect(await storage.getRefreshToken(), isNull);
      expect(await storage.getDeviceId(), isNull);
    });

    test('clearSessionButKeepDeviceId removes tokens but preserves deviceId', () async {
      await storage.saveSession(
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        deviceId: 'device-1',
      );

      await storage.clearSessionButKeepDeviceId();

      expect(await storage.getAccessToken(), isNull);
      expect(await storage.getRefreshToken(), isNull);
      expect(await storage.getDeviceId(), 'device-1'); // deliberately preserved
    });
  });

  // NOTE: ApiClient's refresh-and-retry interceptor (core/network/api_client.dart)
  // is NOT unit-tested in this file. Testing Dio's interceptor chain
  // properly needs either a fake `HttpClientAdapter` (Dio's own seam for
  // this) or the `http_mock_adapter` package — getting either exactly
  // right requires running against a real Dio/Flutter test environment,
  // which this sandbox cannot do (see this step's chat disclosure: no
  // pub.dev/Flutter SDK access here). ApiClient was refactored to accept
  // an injectable `Dio` instance specifically so this test CAN be written
  // properly in your real environment — that refactor is done; writing
  // the test itself is a follow-up, not silently skipped.
}
