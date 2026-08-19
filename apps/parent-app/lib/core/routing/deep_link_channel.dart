import 'package:flutter/services.dart';

/// THE PLATFORM SIDE OF `abny://` — a URI in from Android, nothing else.
///
/// WHAT WAS MISSING. `AndroidManifest.xml` declares `<data android:scheme="abny">`
/// so the OS resolves an external `abny://…` link to this app, and
/// `MainActivity.kt` hands the URI to this channel. Until both existed, a link
/// tapped OUTSIDE the app (a browser, a message, an e-mail) resolved to no app
/// at all; in-app taps worked only because the link travels on the FCM `data`
/// payload and never went near the OS.
///
/// THIS FILE PARSES NOTHING AND ROUTES NOTHING. It carries a string across the
/// language boundary and stops. `parseDeepLink` (deep_link.dart) is the one
/// parser and `DeepLinkRouter` (deep_link_router.dart) is the one map; a second
/// opinion here would be the exact drift those two files exist to prevent.
///
/// THE NAMES MATCH `DeepLinkChannel.kt` BY CONSTANT, NOT BY LITERAL. There is no
/// compile-time link across the boundary, so a typo would be a silent runtime
/// failure that appears only on a device — the link arriving at the process and
/// never reaching Dart.
class DeepLinkChannel {
  const DeepLinkChannel._();

  /// Must equal `DeepLinkChannel.CHANNEL_NAME` in
  /// `android/app/src/main/kotlin/com/aifamilycoach/parent_app/DeepLinkChannel.kt`.
  static const String channelName = 'com.aifamilycoach.parent_app/deep_link';

  /// Dart -> native, once at startup: the URI this process was launched for.
  static const String methodConsumeInitialLink = 'consumeInitialLink';

  /// Native -> Dart: a link that arrived while the app was already running.
  static const String methodOnDeepLink = 'onDeepLink';

  static const MethodChannel _channel = MethodChannel(channelName);

  /// THE COLD-START LINK, or `null` when this launch was not a link.
  ///
  /// CONSUMING, not polling: the native side clears its copy on the first
  /// answer, so a hot restart cannot re-navigate to a link the parent followed
  /// minutes ago.
  ///
  /// A BARE `catch` AND NOT `on PlatformException`, deliberately. The failure
  /// that actually happens here is [MissingPluginException] — every widget test
  /// in this repository runs without a native side, and so does any future iOS
  /// build until this channel is implemented there. Neither is an error worth
  /// crashing a cold start over: no link is the normal case, and `null` says
  /// exactly that.
  static Future<String?> consumeInitialLink() async {
    try {
      return await _channel.invokeMethod<String>(methodConsumeInitialLink);
    } catch (_) {
      return null;
    }
  }

  /// Registers [onLink] for every link that arrives while the app is alive
  /// (`onNewIntent` on the native side). Replaces any previous handler — there
  /// is one listener in this app and it is [DeepLinkHost].
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

  /// Drops the handler. Called when the listener is disposed, so a link can
  /// never be delivered into a widget that is gone.
  static void stopListening() {
    _channel.setMethodCallHandler(null);
  }
}
