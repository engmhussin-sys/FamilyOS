/// Mirrors child-app's ApiException shape — a normalized error the UI
/// layer can display without knowing about Dio/HTTP specifics.
class ApiException implements Exception {
  ApiException(this.message, {this.statusCode, this.correlationId});

  final String message;
  final int? statusCode;
  /// Threaded through from the backend's `GlobalExceptionFilter`
  /// (Sprint 9) — shown in error UI so a support request can reference
  /// it, matching that filter's own stated purpose.
  final String? correlationId;

  @override
  String toString() => message;
}
