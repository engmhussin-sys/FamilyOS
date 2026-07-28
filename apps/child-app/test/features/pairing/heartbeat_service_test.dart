import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/features/pairing/api/pairing_api.dart';
import 'package:child_app/features/pairing/application/heartbeat_service.dart';

class _FakePairingApi implements PairingApi {
  int heartbeatCallCount = 0;
  bool shouldThrow = false;

  @override
  Future<void> heartbeat() async {
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
}
