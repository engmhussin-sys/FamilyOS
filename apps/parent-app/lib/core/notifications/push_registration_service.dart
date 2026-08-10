import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../../features/pairing/api/pairing_api.dart';

/// Sprint 5 (Push Notifications), client half — completes the pipeline
/// this same sprint's backend half built (PushNotificationService,
/// `/pairing/parent-device/push-token`).
///
/// HONEST LIMITATION, STATED PLAINLY: `Firebase.initializeApp()`
/// requires `firebase_options.dart`, a file only the real
/// `flutterfire configure` CLI tool can generate — and that tool
/// needs a real Firebase project (a real external account this
/// environment cannot create), the same class of limitation as this
/// sprint's Sentry DSN and the backend's Firebase service account
/// credentials. `initializeAndRegister()` below catches and logs any
/// failure from a missing/misconfigured Firebase project rather than
/// crashing the app — push notifications simply stay unavailable
/// until a real Firebase project is wired up, exactly like Sentry's
/// own safe-no-op behavior this same sprint.
class PushRegistrationService {
  PushRegistrationService(this._pairingApi);

  final PairingApi _pairingApi;

  Future<void> initializeAndRegister() async {
    try {
      await Firebase.initializeApp();
    } catch (e) {
      debugPrint('Firebase.initializeApp() failed (expected until a real Firebase project is configured): $e');
      return;
    }

    final messaging = FirebaseMessaging.instance;
    final settings = await messaging.requestPermission();
    if (settings.authorizationStatus == AuthorizationStatus.denied) {
      return;
    }

    final token = await messaging.getToken();
    if (token == null) return;

    final platform = Platform.isIOS ? 'IOS' : 'ANDROID';
    try {
      await _pairingApi.registerPushToken(platform, token);
    } catch (_) {
      // Best-effort, matching every other non-critical background
      // sync call in this app.
    }

    FirebaseMessaging.instance.onTokenRefresh.listen((newToken) {
      _pairingApi.registerPushToken(platform, newToken).catchError((_) {});
    });
  }
}
