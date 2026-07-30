/// Mirrors apps/child-app/lib/core/config/app_config.dart's shape —
/// same environment-variable-driven base URL pattern, different default
/// (this app never talks to device-scoped endpoints).
class AppConfig {
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://localhost:3000/api/v1',
  );
}
