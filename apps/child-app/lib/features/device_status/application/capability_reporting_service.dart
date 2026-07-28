import '../../../core/platform/agent_channel.dart';
import '../../pairing/api/pairing_api.dart';

/// Sprint 4 — the Dart-side trigger for the Full Capability Engine
/// report. Deliberately simple: read from native, send to backend. The
/// hash-based "only send when changed" optimization (Decision-019) is
/// computed on the native side (DeviceCapabilityEngine.kt) — this class
/// doesn't second-guess that, it just relays whatever the platform
/// channel returns.
class CapabilityReportingService {
  CapabilityReportingService(this._channel, this._pairingApi);

  final AgentPlatformChannel _channel;
  final PairingApi _pairingApi;

  Future<void> reportNow() async {
    final report = await _channel.getCapabilityReport();
    await _pairingApi.reportCapabilities(report);
  }
}
