import '../observability/failure_logger.dart';
import 'api_failure.dart';

/// THE ONE `try`/`catch` EVERY REPOSITORY IN THIS APP SHARES.
///
/// `LifeIntelligenceRepository` established the shape when the ten Life
/// Intelligence screens stopped ending their `_load()` with
/// `_errorMessage = e.toString()`: catch everything, hand the ORIGINAL
/// object and its stack to a [FailureLogger] first, then rethrow the
/// sanitised [ApiFailure]. Four more repositories were about to copy those
/// eight lines verbatim, and four copies of an error boundary is four places
/// for one of them to quietly stop logging.
///
/// TWO PROPERTIES, AND BOTH MATTER:
///
///   1. Nothing above this line sees the raw error. `ApiFailure.from` is the
///      conversion that turns a transport's own English — «The request
///      returned an invalid status code of 502» — into a reviewed Arabic
///      sentence, and it happens HERE so no screen has to remember to call
///      it.
///   2. Nothing below this line loses it either. The logger receives the
///      untouched exception WITH its stack trace before the conversion runs,
///      and `ApiFailure.diagnostic` carries the original text onward for the
///      log line. Replacing a sentence is only defensible while the original
///      still reaches somewhere an engineer can read it.
///
/// It catches `Object`, not `ApiException`: a backend that renames a field
/// turns into a `TypeError` inside a cast, and a parent must not read that
/// either.
///
/// `LifeIntelligenceRepository` keeps its own private copy of this rather
/// than being rewritten onto it. That file and its tests were verified in a
/// separate change; re-cutting it to save eight lines would put a
/// just-checked file back at risk for no behavioural gain.
class FailureBoundary {
  const FailureBoundary([this.logger = const SentryFailureLogger()]);

  final FailureLogger logger;

  /// [operation] is the NAME of the call, so a log line says which one
  /// failed. It is never localised and never shown.
  Future<T> guard<T>(String operation, Future<T> Function() call) async {
    try {
      return await call();
    } catch (error, stackTrace) {
      final failure = ApiFailure.from(error);
      logger.record(error, stackTrace, operation: operation, failure: failure);
      throw failure;
    }
  }
}
