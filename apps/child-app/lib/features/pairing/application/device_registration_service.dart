import '../../../core/platform/agent_channel.dart';
import '../../../core/storage/secure_token_storage.dart';
import '../../../plugins/anti_tamper/contracts/i_anti_tamper.dart';
import '../api/pairing_api.dart';

/// The Dart-side orchestration for Sprint 3's "Secure device
/// registration" requirement — mirrors
/// PairingOrchestratorService.registerDevice's shape on the backend,
/// just from the device's side of the same flow:
/// `accept(code) -> generate keypair -> register -> save session`.
class DeviceRegistrationService {
  DeviceRegistrationService(this._pairingApi, this._platformChannel, this._tokenStorage, this._antiTamper);

  final PairingApi _pairingApi;
  final AgentPlatformChannel _platformChannel;
  final SecureTokenStorage _tokenStorage;
  final IAntiTamper _antiTamper;

  /// Throws `InvalidOrExpiredInvitationException`-equivalent (an
  /// `ApiException` with the backend's message) if the code is wrong/
  /// expired/already used — the UI layer (PairingScreen) is responsible
  /// for showing that message, this method doesn't catch it.
  Future<void> registerWithCode(String invitationCode) async {
    final ticket = await _pairingApi.accept(invitationCode);

    final publicKey = await _platformChannel.getDevicePublicKey();
    final sdkInt = await _platformChannel.getAndroidSdkInt();
    final appVersion = await _platformChannel.getNativeAppVersion();

    final result = await _pairingApi.registerDevice(
      registrationToken: ticket.token,
      publicKey: publicKey,
      platform: 'ANDROID',
      appVersion: appVersion,
      // Both fields below are informational context for the backend's
      // Pairing Capability Snapshot (Decision-055) — full capability
      // reporting (manufacturer/model) is Sprint 4's Device Capability
      // Engine, not duplicated here.
      osVersion: 'API $sdkInt',
      pairingProtocolVersion: '1.0',
    );

    await _tokenStorage.saveSession(
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      deviceId: result.deviceId,
    );

    // CLOSING A REAL GAP found during Sprint 23's hardening pass: this
    // call to /pairing/verify never existed before, meaning
    // `PlatformAntiTamper.checkForTampering()`'s correctly-detected
    // signals had no path to the backend's already-built
    // RiskEvaluationService. Placed here — right after the device's
    // own access token exists, since /pairing/verify requires
    // DeviceJwtAuthGuard. Best-effort: a transient failure here (e.g.
    // the platform channel misbehaving on a specific OEM, per
    // DEVICE_VALIDATION_MATRIX.md's own documented per-manufacturer
    // risk) must never block pairing itself from completing —
    // pairing having already succeeded is more important than this
    // one risk snapshot being perfectly timed.
    try {
      final tamperSignals = await _antiTamper.checkForTampering();
      await _pairingApi.verify(riskSignals: tamperSignalsToRiskSignalsDto(tamperSignals));
    } catch (_) {
      // Intentionally swallowed — see comment above. The next
      // WorkManager-driven watchdog cycle or a future heartbeat-borne
      // re-check (not built this sprint) is the real follow-up path,
      // not blocking this method's caller.
    }
  }
}
