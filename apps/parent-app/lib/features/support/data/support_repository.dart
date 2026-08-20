import '../../../core/errors/failure_boundary.dart';
import '../../../core/observability/failure_logger.dart';
import '../api/support_api.dart';

/// THE BOUNDARY IN FRONT OF THE SCREEN A PARENT REACHES WHEN SOMETHING IS
/// ALREADY WRONG.
///
/// `ContactSupportScreen` ended with `catch (e) { _errorMessage =
/// e.toString(); }`, so the one screen whose whole purpose is "tell us what
/// broke" answered its own failure with the transport's English sentence.
/// That is the worst place in the app to show one: the parent is already
/// stuck, and the app hands them a second thing they cannot act on.
///
/// The conversion and the log now happen here, which also means the support
/// request that failed to send has a `requestId` in the crash reporter — the
/// value the support engineer would otherwise have asked the parent for.
class SupportRepository {
  SupportRepository(this._api, {FailureLogger? logger})
      : _boundary = FailureBoundary(logger ?? const SentryFailureLogger());

  final SupportApi _api;
  final FailureBoundary _boundary;

  Future<void> submitRequest({
    required String email,
    required String subject,
    required String message,
    String? familyId,
    String? userId,
  }) =>
      _boundary.guard(
        'submitSupportRequest',
        () => _api.submitRequest(
          email: email,
          subject: subject,
          message: message,
          familyId: familyId,
          userId: userId,
        ),
      );
}
