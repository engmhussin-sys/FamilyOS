import 'dart:async';

import 'agent_event.dart';

/// The concrete Event Bus (Decision-017). Deliberately minimal: a single
/// broadcast `Stream<AgentEvent>` that any plugin can `.listen()` to, and
/// a single `emit()` that any plugin can call to publish. There is no
/// per-event-type routing built in here — subscribers filter by type
/// themselves (`event is PermissionRevokedEvent`) — adding a fancier
/// typed-routing layer before there's a second real subscriber to justify
/// it would be speculative complexity, not architecture.
///
/// This is provided via Riverpod (see core/di/providers.dart) as a
/// singleton — every plugin depends on the SAME instance, which is what
/// makes "Module A calls Module B directly" (the pattern Decision-017
/// explicitly rejects) structurally impossible: plugins never hold a
/// reference to each other, only to this bus.
class EventBus {
  final _controller = StreamController<AgentEvent>.broadcast();

  Stream<AgentEvent> get stream => _controller.stream;

  void emit(AgentEvent event) {
    if (_controller.isClosed) return;
    _controller.add(event);
  }

  /// Convenience for subscribers that only care about one event type —
  /// e.g. `eventBus.on<PermissionRevokedEvent>().listen(...)`.
  Stream<T> on<T extends AgentEvent>() => stream.whereType<T>();

  Future<void> dispose() => _controller.close();
}
