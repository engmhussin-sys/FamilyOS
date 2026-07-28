import '../events/event_bus.dart';

/// Decision-018: "each module is a Plugin, not just a folder." This
/// interface is what makes that literally true — every plugin under
/// `lib/plugins/*` implements this and is registered with the same
/// lifecycle hook, rather than being wired ad hoc.
///
/// A plugin MUST NOT import another plugin's classes directly — it
/// communicates only via [eventBus] (Decision-017) and the core
/// contracts (ICapabilityProvider, IPolicyProvider, etc.), which are
/// injected, not imported from a sibling plugin package.
abstract class AgentPlugin {
  /// Stable identifier, e.g. "screen_time", "anti_tamper" — matches the
  /// plugin's folder name under lib/plugins/, and is what
  /// Decision-020's Feature Flags will key on.
  String get id;

  /// Called once during IAgent.initialize() (lifecycle ADR §1), in an
  /// order determined by the Agent orchestrator, not by the plugin
  /// itself. Receives the shared EventBus to subscribe/publish through.
  Future<void> initialize(EventBus eventBus);

  Future<void> dispose();
}
