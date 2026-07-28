import '../events/agent_event.dart';

/// The Agent's top-level lifecycle contract (Decision-016's `IAgent`).
/// Concrete implementation (`AgentLifecycle`) is NOT written yet — this
/// is the contract Step 2+ builds against, per the explicit instruction
/// to create interfaces before implementations.
///
/// See docs/architecture/child-agent-lifecycle.md for the full behavioral
/// specification each method below must satisfy (startup sequence, boot
/// behavior, crash recovery, etc.) — this file defines the shape, that
/// document defines the behavior.
abstract class IAgent {
  /// Runs the startup sequence described in the lifecycle ADR §1.
  /// Must be idempotent — calling it again while already initialized
  /// should be a safe no-op, not a duplicate initialization.
  Future<void> initialize();

  /// True once initialize() has completed successfully and the Agent is
  /// paired + operational (lifecycle ADR §1, step 4).
  bool get isOperational;

  /// Emits every lifecycle-relevant transition (paired, unpaired,
  /// capability changed, permission revoked, etc.) — see AgentEvent.
  Stream<AgentEvent> get events;

  /// Graceful shutdown path — releases resources, does NOT stop the
  /// native Foreground Service (that has its own lifecycle independent
  /// of the Dart layer, per lifecycle ADR §9's crash-isolation design).
  Future<void> dispose();
}
