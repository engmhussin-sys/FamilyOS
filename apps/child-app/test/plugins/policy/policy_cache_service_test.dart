import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:child_app/plugins/policy/application/policy_cache_service.dart';
import 'package:child_app/plugins/policy/contracts/cached_policy.dart';

/// Same in-memory fake pattern as
/// test/core/storage/secure_token_storage_test.dart and
/// test/features/pairing/device_registration_service_test.dart.
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
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('PolicyCacheService', () {
    late _FakeSecureStorage fakeStorage;
    late PolicyCacheService service;

    setUp(() {
      fakeStorage = _FakeSecureStorage();
      service = PolicyCacheService(fakeStorage);
    });

    test('CRITICAL: returns defaultOfflinePolicy when nothing has ever been cached', () async {
      final policy = await service.getCurrentPolicy();
      expect(policy.dailyLimitMinutes, defaultOfflinePolicy.dailyLimitMinutes);
      expect(policy.bedtimeStart, defaultOfflinePolicy.bedtimeStart);
      // The child is protected by SOME limit even on a device that has
      // literally never synced — this is the whole point of §5.
      expect(policy.dailyLimitMinutes, isNotNull);
    });

    test('returns the real cached policy once one has been synced', () async {
      final synced = CachedPolicy(
        dailyLimitMinutes: 90,
        bedtimeStart: '20:30',
        bedtimeEnd: '06:30',
        focusModeEnabled: true,
        syncedAt: DateTime(2026, 7, 28),
      );

      await service.cache(synced);
      final result = await service.getCurrentPolicy();

      expect(result.dailyLimitMinutes, 90);
      expect(result.bedtimeStart, '20:30');
      expect(result.focusModeEnabled, isTrue);
    });

    test('falls back to defaultOfflinePolicy on a corrupted cache entry, does not throw', () async {
      await fakeStorage.write(key: 'cre_cached_policy', value: 'not valid json {{{');

      final result = await service.getCurrentPolicy();

      expect(result.dailyLimitMinutes, defaultOfflinePolicy.dailyLimitMinutes);
    });

    test('a second cache() call overwrites the first', () async {
      await service.cache(CachedPolicy(
        dailyLimitMinutes: 60, bedtimeStart: null, bedtimeEnd: null,
        focusModeEnabled: false, syncedAt: DateTime(2026, 1, 1),
      ));
      await service.cache(CachedPolicy(
        dailyLimitMinutes: 45, bedtimeStart: null, bedtimeEnd: null,
        focusModeEnabled: false, syncedAt: DateTime(2026, 1, 2),
      ));

      final result = await service.getCurrentPolicy();
      expect(result.dailyLimitMinutes, 45);
    });
  });
}
