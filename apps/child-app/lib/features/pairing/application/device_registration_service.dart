import '../../../core/platform/agent_channel.dart';
import '../../../core/storage/secure_token_storage.dart';
import '../api/pairing_api.dart';

/// The Dart-side orchestration for Sprint 3's "Secure device
/// registration" requirement — mirrors
/// PairingOrchestratorService.registerDevice's shape on the backend,
/// just from the device's side of the same flow:
/// `accept(code) -> generate keypair -> register -> save session`.
class DeviceRegistrationService {
  DeviceRegistrationService(this._pairingApi, this._platformChannel, this._tokenStorage);

  final PairingApi _pairingApi;
  final AgentPlatformChannel _platformChannel;
  final SecureTokenStorage _tokenStorage;

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
  }
}
