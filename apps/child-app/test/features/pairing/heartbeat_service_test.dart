import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'package:child_app/features/pairing/api/pairing_api.dart';
import 'package:child_app/features/pairing/application/heartbeat_service.dart';
import 'package:child_app/plugins/offline_queue/application/offline_queue.dart';

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

class _FakePairingApi implements PairingApi {
  int heartbeatCallCount = 0;
  bool shouldThrow = false;

  @override
  Future<void> heartbeat({
    int? batteryPercent,
    bool? isConnected,
    bool? accessibilityServiceEnabled,
    bool? enforcementActive,
  }) async {
    heartbeatCallCount++;
    if (shouldThrow) throw Exception('network error');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('HeartbeatService', () {
    late _FakePairingApi fakeApi;
    late HeartbeatService service;

    setUp(() {
      fakeApi = _FakePairingApi();
      service = HeartbeatService(fakeApi);
    });

    tearDown(() {
      service.stop();
    });

    test('is not running before start() is called', () {
      expect(service.isRunning, isFalse);
    });

    test('start() sends an immediate heartbeat without waiting for the first tick', () async {
      service.start(interval: const Duration(minutes: 5)); // long interval — only the immediate call should fire
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(fakeApi.heartbeatCallCount, 1);
      expect(service.isRunning, isTrue);
    });

    test('stop() cancels the timer', () async {
      service.start(interval: const Duration(minutes: 5));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      service.stop();

      expect(service.isRunning, isFalse);
    });

    test('a failed heartbeat does not throw or stop the service (Decision-011: offline is recoverable)', () async {
      fakeApi.shouldThrow = true;

      expect(() => service.start(interval: const Duration(minutes: 5)), returnsNormally);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(service.isRunning, isTrue);
    });

    test('start() called again restarts cleanly instead of stacking timers', () async {
      service.start(interval: const Duration(minutes: 5));
      await Future<void>.delayed(const Duration(milliseconds: 10));
      service.start(interval: const Duration(minutes: 5));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      // Two start() calls = two immediate heartbeats, not an
      // ever-growing number of periodic timers left running in the background.
      expect(fakeApi.heartbeatCallCount, 2);
    });
  });

  group('HeartbeatService with OfflineQueue (Sprint 7)', () {
    late _FakePairingApi fakeApi;
    late OfflineQueue queue;
    late HeartbeatService service;

    setUp(() {
      fakeApi = _FakePairingApi();
      queue = OfflineQueue(_FakeSecureStorage());
      service = HeartbeatService(fakeApi, offlineQueue: queue);
    });

    tearDown(() => service.stop());

    test('a failed heartbeat is queued when an OfflineQueue is supplied', () async {
      fakeApi.shouldThrow = true;

      service.start(interval: const Duration(minutes: 5));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(await queue.length(), 1);
    });

    test('a successful heartbeat drains any previously queued events', () async {
      await queue.enqueue('heartbeat', {'accessibilityServiceEnabled': true});
      fakeApi.shouldThrow = false;

      service.start(interval: const Duration(minutes: 5));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      expect(await queue.length(), 0);
    });

    test('no queue entry is created when offlineQueue is not supplied (backward compatible)', () async {
      final serviceWithoutQueue = HeartbeatService(fakeApi);
      fakeApi.shouldThrow = true;

      expect(() => serviceWithoutQueue.start(interval: const Duration(minutes: 5)), returnsNormally);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      serviceWithoutQueue.stop();
      // No assertion beyond "did not throw" — this is exactly the
      // pre-Sprint-7 behavior for any caller that doesn't opt in.
    });
  });
}
