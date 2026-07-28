/// Base type for every event flowing through the Agent's Event Bus
/// (Decision-017). The core rule this enforces architecturally: a plugin
/// that needs to react to something happening in another plugin
/// subscribes to an event type here — it never imports and calls the
/// other plugin's class directly. This is what lets `plugins/` stay
/// genuinely independent (Decision-018) instead of secretly coupled
/// through direct references.
///
/// This is a deliberately small, hand-written sealed-style hierarchy
/// (not code-generated via `freezed`) since this sandbox cannot run
/// `build_runner` to verify generated code compiles — see
/// docs/architecture/child-agent-step1-core-architecture.md's
/// disclosure. A future pass, once a real Flutter environment is
/// available, MAY migrate this to `freezed` for exhaustive
/// pattern-matching — noted as a follow-up, not done speculatively here.
sealed class AgentEvent {
  const AgentEvent(this.occurredAt);

  final DateTime occurredAt;
}

/// Emitted by the Capability Engine (Step 4) whenever a re-scan finds a
/// different capability hash than the cached one (Decision-019).
class CapabilityChangedEvent extends AgentEvent {
  const CapabilityChangedEvent({
    required this.previousHash,
    required this.newHash,
    required DateTime occurredAt,
  }) : super(occurredAt);

  final String previousHash;
  final String newHash;
}

/// Emitted by the Permission Manager (Step 5) or the periodic health
/// check (lifecycle ADR §10) when a previously-granted permission is
/// found to be revoked. Per the example in Decision-017, this is expected
/// to be consumed by the Policy Engine, the Sync Engine, AND surfaced as
/// a parent notification — three independent subscribers to one event,
/// not three direct calls from the Permission Manager.
class PermissionRevokedEvent extends AgentEvent {
  const PermissionRevokedEvent({
    required this.permissionId,
    required DateTime occurredAt,
  }) : super(occurredAt);

  /// Matches a stable identifier, not a raw Android permission string —
  /// e.g. "accessibility_service", "usage_access" — defined alongside
  /// IPermissionManager (Step 5), not here.
  final String permissionId;
}

/// Emitted once the Sync Engine (Step 7) successfully pulls policy
/// updates from the backend.
class PolicySyncedEvent extends AgentEvent {
  const PolicySyncedEvent({required this.childId, required DateTime occurredAt})
      : super(occurredAt);

  final String childId;
}

/// Emitted by the pairing flow (Step 2) once pairing completes
/// successfully — the trigger for IAgent.initialize()'s "paired" branch.
class DevicePairedEvent extends AgentEvent {
  const DevicePairedEvent({required this.deviceId, required DateTime occurredAt})
      : super(occurredAt);

  final String deviceId;
}

/// Emitted when the local session is cleared because the refresh token
/// was rejected (mirrors the Admin Dashboard's SESSION_EXPIRED_EVENT —
/// see docs/specifications/http_client.md §2).
class DeviceSessionExpiredEvent extends AgentEvent {
  const DeviceSessionExpiredEvent(DateTime occurredAt) : super(occurredAt);
}
