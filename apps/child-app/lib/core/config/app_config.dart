import 'package:flutter/foundation.dart' show debugPrint, kReleaseMode;

/// Build-time configuration. Supplied via `--dart-define`, never read from
/// a checked-in file, so the same source tree can produce a dev APK and a
/// production APK with no code change.
///
/// THE CONTRACT (audit MA-004 — the fix that turns "installs" into "works")
/// ------------------------------------------------------------------------
///   --dart-define=API_BASE_URL=<absolute base URL, including /api/v1>
///
/// Debug default: `http://10.0.2.2:3000/api/v1`.
///   `10.0.2.2` is the Android emulator's alias for the HOST machine's
///   loopback — NOT `localhost`, which inside the emulator means the
///   emulator itself. This default is permitted in cleartext ONLY by
///   `android/app/src/debug/res/xml/network_security_config.xml`, which
///   exists only in debug builds.
///
/// Release: there is no usable default, on purpose. [assertUsableForBuildMode]
/// refuses to let a release build start against a non-HTTPS URL, so a
/// release APK can never silently ship pointing at a developer's laptop —
/// which is the failure this file exists to make impossible. That check is
/// loud by design: a release build with the wrong base URL is 100%
/// non-functional anyway, and a crash naming the cause on the first
/// internal-testing install is strictly better than a store listing whose
/// every screen shows a network error.
///
/// Reaching a backend from a REAL DEVICE:
///   adb reverse tcp:3000 tcp:3000
///   flutter run --dart-define=API_BASE_URL=http://127.0.0.1:3000/api/v1
/// (127.0.0.1 is in the debug allow-list, so no per-machine LAN IP has to
/// be hard-coded anywhere.)
class AppConfig {
  const AppConfig._();

  /// The one and only knob. Keep the name in sync with
  /// `.github/workflows/build-apk.yml` and with the parent app.
  static const String apiBaseUrlDefine = 'API_BASE_URL';

  static const String debugDefaultApiBaseUrl = 'http://10.0.2.2:3000/api/v1';

  static const String apiBaseUrl = String.fromEnvironment(
    apiBaseUrlDefine,
    defaultValue: debugDefaultApiBaseUrl,
  );

  /// F2 (Play policy, audit risk R5). The prominent-disclosure screen
  /// offers a link to the full privacy policy. There is no published
  /// policy URL yet, so the default is EMPTY and the screen simply omits
  /// the link rather than showing a dead one. A published URL is a hard
  /// prerequisite for store submission — see
  /// docs/release/PLAY_POLICY_DECLARATION.md.
  ///
  ///   --dart-define=PRIVACY_POLICY_URL=https://.../privacy
  static const String privacyPolicyUrl = String.fromEnvironment(
    'PRIVACY_POLICY_URL',
    defaultValue: '',
  );

  /// Hosts the debug network security config permits in cleartext. Kept
  /// here as well as in the XML because these two lists MUST agree: a URL
  /// this app is willing to use over http:// but the platform refuses to
  /// send is precisely MA-004's failure mode, just moved one layer up.
  static const List<String> cleartextDevHosts = <String>[
    '10.0.2.2',
    '10.0.3.2',
    '127.0.0.1',
    'localhost',
    'abny-dev.local',
  ];

  static bool get isCleartext => apiBaseUrl.startsWith('http://');

  /// Host portion of [apiBaseUrl], or an empty string if it is unparseable.
  static String get apiHost => Uri.tryParse(apiBaseUrl)?.host ?? '';

  /// `null` when the configuration is coherent for the current build mode;
  /// otherwise a human-readable reason. Split out from
  /// [assertUsableForBuildMode] so a diagnostics screen can DISPLAY the
  /// problem without throwing.
  static String? configurationError() {
    final uri = Uri.tryParse(apiBaseUrl);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
      return 'API_BASE_URL is not an absolute URL: "$apiBaseUrl"';
    }
    if (kReleaseMode && uri.scheme != 'https') {
      return 'Release builds must use https. Got "$apiBaseUrl". '
          'Pass --dart-define=$apiBaseUrlDefine=https://<host>/api/v1.';
    }
    if (!kReleaseMode && isCleartext && !cleartextDevHosts.contains(uri.host)) {
      return 'Cleartext http:// is only permitted for ${cleartextDevHosts.join(", ")} '
          'by android/app/src/debug/res/xml/network_security_config.xml. '
          'Host "${uri.host}" would be blocked by the platform at runtime.';
    }
    return null;
  }

  /// Call FIRST in `main()`, before any Sentry/zone setup, so the message
  /// reaches the console and the crash is attributable.
  ///
  /// In debug this only ever *warns* (via [debugPrint]) — a developer
  /// mid-setup should get a clear message, not a dead app. In release a
  /// bad value throws, because there is no recovery from it and no user
  /// benefit in launching.
  static void assertUsableForBuildMode() {
    final error = configurationError();
    if (error == null) return;
    if (kReleaseMode) {
      throw StateError('AppConfig: $error');
    }
    debugPrint('AppConfig WARNING: $error');
  }
}
