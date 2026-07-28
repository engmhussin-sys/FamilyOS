import '../../../core/network/api_client.dart';
import '../domain/pairing.types.dart';

/// Only the three endpoints from pairing-backend-domain-architecture.md's
/// §3 that the CHILD device itself calls — `invite`/`activate`/`reject`/
/// `revoke`/`status` are parent-initiated (Admin Dashboard's concern,
/// not this app's).
class PairingApi {
  PairingApi(this._apiClient);

  final ApiClient _apiClient;

  Future<RegistrationTicket> accept(String code) async {
    final response = await _apiClient.post(
      '/pairing/accept',
      body: {'code': code},
      skipAuth: true,
    );
    return RegistrationTicket(
      token: response['token'] as String,
      expiresInSeconds: response['expiresInSeconds'] as int,
    );
  }

  Future<DeviceRegistrationResult> registerDevice({
    required String registrationToken,
    required String publicKey,
    required String platform,
    String? deviceModel,
    String? osVersion,
    String? appVersion,
    String? pairingProtocolVersion,
  }) async {
    final response = await _apiClient.postWithBearerToken(
      '/pairing/device/register',
      registrationToken,
      body: {
        'publicKey': publicKey,
        'platform': platform,
        if (deviceModel != null) 'deviceModel': deviceModel,
        if (osVersion != null) 'osVersion': osVersion,
        if (appVersion != null) 'appVersion': appVersion,
        if (pairingProtocolVersion != null) 'pairingProtocolVersion': pairingProtocolVersion,
      },
    );

    final tokens = response['tokens'] as Map<String, dynamic>;
    return DeviceRegistrationResult(
      deviceId: response['deviceId'] as String,
      accessToken: tokens['accessToken'] as String,
      refreshToken: tokens['refreshToken'] as String,
    );
  }

  /// Fire-and-forget from the caller's perspective — HeartbeatService
  /// owns retry/failure handling, not this method.
  Future<void> heartbeat({int? batteryPercent, bool? isConnected}) async {
    await _apiClient.post('/pairing/device/heartbeat', body: {
      if (batteryPercent != null) 'batteryPercent': batteryPercent,
      if (isConnected != null) 'isConnected': isConnected,
    });
  }

  /// Sprint 4 — sends the Full Capability Engine's report. Field names
  /// match report-capabilities.dto.ts exactly.
  Future<void> reportCapabilities(Map<Object?, Object?> report) async {
    await _apiClient.post('/pairing/device/capabilities', body: {
      'manufacturer': report['manufacturer'],
      'model': report['model'],
      'sdkInt': report['sdkInt'],
      'usageAccessGranted': report['usageAccessGranted'],
      'accessibilityEnabled': report['accessibilityEnabled'],
      'overlayGranted': report['overlayGranted'],
      'batteryOptimizationExempted': report['batteryOptimizationExempted'],
      'notificationsGranted': report['notificationsGranted'],
      'profileHash': report['profileHash'],
    });
  }

  /// Sprint 4 — Policy Sync.
  Future<Map<String, dynamic>> getPolicy() async {
    return _apiClient.get('/pairing/device/policy');
  }
}
