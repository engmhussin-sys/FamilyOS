import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/pairing_api.dart';

/// THE CHILD DEVICE'S HALF OF PUSH DELIVERY — the ABNY side of it, and only
/// that side.
///
/// `POST /api/v1/pairing/device/push-token` shipped complete (device JWT,
/// `@ChildSurface`, throttled 10/min, one-field body) with no Flutter
/// consumer at all, which meant the child half of the Smart Notification
/// Engine could never deliver anything: the server had nowhere to send to.
/// This class is that consumer.
///
/// ---------------------------------------------------------------------------
/// WHERE THE TOKEN COMES FROM — NOT IMPLEMENTED HERE, AND NOT OWNED HERE.
///
/// Token ACQUISITION (FCM initialisation, `getToken()`, `onTokenRefresh`,
/// the Firebase project configuration and the native `FirebaseMessagingService`)
/// belongs to the FCM/push-delivery workstream, not to this file. The child
/// app declares no `firebase_messaging` dependency and this class deliberately
/// does not add one, does not touch a platform channel, and does not invent a
/// token of its own: there is no fake, no placeholder and no default value
/// anywhere below, because a fabricated token is a token the server would
/// accept and then deliver nothing to, forever, with no error anywhere.
///
/// The token therefore ARRIVES FROM OUTSIDE, as the single argument to
/// [onTokenAvailable]. Whoever owns acquisition calls it — once when a token
/// first exists and again from every refresh callback. Until that call site
/// exists this class is correct, tested and dormant, which is the honest
/// state of a half whose other half is another workstream's.
/// ---------------------------------------------------------------------------
///
/// IDEMPOTENT FROM THE APP'S SIDE. The server is idempotent too (it updates
/// one row by primary key), but that is not a reason to spend a request:
/// `onTokenRefresh` fires on every cold start on some devices, and this route
/// is throttled 10/min. So the last token this device successfully registered
/// is persisted, and an unchanged token is not sent again — across restarts,
/// not merely within one process lifetime.
///
/// A FAILED SEND IS NOT RECORDED. [_lastSentKey] is written only after the
/// call returns, so a token that failed to reach the server is re-sent at the
/// next opportunity rather than being remembered as delivered.
class PushTokenRegistrationService {
  PushTokenRegistrationService(this._pairingApi, this._storage);

  final PairingApi _pairingApi;
  final FlutterSecureStorage _storage;

  /// Same store as the device's own session material (Decision-012) — this
  /// value identifies a specific child's device to a push provider, so it
  /// does not belong in plain SharedPreferences beside a UI preference.
  static const String _lastSentKey = 'last_registered_push_token';

  /// In-process memo of [_lastSentKey], so a burst of refresh callbacks in one
  /// session does not turn into a burst of secure-storage reads.
  String? _lastSent;
  bool _lastSentLoaded = false;

  /// Registers [token] with the backend unless this device has already
  /// registered exactly this token.
  ///
  /// Returns `true` when a request was actually sent. An empty or
  /// whitespace-only token is ignored and returns `false`: `@MinLength(1)`
  /// on the DTO would 400 it, and there is nothing a child or a parent could
  /// do about that error, so it is not worth making one.
  ///
  /// Errors are NOT swallowed. The caller (the FCM workstream) decides
  /// whether to retry, because only it knows whether it still holds the
  /// token; silently eating a failure here would produce a device that
  /// believes it is registered and never receives anything.
  Future<bool> onTokenAvailable(String token) async {
    final trimmed = token.trim();
    if (trimmed.isEmpty) return false;

    if (!_lastSentLoaded) {
      _lastSent = await _storage.read(key: _lastSentKey);
      _lastSentLoaded = true;
    }
    if (_lastSent == trimmed) return false;

    await _pairingApi.registerPushToken(trimmed);

    _lastSent = trimmed;
    await _storage.write(key: _lastSentKey, value: trimmed);
    return true;
  }

  /// Forgets what was last registered, so the next token — even an identical
  /// one — is sent again.
  ///
  /// Call this when the device session ends (revocation, re-pairing): the new
  /// pairing is a different `Device` row server-side even if FCM hands the app
  /// back the very same token string, and a remembered token would then be
  /// suppressed for a row that never received it.
  Future<void> forgetLastRegisteredToken() async {
    _lastSent = null;
    _lastSentLoaded = true;
    await _storage.delete(key: _lastSentKey);
  }
}
