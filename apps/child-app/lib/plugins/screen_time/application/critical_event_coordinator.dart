import 'dart:async';

import '../../anti_tamper/contracts/i_anti_tamper.dart';
import '../../anti_tamper/infrastructure/platform_anti_tamper.dart';
import '../application/digital_wellbeing_service.dart';

/// CLOSES A REAL GAP found while wiring near-real-time critical events:
/// `PlatformAntiTamper.startPolling()` (built in an earlier sprint)
/// was never actually called anywhere in this app — the detection
/// mechanism existed but nothing ever started it. This coordinator is
/// that missing start call, translating detected tamper signals into
/// the Digital Wellbeing engine's critical-event channel.
///
/// Only signals the product brief's five critical event types can
/// plausibly map to are forwarded (accessibility disabled = a direct
/// match; root/mock-location/developer-mode/USB-debugging are treated
/// as PROTECTION_BYPASS_ATTEMPT). SCREEN_TIME_EXCEEDED and
/// POLICY_VIOLATION are NOT sourced from anti-tamper signals at all —
/// those belong to the Policy Enforcement Engine (Track B, native,
/// not yet built), so this coordinator intentionally does not
/// fabricate them.
///
/// Takes the concrete `PlatformAntiTamper` (not the `IAntiTamper`
/// abstraction) deliberately — `startPolling()` is a real capability
/// specific to the platform-backed implementation, not part of the
/// generic contract every `IAntiTamper` implementation must satisfy.
class CriticalEventCoordinator {
  CriticalEventCoordinator(this._antiTamper, this._wellbeingService);

  final PlatformAntiTamper _antiTamper;
  final DigitalWellbeingService _wellbeingService;
  StreamSubscription<TamperSignal>? _subscription;

  void start() {
    _subscription = _antiTamper.signalDetected.listen(_handleSignal);
    _antiTamper.startPolling();
  }

  Future<void> _handleSignal(TamperSignal signal) async {
    final mapped = _mapSignal(signal);
    if (mapped == null) return;

    try {
      await _wellbeingService.queueCriticalEvent(
        eventType: mapped.eventType,
        title: mapped.title,
        body: mapped.body,
      );
      // Near-real-time per the product brief — drain immediately
      // rather than waiting for the next scheduled cycle. Best-effort:
      // if offline right now, this fails silently and the event stays
      // correctly queued for the next successful drain.
      await _wellbeingService.drainOwnEvents();
    } catch (_) {
      // Best-effort — see comment above.
    }
  }

  ({String eventType, String title, String body})? _mapSignal(TamperSignal signal) {
    switch (signal) {
      case TamperSignal.accessibilityDisabled:
        return (
          eventType: 'ACCESSIBILITY_DISABLED',
          title: 'Protection turned off',
          body: 'Device protection (Accessibility Service) was disabled.',
        );
      case TamperSignal.rootDetected:
      case TamperSignal.mockLocationDetected:
      case TamperSignal.developerModeEnabled:
      case TamperSignal.usbDebuggingEnabled:
        return (
          eventType: 'PROTECTION_BYPASS_ATTEMPT',
          title: 'Possible protection bypass',
          body: 'A signal that could indicate an attempt to bypass device protection was detected (${signal.name}).',
        );
      default:
        // usageAccessDisabled and emulatorDetected are real signals
        // but not mapped to a critical alert here — usageAccessDisabled
        // degrades usage-tracking accuracy (a data-quality concern, not
        // a security one), and emulatorDetected is already covered at
        // /pairing/verify time, not worth re-alerting on during normal use.
        return null;
    }
  }

  void dispose() {
    _subscription?.cancel();
    _antiTamper.stopPolling();
  }
}
