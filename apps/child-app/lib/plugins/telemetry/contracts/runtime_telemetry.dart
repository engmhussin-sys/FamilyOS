/// Sprint 4 (Child Runtime Engine) §9 — the exact field list requested:
/// runtime version, policy version, capability snapshot, runtime
/// health, memory usage, battery state, enforcement state, last policy
/// sync, last heartbeat, runtime warnings.
class RuntimeTelemetrySnapshot {
  const RuntimeTelemetrySnapshot({
    required this.runtimeVersion,
    required this.policyVersion,
    required this.capabilityProfileHash,
    required this.isHealthy,
    required this.memoryUsageMb,
    required this.batteryPercent,
    required this.enforcementActive,
    required this.lastPolicySyncAt,
    required this.lastHeartbeatAt,
    required this.warnings,
  });

  final String runtimeVersion;
  final String? policyVersion;
  final String? capabilityProfileHash;
  final bool isHealthy;
  final int memoryUsageMb;
  final int? batteryPercent;
  /// Whether the Policy Enforcement Engine is actively blocking/allowing
  /// right now — hardcoded `false` until Track B's real enforcement loop
  /// exists (there is nothing to be "active" yet). Not omitted, since
  /// the field itself is part of the requested contract shape — its
  /// value is honestly `false`, not faked as `true`.
  final bool enforcementActive;
  final DateTime? lastPolicySyncAt;
  final DateTime? lastHeartbeatAt;
  final List<String> warnings;

  Map<String, dynamic> toJson() => {
        'runtimeVersion': runtimeVersion,
        'policyVersion': policyVersion,
        'capabilityProfileHash': capabilityProfileHash,
        'isHealthy': isHealthy,
        'memoryUsageMb': memoryUsageMb,
        'batteryPercent': batteryPercent,
        'enforcementActive': enforcementActive,
        'lastPolicySyncAt': lastPolicySyncAt?.toIso8601String(),
        'lastHeartbeatAt': lastHeartbeatAt?.toIso8601String(),
        'warnings': warnings,
      };
}

abstract class IRuntimeTelemetryCollector {
  Future<RuntimeTelemetrySnapshot> collect();
}
