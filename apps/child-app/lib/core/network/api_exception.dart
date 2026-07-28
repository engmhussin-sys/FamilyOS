/// Thrown by [ApiClient] for any non-2xx response. Mirrors the shape of
/// admin-dashboard's ApiError (src/shared/lib/httpClient.ts) for
/// architectural consistency across both clients of the same backend.
class ApiException implements Exception {
  ApiException(this.message, this.statusCode);

  final String message;
  final int statusCode;

  @override
  String toString() => 'ApiException($statusCode): $message';
}
