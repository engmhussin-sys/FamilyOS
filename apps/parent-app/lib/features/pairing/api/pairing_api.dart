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

  /// `POST /pairing/revoke` — a real route on `PairingController`, the same
  /// one `apps/admin-dashboard/src/features/devices/api/devicesApi.ts`
  /// already calls. `RevokeDto` accepts `{deviceId, reason?}` and the route
  /// answers 204, so there is nothing to read back.
  ///
  /// KNOWN BACKEND CONSTRAINT, NOT A CLIENT BUG. `PAIRING_TRANSITIONS`
  /// (`pairing/domain/pairing-transitions.table.ts`) allows `DEVICE_REVOKED`
  /// only from `HEALTHY`, `DEGRADED` or `SUSPENDED`. A device that has just
  /// been activated but has not yet sent its first heartbeat is in
  /// `ACTIVATED`, so revoking inside that window answers 409
  /// (`InvalidPairingTransitionException`). The caller surfaces the
  /// server's own sentence rather than pretending the call succeeded.
  Future<void> revokeDevice(String deviceId, {String? reason}) async {
    await _client.post('/pairing/revoke', data: {
      'deviceId': deviceId,
      if (reason != null && reason.isNotEmpty) 'reason': reason,
    });
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
