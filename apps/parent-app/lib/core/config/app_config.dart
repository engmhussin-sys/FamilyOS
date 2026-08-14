import 'package:flutter/foundation.dart' show debugPrint, kReleaseMode;

/// Mirrors apps/child-app/lib/core/config/app_config.dart exactly — same
/// `--dart-define` name, same validation, same debug default. Read that
/// file's docstring for the full contract; only the differences are noted
/// here.
///
/// CHANGED IN F2 (audit MA-004): the previous default was
/// `http://localhost:3000/api/v1`, which is wrong on every Android target.
/// Inside an emulator or on a phone, `localhost` is the DEVICE itself, not
/// the machine running NestJS — so the parent app's default pointed at a
/// port nothing was listening on. It now matches the child app's
/// `10.0.2.2`, which is the emulator's alias for the host loopback and is
/// one of the hosts the debug network security config permits in
/// cleartext. Both apps therefore have one identical, working dev default.
class AppConfig {
  const AppConfig._();

  static const String apiBaseUrlDefine = 'API_BASE_URL';

  static const String debugDefaultApiBaseUrl = 'http://10.0.2.2:3000/api/v1';

  static const String apiBaseUrl = String.fromEnvironment(
    apiBaseUrlDefine,
    defaultValue: debugDefaultApiBaseUrl,
  );

  /// MUST stay in sync with
  /// android/app/src/debug/res/xml/network_security_config.xml.
  static const List<String> cleartextDevHosts = <String>[
    '10.0.2.2',
    '10.0.3.2',
    '127.0.0.1',
    'localhost',
    'abny-dev.local',
  ];

  static bool get isCleartext => apiBaseUrl.startsWith('http://');

  static String get apiHost => Uri.tryParse(apiBaseUrl)?.host ?? '';

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

  static void assertUsableForBuildMode() {
    final error = configurationError();
    if (error == null) return;
    if (kReleaseMode) {
      throw StateError('AppConfig: $error');
    }
    debugPrint('AppConfig WARNING: $error');
  }
}
