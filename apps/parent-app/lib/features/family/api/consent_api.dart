import '../../../core/network/api_client.dart';

/// Sprint 1 (Consent Enforcement) — calls the real, already-built
/// `/children/:childId/consents` endpoints (compliance module).
class ConsentApi {
  ConsentApi(this._client);

  final ApiClient _client;

  Future<List<dynamic>> listConsents(String childId) async {
    final result = await _client.get('/children/$childId/consents');
    return result['data'] as List<dynamic>;
  }

  Future<void> setConsent(String childId, String consentType, bool granted) {
    return _client.post('/children/$childId/consents', data: {'consentType': consentType, 'granted': granted});
  }
}
