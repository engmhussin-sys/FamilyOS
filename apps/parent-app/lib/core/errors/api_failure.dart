import '../network/api_exception.dart';

/// A SINGLE FIELD ERROR from the B3 error envelope's `details`.
///
/// Two producers exist server-side and both land here:
///   * `details.fields`  — the `ValidationPipe`'s DTO failures
///     (`VALIDATION_FAILED`), keyed by field name.
///   * `details.errors`  — `validateTargetSpec` / `validateRewardSpec`
///     return a LIST of `{field, code, messageAr}` so a parent fixing the
///     create form sees everything wrong with it at once rather than one
///     error per round trip.
class ApiFieldError {
  const ApiFieldError({required this.field, this.code, this.messageAr, this.message});

  final String field;
  final String? code;
  final String? messageAr;
  final String? message;

  /// Arabic first — this product's first language. Falls back to the
  /// English sentence, then to the machine code, then to the field name,
  /// so this getter can never return an empty string.
  String get display => _firstNonEmpty([messageAr, message, code, field]) ?? field;
}

/// THE PRESENTATION-LAYER VIEW OF A FAILED CALL.
///
/// Presentation must never import `ApiException` (which is coupled to the
/// network layer's Dio-specific construction) nor `dio` itself. This is the
/// boundary type: a repository catches an [ApiException] and converts it
/// with [ApiFailure.from]; every controller and every screen state carries
/// only this.
///
/// WHAT THIS EXISTS TO FIX (audit PA-M-002, backend side closed by B3):
/// the Arabic non-punitive copy F4 writes — «أكملت هذا البرنامج مرتين اليوم
/// — نراك غدًا!» — reached the wire in B3 and stopped there, because no
/// client read `messageAr`. [display] is the line that finally puts it on a
/// screen.
class ApiFailure {
  const ApiFailure({
    required this.message,
    this.messageAr,
    this.code,
    this.statusCode,
    this.requestId,
    this.fieldErrors = const [],
  });

  /// The English sentence. Always present (the network layer substitutes a
  /// generic one for transport errors that never reached the server).
  final String message;

  /// The server's Arabic sentence, from the B3 envelope. `null` only for
  /// transport-level failures that never got a response body.
  final String? messageAr;

  /// The stable machine code (`MAX_PER_DAY_REACHED`, `ATTEMPT_ALREADY_OPEN`,
  /// `TARGET_SPEC_INVALID`, …). Branch on THIS, never on the sentence.
  final String? code;

  final int? statusCode;

  /// B3's `requestId` (identical in value to `correlationId`) — quoted in a
  /// support ticket, it joins the log line, the outbox row and the Sentry
  /// event.
  final String? requestId;

  final List<ApiFieldError> fieldErrors;

  /// ARABIC FIRST. `messageAr` wins whenever the server sent one; the
  /// English `message` is the fallback, never the default.
  String get display => _firstNonEmpty([messageAr, message]) ?? message;

  /// The English side of the same envelope, for an `en` locale session.
  String get displayEn => _firstNonEmpty([message, messageAr]) ?? message;

  String displayFor({required bool arabic}) => arabic ? display : displayEn;

  bool get isOffline => code == _offlineCode;
  bool get isTimeout => code == _timeoutCode;

  static const _offlineCode = 'CLIENT_OFFLINE';
  static const _timeoutCode = 'CLIENT_TIMEOUT';

  static const ApiFailure offline = ApiFailure(
    message: 'No internet connection.',
    messageAr: 'لا يوجد اتصال بالإنترنت.',
    code: _offlineCode,
  );

  static const ApiFailure timeout = ApiFailure(
    message: 'The request took too long. Check your connection and try again.',
    messageAr: 'استغرق الطلب وقتًا طويلًا. تحقّق من اتصالك وحاول مجددًا.',
    code: _timeoutCode,
  );

  factory ApiFailure.from(Object error) {
    if (error is ApiFailure) return error;
    if (error is ApiException) {
      if (error.code == _offlineCode) return offline;
      if (error.code == _timeoutCode) return timeout;
      return ApiFailure(
        message: error.message,
        messageAr: error.messageAr,
        code: error.code,
        statusCode: error.statusCode,
        requestId: error.requestId ?? error.correlationId,
        fieldErrors: _fieldErrorsFrom(error.details),
      );
    }
    return ApiFailure(message: error.toString());
  }

  static List<ApiFieldError> _fieldErrorsFrom(Map<String, dynamic>? details) {
    if (details == null) return const [];
    final out = <ApiFieldError>[];

    // `details.errors` — the domain validators' shape.
    final errors = details['errors'];
    if (errors is List) {
      for (final entry in errors) {
        if (entry is Map) {
          out.add(ApiFieldError(
            field: entry['field']?.toString() ?? '',
            code: entry['code']?.toString(),
            messageAr: entry['messageAr']?.toString(),
            message: entry['message']?.toString(),
          ));
        }
      }
    }

    // `details.fields` — the ValidationPipe's shape, `{field: [messages]}`.
    final fields = details['fields'];
    if (fields is Map) {
      fields.forEach((key, value) {
        final text = value is List ? value.join(' ') : value?.toString();
        out.add(ApiFieldError(field: key.toString(), message: text));
      });
    }
    return out;
  }
}

String? _firstNonEmpty(List<String?> candidates) {
  for (final candidate in candidates) {
    if (candidate != null && candidate.trim().isNotEmpty) return candidate;
  }
  return null;
}
