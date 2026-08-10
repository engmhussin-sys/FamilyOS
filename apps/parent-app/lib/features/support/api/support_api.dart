import '../../../core/network/api_client.dart';

/// Sprint 6 (Support) — calls the real, just-built `/support` endpoint
/// (public, no auth required). `skipAuth` isn't set explicitly here
/// since ApiClient attaches a bearer token automatically when a
/// session exists anyway (the backend simply ignores it for this
/// public endpoint) — no special-casing needed for the logged-in case.
class SupportApi {
  SupportApi(this._client);

  final ApiClient _client;

  Future<void> submitRequest({
    required String email,
    required String subject,
    required String message,
    String? familyId,
    String? userId,
  }) {
    return _client.post('/support', data: {
      'email': email,
      'subject': subject,
      'message': message,
      if (familyId != null) 'familyId': familyId,
      if (userId != null) 'userId': userId,
    });
  }
}
