/// Mirrors child-app's ApiException shape — a normalized error the UI
/// layer can display without knowing about Dio/HTTP specifics.
///
/// B6 EXTENSION — THE B3 GLOBAL ERROR CONTRACT.
/// Before B6 this class carried `message` + `correlationId` only, so every
/// Arabic sentence the backend writes (`messageAr`) reached the wire and was
/// then discarded by the client — audit finding PA-M-002, whose backend half
/// B3 closed and whose CLIENT half is closed here.
///
/// The envelope B3 publishes is:
/// ```json
/// { "statusCode": 409, "requestId": "…", "correlationId": "…",
///   "code": "MAX_PER_DAY_REACHED",
///   "message": "This action has already been done…",
///   "messageAr": "أكملت هذا البرنامج مرة اليوم — نراك غدًا!",
///   "details": {} }
/// ```
/// Every field is ADDITIVE (B3 §2.3): existing consumers that read only
/// `message`/`correlationId` keep working unchanged, which is why the two
/// original fields below keep their exact original meaning and position.
class ApiException implements Exception {
  ApiException(
    this.message, {
    this.statusCode,
    this.correlationId,
    this.code,
    this.messageAr,
    this.details,
    this.requestId,
  });

  /// The English sentence. For a `string[]` body (the ValidationPipe's
  /// shape) the network layer joins it before constructing this.
  final String message;

  final int? statusCode;

  /// Threaded through from the backend's `GlobalExceptionFilter`
  /// (Sprint 9) — shown in error UI so a support request can reference
  /// it, matching that filter's own stated purpose.
  final String? correlationId;

  /// B3 `code` — the stable machine identifier. UI branches on this, never
  /// on the human sentence.
  final String? code;

  /// B3 `messageAr` — the Arabic, non-punitive sentence. THIS is what an
  /// Arabic-locale user is shown; `message` is the fallback.
  final String? messageAr;

  /// B3 `details` — `{fields}` for DTO failures, `{errors:[…]}` for
  /// `validateTargetSpec` / `validateRewardSpec`.
  final Map<String, dynamic>? details;

  /// B3 `requestId` — identical in value to [correlationId]; kept as its
  /// own field because that is the name a support ticket quotes.
  final String? requestId;

  @override
  String toString() => message;
}
