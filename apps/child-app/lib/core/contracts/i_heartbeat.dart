/// Decision-016's `IHeartbeat`. See
/// docs/architecture/child-agent-lifecycle.md §10 — this IS the
/// self-health-monitoring mechanism, not a separate system from it.
abstract class IHeartbeat {
  /// Assembles the current health snapshot (Decision-013's field list)
  /// without sending it anywhere — separated from [send] so Observability
  /// (Step 10) can unit-test snapshot assembly without a network call.
  Future<HeartbeatSnapshot> collectSnapshot();

  /// Sends the snapshot to the backend. Must respect Decision-011's
  /// offline mode: on failure, the snapshot is queued for the Sync Engine
  /// rather than dropped.
  Future<void> send(HeartbeatSnapshot snapshot);
}

class HeartbeatSnapshot {
  const HeartbeatSnapshot({
    required this.capturedAt,
    required this.batteryPercent,
    required this.availableStorageMb,
    required this.isConnected,
    required this.lastSuccessfulSyncAt,
    required this.pendingSyncQueueSize,
    required this.appVersion,
    required this.policyVersion,
  });

  final DateTime capturedAt;
  final int batteryPercent;
  final int availableStorageMb;
  final bool isConnected;
  final DateTime? lastSuccessfulSyncAt;
  final int pendingSyncQueueSize;
  final String appVersion;
  final String? policyVersion;
}
