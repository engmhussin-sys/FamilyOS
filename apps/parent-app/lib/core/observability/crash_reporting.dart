import 'package:flutter/foundation.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

/// Sprint 4 (Observability) — CLOSES A REAL GAP: before this, any
/// production crash in this app was invisible to the team except via
/// a user's own complaint. No crash reporting SDK existed at all.
///
/// HONEST LIMITATION, STATED PLAINLY: `_sentryDsn` below is EMPTY by
/// design — a real Sentry DSN requires a real Sentry account/project,
/// which is an external service this environment has no way to
/// create. With an empty DSN, `SentryFlutter.init` runs as a safe
/// no-op (Sentry's own documented behavior) — the app behaves exactly
/// as it did before this sprint, not broken, just not yet reporting.
/// To activate this: create a Sentry project, then either replace the
/// empty string below or (safer for a real team) pass it via
/// `--dart-define=SENTRY_DSN=...` at build time and read it with
/// `String.fromEnvironment('SENTRY_DSN')` instead of the hardcoded
/// empty string this starts with.
const String _sentryDsn = String.fromEnvironment('SENTRY_DSN', defaultValue: '');

/// Wraps [runApp] the way Sentry's own docs prescribe — catches
/// framework-level errors AND anything thrown inside the widget tree
/// during the app's lifetime, not just startup failures.
Future<void> bootstrapWithCrashReporting(Future<void> Function() runAppFn) async {
  await SentryFlutter.init(
    (options) {
      options.dsn = _sentryDsn;
      // 100% in development scale is fine; a real production rollout
      // at higher traffic would lower this (Sentry's own guidance) —
      // a tuning decision for whoever owns the Sentry project, not
      // something to guess at here.
      options.tracesSampleRate = 1.0;
      options.environment = kReleaseMode ? 'production' : 'development';
    },
    appRunner: runAppFn,
  );
}
