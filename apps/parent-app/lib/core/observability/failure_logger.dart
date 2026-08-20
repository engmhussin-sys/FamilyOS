import 'dart:developer' as developer;

import 'package:sentry_flutter/sentry_flutter.dart';

import '../errors/api_failure.dart';

/// WHERE THE REAL ERROR GOES WHEN THE SCREEN STOPS SHOWING IT.
///
/// `ApiFailure.from` deliberately replaces a transport's own English wording
/// with a reviewed Arabic sentence before it can reach a parent. That is only
/// defensible if the original still lands somewhere an engineer can read it —
/// otherwise the app trades "the parent saw a stack trace" for "nobody can
/// ever explain why the screen failed", which is the worse of the two.
///
/// This is that somewhere. One narrow interface, so:
///   * production sends the original exception AND its stack trace to the
///     crash reporter that `bootstrapWithCrashReporting` already installs —
///     no second SDK, no second DSN;
///   * a widget test can pass [RecordingFailureLogger] and assert that the
///     diagnostic really was preserved, which is the only way to keep this
///     promise honest over time.
abstract class FailureLogger {
  /// [error] is the ORIGINAL object — an `ApiException` carrying the wire
  /// body, not the sanitised [ApiFailure]. [failure] is the converted view,
  /// carried alongside because its `logLine` already assembles the
  /// correlation fields (`requestId`, `statusCode`, `code`).
  void record(
    Object error,
    StackTrace stackTrace, {
    required String operation,
    required ApiFailure failure,
  });
}

/// The production sink: the crash reporter, plus a local structured log.
///
/// NOT `print`. `developer.log` is the SDK's own structured logging call —
/// it is what shows up in `flutter logs` and in the IDE's log view with the
/// error and stack attached as first-class fields, and it is a no-op in a
/// release build's stripped VM service. Nothing here is debug scaffolding to
/// be removed later; a failed API call is exactly what an observability
/// layer exists to see.
class SentryFailureLogger implements FailureLogger {
  const SentryFailureLogger();

  static const String logName = 'abny.api';

  @override
  void record(
    Object error,
    StackTrace stackTrace, {
    required String operation,
    required ApiFailure failure,
  }) {
    developer.log(
      '$operation failed — ${failure.logLine}',
      name: logName,
      error: error,
      stackTrace: stackTrace,
    );
    // Fire-and-forget, and guarded: an observability path must never be the
    // reason a request's error handling itself throws. With no DSN
    // configured (see crash_reporting.dart) this is already a no-op.
    try {
      Sentry.captureException(error, stackTrace: stackTrace);
    } catch (_) {
      // Reporting the failure to report a failure helps nobody.
    }
  }
}

/// Test double. Keeps every call so a test can assert that the raw text
/// survived the sanitisation that the UI depends on.
class RecordingFailureLogger implements FailureLogger {
  final List<RecordedFailure> records = <RecordedFailure>[];

  @override
  void record(
    Object error,
    StackTrace stackTrace, {
    required String operation,
    required ApiFailure failure,
  }) {
    records.add(RecordedFailure(
      error: error,
      stackTrace: stackTrace,
      operation: operation,
      failure: failure,
    ));
  }
}

class RecordedFailure {
  const RecordedFailure({
    required this.error,
    required this.stackTrace,
    required this.operation,
    required this.failure,
  });

  final Object error;
  final StackTrace stackTrace;
  final String operation;
  final ApiFailure failure;
}
