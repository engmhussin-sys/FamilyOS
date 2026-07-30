import '../../../core/network/api_client.dart';

class AuthApi {
  AuthApi(this._client);

  final ApiClient _client;

  Future<Map<String, dynamic>> login({required String email, required String password}) {
    return _client.post('/auth/login', data: {'email': email, 'password': password}, skipAuth: true);
  }

  Future<Map<String, dynamic>> register({
    required String fullName,
    required String email,
    required String password,
  }) {
    return _client.post(
      '/auth/register',
      data: {'fullName': fullName, 'email': email, 'password': password},
      skipAuth: true,
    );
  }

  Future<void> logout(String refreshToken) {
    return _client.post('/auth/logout', data: {'refreshToken': refreshToken});
  }
}
