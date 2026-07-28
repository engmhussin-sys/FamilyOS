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

// --- Child Runtime Engine (CRE) events, declared for Track B ---
// These types exist so Track B's Accessibility Manager/Policy
// Enforcement Engine has a contract to emit/consume against once built —
// none of these are emitted by any code today. Same "declare before the
// consumer exists" discipline as the five events above were originally
// declared under in Step 1.

/// Would be emitted by the Accessibility Manager (Track B) on every
/// detected foreground-app change — the actual trigger for policy
/// evaluation. Not emitted by any code yet.
class ForegroundAppChangedEvent extends AgentEvent {
  const ForegroundAppChangedEvent({
    required this.packageName,
    required DateTime occurredAt,
  }) : super(occurredAt);

  final String packageName;
}

/// Would be emitted by the Policy Enforcement Engine (Track B) after
/// evaluating a ForegroundAppChangedEvent against the cached policy
/// (plugins/policy/) — the Overlay Runtime (Track B) would subscribe to
/// this, not be called directly.
class PolicyDecisionMadeEvent extends AgentEvent {
  const PolicyDecisionMadeEvent({
    required this.packageName,
    required this.isBlocked,
    required this.reason,
    required DateTime occurredAt,
  }) : super(occurredAt);

  final String packageName;
  final bool isBlocked;
  final String reason;
}

/// Would be emitted by the Overlay Runtime (Track B) once it actually
/// shows a blocking screen — the Heartbeat Scheduler (already built)
/// would subscribe to this to include enforcement activity in the next
/// heartbeat's telemetry (§9 of child-runtime-engine.md).
class OverlayTriggeredEvent extends AgentEvent {
  const OverlayTriggeredEvent({
    required this.packageName,
    required DateTime occurredAt,
  }) : super(occurredAt);

  final String packageName;
}

/// Emitted by AntiTamperDetector (built this session) whenever a check
/// flips from clean to flagged. Unlike the events above, THIS one IS
/// wired to a real detector today (see plugins/anti_tamper/).
class TamperDetectedEvent extends AgentEvent {
  const TamperDetectedEvent({
    required this.signal,
    required DateTime occurredAt,
  }) : super(occurredAt);

  /// e.g. "accessibility_disabled", "developer_mode_enabled" — matches
  /// AntiTamperSignal's kind field, not a raw platform string.
  final String signal;
}

/// Would be emitted periodically by the Runtime Watchdog (Track B —
/// depends on the Foreground Runtime existing) summarizing overall
/// runtime health for telemetry.
class RuntimeHealthEvent extends AgentEvent {
  const RuntimeHealthEvent({
    required this.isHealthy,
    required this.warnings,
    required DateTime occurredAt,
  }) : super(occurredAt);

  final bool isHealthy;
  final List<String> warnings;
}
