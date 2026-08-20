import '../../../core/errors/failure_boundary.dart';
import '../../../core/observability/failure_logger.dart';
import '../api/account_api.dart';

/// THE BOUNDARY IN FRONT OF THE MOST DESTRUCTIVE CALL IN THE APP.
///
/// `DeleteAccountScreen` used to call [AccountApi] directly and end with
/// `catch (e) { _errorMessage = e.toString(); }`, which put the transport's
/// own sentence — HTTP status code and all — inside a red box on the screen
/// where a parent is deciding whether their family's data still exists.
///
/// One method, and it is deliberately not "thin plus convenience": the only
/// thing this adds is the conversion and the log, because the ONE property
/// this screen needs from its error is a property of the failure, not of the
/// response body (`ApiFailure.isServerRefusal` — did the server actually
/// refuse, or did we simply never hear back).
class AccountRepository {
  AccountRepository(this._api, {FailureLogger? logger})
      : _boundary = FailureBoundary(logger ?? const SentryFailureLogger());

  final AccountApi _api;
  final FailureBoundary _boundary;

  /// Throws [ApiFailure] on any failure — never an `ApiException`, never a
  /// `TypeError`. A caller that completes normally may treat the account as
  /// deleted; anything else is a throw it must handle.
  Future<void> deleteAccount(String currentPassword) =>
      _boundary.guard('deleteAccount', () => _api.deleteAccount(currentPassword));
}
