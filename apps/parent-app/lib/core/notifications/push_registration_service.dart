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

  /// G18 — whether `Firebase.initializeApp()` has actually succeeded in this
  /// process. Every notification-permission call needs this: touching
  /// `FirebaseMessaging.instance` before a successful init throws, and in this
  /// repository a failed init is the NORMAL case until a real Firebase project
  /// is wired up (there is no `firebase_options.dart`). Without this flag the UI
  /// would offer to enable notifications in a build that cannot deliver any.
  bool _firebaseReady = false;

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

    _firebaseReady = true;

    final messaging = FirebaseMessaging.instance;

    // G18 — WHY THERE IS NO UNCONDITIONAL requestPermission() HERE ANY MORE.
    //
    // This used to be `await messaging.requestPermission()`, and this method is
    // called from SplashScreen — so on Android 13+ the POST_NOTIFICATIONS
    // system dialog was put in front of the parent DURING COLD START, before
    // the app had shown them a single notification or explained what the
    // messages would be. Android shows that dialog at most twice ever; spent
    // that way, it is usually spent on a "deny" that cannot be undone in-app.
    //
    // The ask now happens where the value is visible — NotificationsScreen,
    // where the parent is looking at the very messages the permission governs —
    // through [requestPermissionAfterExplanation] below.
    //
    // iOS IS DELIBERATELY UNCHANGED. There, no APNS token is issued at all
    // until the user has authorised notifications, so skipping the request
    // would break token registration outright rather than merely move a dialog.
    // Nothing about the iOS path is weakened by this change.
    if (Platform.isIOS) {
      final settings = await messaging.requestPermission();
      if (settings.authorizationStatus == AuthorizationStatus.denied) {
        return;
      }
    }

    // On Android an FCM token IS issued without POST_NOTIFICATIONS: the
    // permission governs DISPLAY, not registration. Registering now means the
    // device is already reachable the moment the parent grants it later.
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

  /// G18 — the CURRENT permission state, read without showing any dialog.
  ///
  /// Used by NotificationsScreen to decide whether to offer the explanation at
  /// all. Returns [ParentNotificationPermissionState.unavailable] whenever this
  /// build has no working Firebase (disabled by dart-define, or
  /// `Firebase.initializeApp()` failed for want of `firebase_options.dart`) —
  /// in that state there is nothing to permit, because FCM is this app's ONLY
  /// notification channel, and prompting would be asking for a permission that
  /// could not be used.
  Future<ParentNotificationPermissionState> currentPermissionState() async {
    if (!pushEnabled || !_firebaseReady) {
      return ParentNotificationPermissionState.unavailable;
    }
    try {
      final settings = await FirebaseMessaging.instance.getNotificationSettings();
      return _mapStatus(settings.authorizationStatus);
    } catch (_) {
      return ParentNotificationPermissionState.unavailable;
    }
  }

  /// G18 — asks for the notification permission. CALL THIS ONLY AFTER THE VALUE
  /// HAS BEEN EXPLAINED, never on cold start: Android shows the dialog at most
  /// twice in the app's lifetime, and after the second decline the only route
  /// left is the phone's own settings screen.
  ///
  /// Also (re-)registers the token on success, so a parent who grants the
  /// permission long after login does not have to relaunch the app to become
  /// reachable.
  Future<ParentNotificationPermissionState> requestPermissionAfterExplanation() async {
    if (!pushEnabled || !_firebaseReady) {
      return ParentNotificationPermissionState.unavailable;
    }
    try {
      final settings = await FirebaseMessaging.instance.requestPermission();
      final state = _mapStatus(settings.authorizationStatus);
      if (state == ParentNotificationPermissionState.granted) {
        final token = await FirebaseMessaging.instance.getToken();
        if (token != null) {
          final platform = Platform.isIOS ? 'IOS' : 'ANDROID';
          try {
            await _pairingApi.registerPushToken(platform, token);
          } catch (_) {
            // Best-effort, like every other background sync in this app.
          }
        }
      }
      return state;
    } catch (_) {
      return ParentNotificationPermissionState.unavailable;
    }
  }

  static ParentNotificationPermissionState _mapStatus(AuthorizationStatus status) {
    switch (status) {
      case AuthorizationStatus.authorized:
      case AuthorizationStatus.provisional:
        return ParentNotificationPermissionState.granted;
      case AuthorizationStatus.notDetermined:
        return ParentNotificationPermissionState.notRequested;
      case AuthorizationStatus.denied:
        return ParentNotificationPermissionState.denied;
    }
  }
}

/// G18 — the parent app's notification permission state.
///
/// Coarser than the child app's `NotificationPermissionOutcome` on purpose: the
/// parent app reaches the permission through firebase_messaging rather than a
/// native channel of its own, and FCM's `AuthorizationStatus` cannot distinguish
/// "declined once" from "declined for good". Rather than invent that distinction,
/// [denied] covers both and the UI offers the settings route, which is correct in
/// either case.
enum ParentNotificationPermissionState {
  /// No usable Firebase in this build, so there is nothing to permit: FCM is
  /// this app's only notification channel. Prompting would ask for a permission
  /// that could not be used.
  unavailable,

  /// Notifications can be delivered.
  granted,

  /// Never asked. The dialog is still available.
  notRequested,

  /// Declined. Settings is the reliable route from here.
  denied,
}
