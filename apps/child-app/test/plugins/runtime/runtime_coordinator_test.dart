import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/platform/agent_channel.dart';
import 'package:child_app/features/pairing/api/pairing_api.dart';
import 'package:child_app/plugins/policy/application/policy_cache_service.dart';
import 'package:child_app/plugins/policy/contracts/cached_policy.dart';
import 'package:child_app/plugins/runtime/application/runtime_coordinator.dart';

class _FakeAgentPlatformChannel implements AgentPlatformChannel {
  Map<String, dynamic>? lastSyncedPolicy;
  bool startEnforcementServiceCalled = false;
  Map<Object?, Object?> enforcementStatus = {
    'accessibilityServiceEnabled': true,
    'hasEverSyncedPolicy': true,
  };

  @override
  Future<void> syncPolicyToNative({
    required int? dailyLimitMinutes,
    required String? bedtimeStart,
    required String? bedtimeEnd,
    required bool focusModeEnabled,
    required List<String> blockedPackages,
  }) async {
    lastSyncedPolicy = {
      'dailyLimitMinutes': dailyLimitMinutes,
      'bedtimeStart': bedtimeStart,
      'bedtimeEnd': bedtimeEnd,
      'focusModeEnabled': focusModeEnabled,
      'blockedPackages': blockedPackages,
    };
  }

  @override
  Future<void> startEnforcementService() async {
    startEnforcementServiceCalled = true;
  }

  @override
  Future<Map<Object?, Object?>> getEnforcementStatus() async => enforcementStatus;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakePolicyCacheService implements PolicyCacheService {
  CachedPolicy? cached;

  @override
  Future<void> cache(CachedPolicy policy) async {
    cached = policy;
  }

  @override
  Future<CachedPolicy> getCurrentPolicy() async => cached ?? defaultOfflinePolicy;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakePairingApi implements PairingApi {
  Map<String, dynamic> policyResponse = {
    'dailyLimitMinutes': 90,
    'bedtimeStart': '21:00',
    'bedtimeEnd': '07:00',
    'focusModeEnabled': true,
    'blockedPackages': ['com.example.game'],
  };

  @override
  Future<Map<String, dynamic>> getPolicy() async => policyResponse;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('RuntimeCoordinator', () {
    late _FakeAgentPlatformChannel fakeChannel;
    late _FakePolicyCacheService fakePolicyCache;
    late _FakePairingApi fakePairingApi;
    late RuntimeCoordinator coordinator;

    setUp(() {
      fakeChannel = _FakeAgentPlatformChannel();
      fakePolicyCache = _FakePolicyCacheService();
      fakePairingApi = _FakePairingApi();
      coordinator = RuntimeCoordinator(fakeChannel, fakePairingApi, fakePolicyCache);
    });

    test('syncPolicy caches locally AND pushes to native, with matching values', () async {
      await coordinator.syncPolicy();

      expect(fakePolicyCache.cached?.dailyLimitMinutes, 90);
      expect(fakePolicyCache.cached?.focusModeEnabled, isTrue);

      expect(fakeChannel.lastSyncedPolicy?['dailyLimitMinutes'], 90);
      expect(fakeChannel.lastSyncedPolicy?['bedtimeStart'], '21:00');
      expect(fakeChannel.lastSyncedPolicy?['blockedPackages'], ['com.example.game']);
    });

    test('syncPolicy defaults blockedPackages to an empty list when absent from the response', () async {
      fakePairingApi.policyResponse = {
        'dailyLimitMinutes': null,
        'bedtimeStart': null,
        'bedtimeEnd': null,
        'focusModeEnabled': false,
      };

      await coordinator.syncPolicy();

      expect(fakeChannel.lastSyncedPolicy?['blockedPackages'], <String>[]);
    });

    test('startEnforcementService delegates directly to the platform channel', () async {
      await coordinator.startEnforcementService();
      expect(fakeChannel.startEnforcementServiceCalled, isTrue);
    });

    test('getStatus maps the raw platform channel response into a typed status', () async {
      final status = await coordinator.getStatus();
      expect(status.accessibilityServiceEnabled, isTrue);
      expect(status.hasEverSyncedPolicy, isTrue);
    });

    test('collectTelemetryFields reports enforcementActive true only when BOTH conditions hold', () async {
      fakeChannel.enforcementStatus = {
        'accessibilityServiceEnabled': true,
        'hasEverSyncedPolicy': false,
      };

      final fields = await coordinator.collectTelemetryFields();

      expect(fields['accessibilityServiceEnabled'], isTrue);
      expect(fields['enforcementActive'], isFalse); // policy never synced — not truly enforcing yet
    });
  });
}
