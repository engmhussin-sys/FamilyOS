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

  /// PHASE C — the client half of the Firebase decoupling in
  /// `android/app/build.gradle`. When the Gradle build ran without a real
  /// `google-services.json`, `Firebase.initializeApp()` threw and the catch
  /// below swallowed it — correct behaviour, but indistinguishable in the
  /// logs from a genuine Firebase outage. This flag makes the two states
  /// legible to whoever reads a crash report or a CI job summary.
  ///
  /// Pass `--dart-define=ENABLE_PUSH=false` on a build that was deliberately
  /// produced without Firebase config. DEFAULT IS TRUE: nothing about the
  /// normal build changes, and no existing behaviour is removed.
  static const bool pushEnabled =
      bool.fromEnvironment('ENABLE_PUSH', defaultValue: true);

  Future<void> initializeAndRegister() async {
    if (!pushEnabled) {
      debugPrint(
        'PushRegistrationService: disabled by --dart-define=ENABLE_PUSH=false. '
        'This build has no Firebase Cloud Messaging: no FCM token is requested, '
        '/pairing/parent-device/push-token is never called, and no parent push '
        'notification can be delivered to this device. Everything else works.',
      );
      return;
    }
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
