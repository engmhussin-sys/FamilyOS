import 'dart:async';

import '../../../core/platform/agent_channel.dart';
import '../contracts/i_anti_tamper.dart';

const Map<String, TamperSignal> _signalIdMap = {
  'accessibility_disabled': TamperSignal.accessibilityDisabled,
  'usage_access_disabled': TamperSignal.usageAccessDisabled,
  'root_detected': TamperSignal.rootDetected,
  'mock_location_detected': TamperSignal.mockLocationDetected,
  'emulator_detected': TamperSignal.emulatorDetected,
  'developer_mode_enabled': TamperSignal.developerModeEnabled,
  'usb_debugging_enabled': TamperSignal.usbDebuggingEnabled,
};

/// Implements `IAntiTamper` (declared Step 1) against
/// `AntiTamperDetector.kt`'s 7 checkable-now signals. The other 7
/// `TamperSignal` values (serviceDisabled, appForceStopped, ...) never
/// appear in [checkForTampering]'s results today — they need the
/// Foreground Runtime/Boot Manager (Track B) to be detectable at all,
/// per child-runtime-engine.md §7.
///
/// [signalDetected] is a Dart `Timer.periodic` poll-and-diff, same
/// disclosed limitation as `HeartbeatService` (Sprint 3) — only runs
/// while the Flutter engine is alive, not a real background service.
class PlatformAntiTamper implements IAntiTamper {
  PlatformAntiTamper(this._channel);

  final AgentPlatformChannel _channel;
  final _controller = StreamController<TamperSignal>.broadcast();
  Timer? _pollTimer;
  Set<TamperSignal> _lastKnown = {};

  @override
  Future<List<TamperSignal>> checkForTampering() async {
    final rawSignals = await _channel.checkTamperSignals();
    return rawSignals
        .map((raw) => _signalIdMap[raw as String])
        .whereType<TamperSignal>()
        .toList();
  }

  @override
  Stream<TamperSignal> get signalDetected => _controller.stream;

  void startPolling({Duration interval = const Duration(minutes: 2)}) {
    stopPolling();
    _pollTimer = Timer.periodic(interval, (_) => _pollOnce());
    _pollOnce();
  }

  void stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  Future<void> _pollOnce() async {
    try {
      final current = (await checkForTampering()).toSet();
      final newlyDetected = current.difference(_lastKnown);
      for (final signal in newlyDetected) {
        _controller.add(signal);
      }
      _lastKnown = current;
    } catch (_) {
      // Same "don't crash on a transient platform-channel failure"
      // principle as HeartbeatService — the next poll retries naturally.
    }
  }

  Future<void> dispose() async {
    stopPolling();
    await _controller.close();
  }
}
