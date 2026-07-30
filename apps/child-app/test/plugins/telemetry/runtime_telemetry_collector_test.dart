import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/platform/agent_channel.dart';
import 'package:child_app/features/pairing/api/pairing_api.dart';
import 'package:child_app/features/pairing/application/heartbeat_service.dart';
import 'package:child_app/plugins/policy/application/policy_cache_service.dart';
import 'package:child_app/plugins/policy/contracts/cached_policy.dart';
import 'package:child_app/plugins/telemetry/application/runtime_telemetry_collector.dart';

class _FakeAgentPlatformChannel implements AgentPlatformChannel {
  Map<Object?, Object?> runtimeHealth = {
    'memoryUsageMb': 128,
    'batteryPercent': 80,
    'isLowMemory': false,
  };

  @override
  Future<Map<Object?, Object?>> getRuntimeHealth() async => runtimeHealth;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakePolicyCacheService implements PolicyCacheService {
  CachedPolicy? policy;

  @override
  Future<CachedPolicy> getCurrentPolicy() async => policy ?? defaultOfflinePolicy;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakePairingApi implements PairingApi {
  @override
  Future<void> heartbeat({
    int? batteryPercent,
    bool? isConnected,
    bool? accessibilityServiceEnabled,
    bool? enforcementActive,
  }) async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('RuntimeTelemetryCollector', () {
    late _FakeAgentPlatformChannel fakeChannel;
    late _FakePolicyCacheService fakePolicyCache;
    late HeartbeatService heartbeatService;
    late RuntimeTelemetryCollector collector;

    setUp(() {
      fakeChannel = _FakeAgentPlatformChannel();
      fakePolicyCache = _FakePolicyCacheService();
      heartbeatService = HeartbeatService(_FakePairingApi());
      collector = RuntimeTelemetryCollector(fakeChannel, fakePolicyCache, heartbeatService);
    });

    tearDown(() => heartbeatService.stop());

    test('reports isHealthy true and no warnings when memory is not low', () async {
      final snapshot = await collector.collect();
      expect(snapshot.isHealthy, isTrue);
      expect(snapshot.warnings, isEmpty);
      expect(snapshot.memoryUsageMb, 128);
      expect(snapshot.batteryPercent, 80);
    });

    test('reports isHealthy false with a warning when the device is low on memory', () async {
      fakeChannel.runtimeHealth = {'memoryUsageMb': 900, 'batteryPercent': 20, 'isLowMemory': true};

      final snapshot = await collector.collect();

      expect(snapshot.isHealthy, isFalse);
      expect(snapshot.warnings, contains('Device is low on memory'));
    });

    test('enforcementActive is honestly false — no enforcement loop exists yet (Track B)', () async {
      final snapshot = await collector.collect();
      expect(snapshot.enforcementActive, isFalse);
    });

    test('lastPolicySyncAt reflects the cached policy\'s syncedAt', () async {
      final syncTime = DateTime(2026, 7, 28, 10, 0);
      fakePolicyCache.policy = CachedPolicy(
        dailyLimitMinutes: 90,
        bedtimeStart: '21:00',
        bedtimeEnd: '07:00',
        focusModeEnabled: true,
        syncedAt: syncTime,
      );

      final snapshot = await collector.collect();

      expect(snapshot.lastPolicySyncAt, syncTime);
    });

    test('lastHeartbeatAt is null before any heartbeat has been sent', () async {
      final snapshot = await collector.collect();
      expect(snapshot.lastHeartbeatAt, isNull);
    });

    test('lastHeartbeatAt reflects HeartbeatService after a successful send', () async {
      heartbeatService.start(interval: const Duration(minutes: 5));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      final snapshot = await collector.collect();

      expect(snapshot.lastHeartbeatAt, isNotNull);
    });
  });
}
