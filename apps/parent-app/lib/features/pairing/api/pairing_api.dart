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

  /// `POST /pairing/activate` — `PairingController.activate`, parent JWT,
  /// body `ActivateDto { deviceId, overrideRiskWarning? }`, answers 200.
  ///
  /// THE STEP NOTHING IN THIS APP USED TO TAKE. The orchestrator drives
  /// `PARENT_CONFIRMED -> POLICY_ASSIGNED -> DEVICE_ACTIVATED` and writes
  /// `Device.status = ACTIVE` in this one call, so without it a family's
  /// device registers, verifies, uploads its capabilities and then waits
  /// forever.
  ///
  /// `overrideRiskWarning` IS DELIBERATELY NOT SENT, and it is not a
  /// forgotten parameter. `PairingOrchestratorService.activate` blocks a
  /// HIGH/CRITICAL-risk device with a bare
  /// `ConflictException('Device risk level is …')` that carries no `code`
  /// and no `messageAr`, so `GlobalExceptionFilter` shapes it with the
  /// generic 409 fallback from `error-catalogue.ts` — the SAME `code`
  /// (`CONFLICT`) and the SAME Arabic sentence as an already-activated
  /// device. There is therefore no server-authored wording for «this device
  /// looks risky» to put in front of a parent, and no field a client can
  /// read to tell the two 409s apart. Sending `overrideRiskWarning: true`
  /// from here would mean a parent overriding a risk decision they were
  /// never shown; a risk override is an informed decision or it is nothing.
  /// Left unimplemented, recorded as a backend gap.
  Future<Map<String, dynamic>> activateDevice(String deviceId) {
    return _client.post('/pairing/activate', data: {'deviceId': deviceId});
  }

  /// `GET /pairing/device/:deviceId/status` — `PairingController.getStatus`,
  /// family-scoped server-side. Returns
  /// `{pairingState, trustLevel, riskLevel, lastSeenAt, activationStatus}`.
  ///
  /// This is the only route that answers «is this device ready for its
  /// parent to confirm it?». `GET /pairing/devices` carries `Device.status`
  /// alone, which reads `PENDING_PAIRING` both for a device that has not
  /// uploaded its capabilities yet AND for one that is waiting on exactly
  /// this parent. Every value it returns is a raw enum and none of them is
  /// ever rendered: the caller maps them to a state and writes its own copy.
  Future<Map<String, dynamic>> getDeviceStatus(String deviceId) {
    return _client.get('/pairing/device/$deviceId/status');
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
