import '../../../core/platform/agent_channel.dart';
import '../../policy/application/policy_cache_service.dart';
import '../../../features/pairing/application/heartbeat_service.dart';
import '../contracts/runtime_telemetry.dart';

const _runtimeVersion = '0.1.0'; // matches pubspec.yaml — bumped together, not independently tracked

/// The real implementation `child-runtime-engine.md` §9 previously
/// claimed existed but didn't — built now. Composes:
///   - native memory/battery reading (MainActivity.kt's new
///     `getRuntimeHealth` handler)
///   - `PolicyCacheService` for policy sync recency (Dart-side, already existed)
///   - `HeartbeatService.lastSentAt` for heartbeat recency (small addition, same pass)
/// No single native call could produce this whole snapshot — it
/// deliberately spans both layers, same as `DeviceRegistrationService`
/// already does for pairing.
class RuntimeTelemetryCollector implements IRuntimeTelemetryCollector {
  RuntimeTelemetryCollector(this._channel, this._policyCache, this._heartbeatService);

  final AgentPlatformChannel _channel;
  final PolicyCacheService _policyCache;
  final HeartbeatService _heartbeatService;

  @override
  Future<RuntimeTelemetrySnapshot> collect() async {
    final health = await _channel.getRuntimeHealth();
    final policy = await _policyCache.getCurrentPolicy();

    final memoryUsageMb = health['memoryUsageMb'] as int? ?? 0;
    final isLowMemory = health['isLowMemory'] as bool? ?? false;

    final warnings = <String>[
      if (isLowMemory) 'Device is low on memory',
    ];

    return RuntimeTelemetrySnapshot(
      runtimeVersion: _runtimeVersion,
      // NOTE (honest limitation): no distinct policy-version string is
      // cached locally today — CachedPolicy only stores `syncedAt`, not
      // a version identifier the backend's PolicySyncResponse.policyVersion
      // maps to. Tracked as a real follow-up, not fabricated here.
      policyVersion: null,
      capabilityProfileHash: null, // same honesty: not currently cached locally either
      isHealthy: !isLowMemory,
      memoryUsageMb: memoryUsageMb,
      batteryPercent: health['batteryPercent'] as int?,
      enforcementActive: false, // Track B — no enforcement loop exists yet
      lastPolicySyncAt: policy.syncedAt,
      lastHeartbeatAt: _heartbeatService.lastSentAt,
      warnings: warnings,
    );
  }
}
