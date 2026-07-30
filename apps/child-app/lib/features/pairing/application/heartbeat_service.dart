import 'dart:async';

import '../api/pairing_api.dart';

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
  HeartbeatService(this._pairingApi, {Future<Map<String, dynamic>> Function()? telemetryProvider})
      : _telemetryProvider = telemetryProvider;

  final PairingApi _pairingApi;
  /// Sprint 5 addition — optional, so existing callers (and existing
  /// tests) that construct `HeartbeatService(fakeApi)` with no second
  /// argument are unaffected. Supplies extra fields (e.g. Runtime
  /// enforcement status) merged into every heartbeat call.
  final Future<Map<String, dynamic>> Function()? _telemetryProvider;
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
    try {
      Map<String, dynamic>? extra;
      if (_telemetryProvider != null) {
        try {
          extra = await _telemetryProvider();
        } catch (_) {
          // A telemetry-gathering failure must never block the
          // heartbeat itself — the backend still needs to know the
          // device is alive even if enforcement-status collection failed.
          extra = null;
        }
      }
      await _pairingApi.heartbeat(
        accessibilityServiceEnabled: extra?['accessibilityServiceEnabled'] as bool?,
        enforcementActive: extra?['enforcementActive'] as bool?,
      );
      _lastSentAt = DateTime.now();
    } catch (_) {
      // Per Decision-011 (Offline Mode): a failed heartbeat is an
      // expected, recoverable condition, not a crash-worthy error — the
      // next scheduled tick retries naturally. Real backoff/queuing
      // (Offline Sync Engine, Step 7) is not built here; this is the
      // simplest thing that doesn't crash the app on a transient network blip.
    }
  }
}
