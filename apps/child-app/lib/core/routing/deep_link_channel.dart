import 'package:flutter/services.dart';

/// THE PLATFORM SIDE OF `abny://` — a URI in from Android, nothing else.
///
/// WHAT WAS MISSING. `AndroidManifest.xml` declares `<data android:scheme="abny">`
/// so the OS resolves an external `abny://…` link to this app, and
/// `MainActivity.kt` hands the URI to this channel. Until both existed, a link
/// tapped OUTSIDE the app resolved to no app at all — and in this app the gap
/// was wider than in the parent's, because the child app has no push DELIVERY
/// yet either (FCM token acquisition is deliberately unbuilt), so the ONLY way
/// a link could reach it was an in-app message card.
///
/// THIS FILE PARSES NOTHING AND ROUTES NOTHING. It carries a string across the
/// language boundary and stops. `parseDeepLink` (deep_link.dart) is the one
/// parser and `ChildDeepLinkRouter` is the one map — the very thing that
/// router's own header promises a future push handler will call rather than
/// re-implement.
///
/// THE NAMES MATCH `core/DeepLinkChannel.kt` BY CONSTANT, NOT BY LITERAL, for
/// the same reason `AgentChannelConstants` does it: nothing checks the two
/// sides against each other at compile time, so a typo is a silent runtime
/// failure that only appears on a device.
class DeepLinkChannel {
  const DeepLinkChannel._();

  /// Must equal `DeepLinkChannel.CHANNEL_NAME` in
  /// `android/app/src/main/kotlin/com/aifamilycoach/child_app/core/DeepLinkChannel.kt`.
  static const String channelName = 'com.aifamilycoach.child_app/deep_link';

  /// Dart -> native, once at startup: the URI this process was launched for.
  static const String methodConsumeInitialLink = 'consumeInitialLink';

  /// Native -> Dart: a link that arrived while the app was already running.
  static const String methodOnDeepLink = 'onDeepLink';

  static const MethodChannel _channel = MethodChannel(channelName);

  /// THE COLD-START LINK, or `null` when this launch was not a link.
  ///
  /// CONSUMING, not polling: the native side clears its copy on the first
  /// answer, so a hot restart cannot re-navigate to a link the child already
  /// followed.
  ///
  /// A BARE `catch` AND NOT `on PlatformException`, deliberately. The failure
  /// that actually happens here is [MissingPluginException] — every widget test
  /// in this repository runs without a native side. No link is the normal case,
  /// and `null` says exactly that; a cold start must not die on it.
  static Future<String?> consumeInitialLink() async {
    try {
      return await _channel.invokeMethod<String>(methodConsumeInitialLink);
    } catch (_) {
      return null;
    }
  }

  /// Registers [onLink] for every link that arrives while the app is alive
  /// (`onNewIntent` on the native side). Replaces any previous handler — there
  /// is one listener in this app and it is `_AppRoot`.
  static void listen(void Function(String link) onLink) {
    _channel.setMethodCallHandler((call) async {
      if (call.method != methodOnDeepLink) return null;
      final Object? argument = call.arguments;
      if (argument is String && argument.trim().isNotEmpty) {
        onLink(argument);
      }
      return null;
    });
  }

  /// Drops the handler, so a link can never be delivered into a widget that is
  /// gone.
  static void stopListening() {
    _channel.setMethodCallHandler(null);
  }
}
