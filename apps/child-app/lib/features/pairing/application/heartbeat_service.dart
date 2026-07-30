import 'dart:async';

import '../api/pairing_api.dart';
import '../../offline_queue/application/offline_queue.dart';

/// Sprint 3's "Heartbeat mechanism," foundation scope. This is a
/// Dart-level `Timer`, which only runs while the Flutter engine is
/// alive (foreground/recently-backgrounded) — it is explicitly NOT the
/// persistent-across-reboot, survives-app-kill mechanism described in
/// docs/architecture/child-agent-lifecycle.md §2/§5/§6 (native Foreground
/// Service + WorkManager watchdog + BOOT_COMPLETED receiver). That native
/// implementation is Sprint 4's job, per the reviewer's own sprint
/// ordering ("Android Native Layer... Foreground Service"). This class
/// is the piece Sprint 4's native service will eventually trigger
/// (or be re-implemented natively calling the same backend endpoint) —
/// built now so the backend contract has a real, testable Dart consumer
/// today, not left unconsumed.
class HeartbeatService {
  HeartbeatService(
    this._pairingApi, {
    Future<Map<String, dynamic>> Function()? telemetryProvider,
    OfflineQueue? offlineQueue,
  })  : _telemetryProvider = telemetryProvider,
        _offlineQueue = offlineQueue;

  final PairingApi _pairingApi;
  final Future<Map<String, dynamic>> Function()? _telemetryProvider;
  /// Sprint 7 — optional, same backward-compatibility discipline as
  /// `telemetryProvider` above. When provided, a failed heartbeat is
  /// queued instead of silently discarded.
  final OfflineQueue? _offlineQueue;
  Timer? _timer;
  DateTime? _lastSentAt;

  bool get isRunning => _timer != null;

  /// Sprint 4 (Child Runtime Engine) §9 — Runtime Telemetry needs a real
  /// "last heartbeat" timestamp; exposed here rather than duplicating
  /// heartbeat bookkeeping in a second place.
  DateTime? get lastSentAt => _lastSentAt;

  void start({Duration interval = const Duration(seconds: 30)}) {
    stop();
    _timer = Timer.periodic(interval, (_) => _sendHeartbeat());
    _sendHeartbeat(); // send immediately, don't wait for the first tick
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _sendHeartbeat() async {
    Map<String, dynamic>? extra;
    if (_telemetryProvider != null) {
      try {
        extra = await _telemetryProvider();
      } catch (_) {
        // A telemetry-gathering failure must never block the heartbeat
        // itself — the backend still needs to know the device is alive
        // even if enforcement-status collection failed.
        extra = null;
      }
    }

    try {
      await _pairingApi.heartbeat(
        accessibilityServiceEnabled: extra?['accessibilityServiceEnabled'] as bool?,
        enforcementActive: extra?['enforcementActive'] as bool?,
      );
      _lastSentAt = DateTime.now();

      // Sprint 7: a live heartbeat means connectivity is back — drain
      // anything queued while offline before this cycle ends.
      if (_offlineQueue != null) {
        await _offlineQueue.drain((event) => _sendQueuedEvent(event));
      }
    } catch (_) {
      // Per Decision-011 (Offline Mode): a failed heartbeat is an
      // expected, recoverable condition, not a crash-worthy error.
      // Sprint 7: now also queued (when an OfflineQueue is supplied) so
      // it isn't silently lost — the queue is drained on the next
      // successful heartbeat above, not retried independently here.
      if (_offlineQueue != null) {
        await _offlineQueue.enqueue('heartbeat', {
          'accessibilityServiceEnabled': extra?['accessibilityServiceEnabled'],
          'enforcementActive': extra?['enforcementActive'],
        });
      }
    }
  }

  Future<void> _sendQueuedEvent(QueuedEvent event) async {
    switch (event.type) {
      case 'heartbeat':
        await _pairingApi.heartbeat(
          accessibilityServiceEnabled: event.payload['accessibilityServiceEnabled'] as bool?,
          enforcementActive: event.payload['enforcementActive'] as bool?,
        );
      default:
        // Unknown event type queued by a future feature this class
        // doesn't know about yet — skip rather than throw, so it
        // doesn't block draining the rest of the queue. Not silently
        // lost either: still counted as "not sent" since this method
        // doesn't swallow-and-report-success for it.
        throw StateError('Unknown queued event type: ${event.type}');
    }
  }
}
