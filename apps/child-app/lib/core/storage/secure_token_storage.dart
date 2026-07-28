import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persists the device's own access/refresh token pair (issued by
/// `POST /auth/devices/pairing/confirm`, actorType: DEVICE — see
/// apps/backend/src/modules/auth/domain/auth.types.ts) in Android's
/// Keystore-backed encrypted storage.
///
/// Unlike the Admin Dashboard's tokenStorage.ts (which deliberately keeps
/// the access token in memory only, per its documented XSS mitigation),
/// the Child Agent has no browser/XSS threat model — it's a single native
/// app. Both tokens are stored here, encrypted at rest by the OS Keystore.
class SecureTokenStorage {
  SecureTokenStorage(this._storage);

  final FlutterSecureStorage _storage;

  static const _accessTokenKey = 'afdc.device.accessToken';
  static const _refreshTokenKey = 'afdc.device.refreshToken';
  static const _deviceIdKey = 'afdc.device.id';

  Future<String?> getAccessToken() => _storage.read(key: _accessTokenKey);
  Future<String?> getRefreshToken() => _storage.read(key: _refreshTokenKey);
  Future<String?> getDeviceId() => _storage.read(key: _deviceIdKey);

  Future<void> saveSession({
    required String accessToken,
    required String refreshToken,
    required String deviceId,
  }) async {
    await _storage.write(key: _accessTokenKey, value: accessToken);
    await _storage.write(key: _refreshTokenKey, value: refreshToken);
    await _storage.write(key: _deviceIdKey, value: deviceId);
  }

  Future<void> updateAccessToken(String accessToken) =>
      _storage.write(key: _accessTokenKey, value: accessToken);

  Future<void> updateRefreshToken(String refreshToken) =>
      _storage.write(key: _refreshTokenKey, value: refreshToken);

  Future<bool> hasSession() async => (await getRefreshToken()) != null;

  Future<void> clear() async {
    await _storage.delete(key: _accessTokenKey);
    await _storage.delete(key: _refreshTokenKey);
    await _storage.delete(key: _deviceIdKey);
  }

  /// Used when the refresh token is rejected (session truly dead) but we
  /// still want to remember which physical device this was, so a future
  /// re-pairing flow / support diagnostics can reference it. Full
  /// `clear()` (including deviceId) is reserved for an explicit
  /// "un-pair this device" user action, not silent session expiry.
  Future<void> clearSessionButKeepDeviceId() async {
    await _storage.delete(key: _accessTokenKey);
    await _storage.delete(key: _refreshTokenKey);
  }
}
