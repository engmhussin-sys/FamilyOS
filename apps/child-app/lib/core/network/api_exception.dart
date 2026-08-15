/// Thrown by [ApiClient] for any non-2xx response. Mirrors the shape of
/// admin-dashboard's ApiError (src/shared/lib/httpClient.ts) for
/// architectural consistency across both clients of the same backend.
///
/// B6 EXTENSION — THE B3 GLOBAL ERROR CONTRACT.
/// The POSITIONAL `(message, statusCode)` signature is kept EXACTLY as it
/// was: every existing call site and every existing test constructs it that
/// way, and this class is not the place to make them all churn. Everything
/// B3 added is an optional NAMED parameter after it.
///
/// This is the class that decides what a CHILD reads when the server says
/// no. Before B6 the answer was the English string NestJS derives from an
/// exception class name — a child who hit their daily limit read
/// `"Conflict Exception"`. After B6 they read the sentence F4 actually
/// wrote for them: «أكملت هذا البرنامج مرة اليوم — نراك غدًا!».
class ApiException implements Exception {
  ApiException(
    this.message,
    this.statusCode, {
    this.code,
    this.messageAr,
    this.details,
    this.requestId,
  });

  final String message;
  final int statusCode;

  /// B3 `code` — the stable machine identifier (`MAX_PER_DAY_REACHED`,
  /// `ATTEMPT_ALREADY_OPEN`, `NOT_YOUR_ACHIEVEMENT`, …). UI branches on
  /// this, never on the human sentence.
  final String? code;

  /// B3 `messageAr` — the Arabic, non-punitive sentence.
  final String? messageAr;

  /// B3 `details` — `{fields}` for DTO failures, `{errors:[…]}` for the
  /// domain validators.
  final Map<String, dynamic>? details;

  /// B3 `requestId` — same value as `correlationId`; the id a support
  /// ticket quotes.
  final String? requestId;

  @override
  String toString() => 'ApiException($statusCode): $message';
}
