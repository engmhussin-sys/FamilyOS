import '../../../core/network/api_client.dart';

/// Calls the real, already-built `/account` DELETE endpoint
/// (AccountDeletionService).
class AccountApi {
  AccountApi(this._client);

  final ApiClient _client;

  Future<void> deleteAccount(String currentPassword) {
    return _client.delete('/account', data: {'currentPassword': currentPassword});
  }
}
