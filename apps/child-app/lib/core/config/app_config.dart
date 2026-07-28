/// Build-time configuration, supplied via `--dart-define` at build/run time,
/// e.g.:
///   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1
///
/// `10.0.2.2` is the Android emulator's alias for the host machine's
/// `localhost` — NOT `localhost` itself, which inside the emulator refers
/// to the emulator, not the host running the backend.
class AppConfig {
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:3000/api/v1',
  );

  const AppConfig._();
}
