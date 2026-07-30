import '../../pairing/api/pairing_api.dart';
import '../../policy/application/policy_cache_service.dart';
import '../../policy/contracts/cached_policy.dart';
import '../../../core/platform/agent_channel.dart';

class RuntimeEnforcementStatus {
  const RuntimeEnforcementStatus({
    required this.accessibilityServiceEnabled,
    required this.hasEverSyncedPolicy,
  });

  final bool accessibilityServiceEnabled;
  final bool hasEverSyncedPolicy;
}

/// Sprint 5's "Runtime Coordinator." Per the Child Runtime Engine's own
/// principle ("Flutter must never contain enforcement logic"), this
/// class contains ZERO decisions about what to block — that lives
/// entirely in `PolicyEnforcer.kt`. This class only: fetches policy from
/// the backend, caches it locally (offline protection), pushes it to
/// native storage, and reads back native state for display. If this
/// class were deleted entirely, `ChildGuardAccessibilityService` would
/// keep enforcing whatever policy was last pushed — that separation is
/// the point.
class RuntimeCoordinator {
  RuntimeCoordinator(this._channel, this._pairingApi, this._policyCache);

  final AgentPlatformChannel _channel;
  final PairingApi _pairingApi;
  final PolicyCacheService _policyCache;

  /// Fetches the latest policy from the backend, caches it locally, and
  /// pushes it into native storage — in that order, so a failure at any
  /// step leaves the previous (still-valid) native policy in place
  /// rather than clearing it.
  Future<void> syncPolicy() async {
    final remote = await _pairingApi.getPolicy();

    final blockedPackages = (remote['blockedPackages'] as List<dynamic>?)
            ?.map((e) => e.toString())
            .toList() ??
        <String>[];

    final cached = CachedPolicy(
      dailyLimitMinutes: remote['dailyLimitMinutes'] as int?,
      bedtimeStart: remote['bedtimeStart'] as String?,
      bedtimeEnd: remote['bedtimeEnd'] as String?,
      focusModeEnabled: remote['focusModeEnabled'] as bool? ?? false,
      syncedAt: DateTime.now(),
    );
    await _policyCache.cache(cached);

    await _channel.syncPolicyToNative(
      dailyLimitMinutes: cached.dailyLimitMinutes,
      bedtimeStart: cached.bedtimeStart,
      bedtimeEnd: cached.bedtimeEnd,
      focusModeEnabled: cached.focusModeEnabled,
      blockedPackages: blockedPackages,
    );
  }

  Future<void> startEnforcementService() async {
    await _channel.startEnforcementService();
  }

  Future<RuntimeEnforcementStatus> getStatus() async {
    final raw = await _channel.getEnforcementStatus();
    return RuntimeEnforcementStatus(
      accessibilityServiceEnabled: raw['accessibilityServiceEnabled'] as bool? ?? false,
      hasEverSyncedPolicy: raw['hasEverSyncedPolicy'] as bool? ?? false,
    );
  }

  /// Merged into the next heartbeat's telemetry (see HeartbeatService's
  /// `telemetryProvider` — Sprint 5 addition) so the backend/Dashboard
  /// can see enforcement state without a separate polling endpoint.
  Future<Map<String, dynamic>> collectTelemetryFields() async {
    final status = await getStatus();
    return {
      'accessibilityServiceEnabled': status.accessibilityServiceEnabled,
      'enforcementActive': status.accessibilityServiceEnabled && status.hasEverSyncedPolicy,
    };
  }
}
