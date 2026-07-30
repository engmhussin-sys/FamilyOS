import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// USER-actor session storage — the Parent App's equivalent of
/// child-app's `SecureTokenStorage`, holding a parent's access/refresh
/// token pair instead of a device's. Kept as a distinct class (not a
/// shared package) since these two apps are separate Flutter projects
/// with separate release cycles — sharing this one small class isn't
/// worth a monorepo-internal package dependency yet.
class SecureSessionStorage {
  SecureSessionStorage(this._storage);

  final FlutterSecureStorage _storage;

  static const _accessTokenKey = 'parent_access_token';
  static const _refreshTokenKey = 'parent_refresh_token';

  Future<void> saveTokens({required String accessToken, required String refreshToken}) async {
    await _storage.write(key: _accessTokenKey, value: accessToken);
    await _storage.write(key: _refreshTokenKey, value: refreshToken);
  }

  Future<String?> getAccessToken() => _storage.read(key: _accessTokenKey);
  Future<String?> getRefreshToken() => _storage.read(key: _refreshTokenKey);

  Future<void> clear() async {
    await _storage.delete(key: _accessTokenKey);
    await _storage.delete(key: _refreshTokenKey);
  }

  Future<bool> hasSession() async => (await getAccessToken()) != null;
}
