/// Decision-016's `ISyncEngine`. Encodes two prior decisions structurally:
/// - Decision-009: communication priority is Push (FCM) → persistent
///   WebSocket → polling fallback, in that order — [currentTransport]
///   exposes which one is actually active, since falling back is a
///   normal, expected state, not a failure to hide.
/// - Decision-011: offline mode is not an edge case. [enqueueEvent] must
///   never throw for "no connectivity" — it persists locally and returns;
///   whether that succeeded in reaching the server is a separate concern
///   from whether the caller's write succeeded locally.
abstract class ISyncEngine {
  SyncTransport get currentTransport;

  /// Persists [event] locally (durable storage — see lifecycle ADR §4)
  /// and attempts to send it via [currentTransport]. Returns immediately;
  /// callers must not assume the event has reached the server just
  /// because this returned.
  Future<void> enqueueEvent(Map<String, dynamic> event);

  /// Number of events persisted locally but not yet confirmed delivered —
  /// also surfaced via IHeartbeat.collectSnapshot's pendingSyncQueueSize.
  Future<int> pendingQueueSize();

  /// Attempts to flush the pending queue now, e.g. triggered by
  /// connectivity restoration (Decision-011: "يرسل تنبيهًا عند عودة
  /// الاتصال" — alert on reconnection is a consequence of this running,
  /// not a separate mechanism).
  Future<void> flushPendingQueue();
}

enum SyncTransport { pushNotification, persistentWebSocket, pollingFallback }
