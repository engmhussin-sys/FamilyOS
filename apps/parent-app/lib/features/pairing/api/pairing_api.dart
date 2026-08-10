import '../../../core/network/api_client.dart';

/// Calls the CURRENT `PairingModule` endpoint directly — not the
/// deprecated `/auth/devices/pairing/initiate` the Admin Dashboard was
/// mistakenly calling until last session's critical fix. No repeat of
/// that bug here.
class PairingApi {
  PairingApi(this._client);

  final ApiClient _client;

  Future<Map<String, dynamic>> generateInviteCode(String childId) {
    return _client.post('/pairing/invite', data: {'childId': childId});
  }

  Future<void> registerPushToken(String platform, String pushToken) {
    return _client.post('/pairing/parent-device/push-token', data: {'platform': platform, 'pushToken': pushToken});
  }

  /// Sprint 1 (Consent Enforcement, Option C) — called once right
  /// after a new child is created, per that screen's own explicit
  /// registration copy. See ConsentService.grantDefaults's own
  /// docstring for exactly what this grants and why.
  Future<void> grantDefaultConsents(String childId) {
    return _client.post('/children/$childId/consents/grant-defaults');
  }
}
