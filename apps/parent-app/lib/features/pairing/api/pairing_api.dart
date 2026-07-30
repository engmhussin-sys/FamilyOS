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
}
