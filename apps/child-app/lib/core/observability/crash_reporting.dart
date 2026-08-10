import 'package:flutter/foundation.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

/// Sprint 4 (Observability) — same gap closure and same honest DSN
/// limitation as apps/parent-app/lib/core/observability/crash_reporting.dart.
/// See that file's own docstring for the full reasoning; not repeated
/// here verbatim to avoid two copies drifting out of sync in meaning
/// (though the actual DSN configuration IS necessarily separate per
/// app, since each app is its own Sentry project).
const String _sentryDsn = String.fromEnvironment('SENTRY_DSN', defaultValue: '');

Future<void> bootstrapWithCrashReporting(Future<void> Function() runAppFn) async {
  await SentryFlutter.init(
    (options) {
      options.dsn = _sentryDsn;
      options.tracesSampleRate = 1.0;
      options.environment = kReleaseMode ? 'production' : 'development';
    },
    appRunner: runAppFn,
  );
}
