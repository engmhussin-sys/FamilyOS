import '../../../core/network/api_client.dart';

class SettingsApi {
  SettingsApi(this._client);

  final ApiClient _client;

  Future<Map<String, dynamic>> getProfile() => _client.get('/profile');
  Future<Map<String, dynamic>> updateProfile(Map<String, dynamic> input) => _client.patch('/profile', data: input);
}
