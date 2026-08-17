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
    this.diagnostic,
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

  /// THE REAL ERROR, KEPT BUT NEVER SHOWN.
  ///
  /// When a failure never reached the B3 filter — a proxy's 502 HTML page, a
  /// dropped socket, a `FormatException` from a truncated body — the only
  /// text available is the transport's own, e.g. «The request returned an
  /// invalid status code of 502». That sentence is useless to a parent and
  /// forbidden on a screen (it is raw exception text carrying an HTTP status
  /// code), but throwing it away would leave a support engineer with nothing
  /// at all.
  ///
  /// So it lives HERE: [message]/[messageAr] carry what a human reads,
  /// [diagnostic] carries what actually happened. Nothing in the UI layer
  /// renders this field — [DsErrorState] does not know it exists.
  final String? diagnostic;

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

  /// THE SENTENCE FOR A FAILURE NOBODY WORDED.
  ///
  /// [offline] and [timeout] above already establish the pattern: when the
  /// server never got the chance to explain itself, the CLIENT supplies a
  /// reviewed bilingual sentence rather than letting the transport's own
  /// English wording reach a parent. This is the third such case, and the
  /// one that used to be missing — a proxy 502, an HTML error page, a
  /// truncated body or any pre-B3 route all landed here and rendered
  /// whatever Dio happened to say.
  ///
  /// Non-punitive, and it names the one thing a parent can actually do.
  static const ApiFailure unexpected = ApiFailure(
    message: 'The request did not complete. Please try again in a moment.',
    messageAr: 'تعذّر إتمام الطلب. حاول مرة أخرى بعد قليل.',
    code: _unexpectedCode,
  );

  static const _unexpectedCode = 'CLIENT_UNEXPECTED';

  /// True when NOBODY worded this failure — neither the B3 filter nor one of
  /// the two transport classifications above — so the sentence on screen is
  /// [unexpected]'s and the real text is in [diagnostic]. Branch on this,
  /// never on the sentence itself.
  bool get isUnexpected => code == _unexpectedCode;

  /// The one line a log or a Sentry breadcrumb wants: everything needed to
  /// join this failure to a backend log row, and NOTHING a parent would
  /// ever see. Deliberately not localised — logs are read by engineers.
  String get logLine {
    final parts = <String>[
      if (code != null) 'code=$code',
      if (statusCode != null) 'status=$statusCode',
      if (requestId != null) 'requestId=$requestId',
      for (final field in fieldErrors) 'field=${field.field}',
    ];
    final detail = _firstNonEmpty([diagnostic, message]) ?? message;
    return '${parts.join(' ')}${parts.isEmpty ? '' : ' '}detail=$detail';
  }

  /// THE ONE CONVERSION, AND THE POINT AT WHICH RAW TEXT STOPS.
  ///
  /// Three outcomes, in order:
  ///   1. the transport already classified it (offline / timeout) — those
  ///      two carry reviewed Arabic of their own;
  ///   2. the B3 envelope is present (`code`, and normally `messageAr`) —
  ///      the server's own words are carried through untouched, because the
  ///      server is the only party that knows what actually went wrong.
  ///      A B3 envelope that somehow lacks `messageAr` gets [unexpected]'s
  ///      Arabic rather than falling through to the English, so an
  ///      Arabic-locale parent is never handed an English sentence;
  ///   3. anything else — a proxy page, a dropped socket, a `FormatException`
  ///      — is rendered as [unexpected], with the real text preserved in
  ///      [diagnostic] for the log.
  ///
  /// `statusCode`, `requestId` and `fieldErrors` survive every branch: they
  /// are how support finds the matching backend log line, and dropping them
  /// to clean up the message would trade one problem for a worse one.
  factory ApiFailure.from(Object error) {
    if (error is ApiFailure) return error;
    if (error is ApiException) {
      if (error.code == _offlineCode) return offline;
      if (error.code == _timeoutCode) return timeout;

      final hasArabic = _firstNonEmpty([error.messageAr]) != null;
      final fromEnvelope = _firstNonEmpty([error.code]) != null || hasArabic;

      return ApiFailure(
        message: fromEnvelope ? error.message : unexpected.message,
        messageAr: hasArabic ? error.messageAr : unexpected.messageAr,
        code: fromEnvelope ? error.code : _unexpectedCode,
        statusCode: error.statusCode,
        requestId: error.requestId ?? error.correlationId,
        fieldErrors: _fieldErrorsFrom(error.details),
        // ALWAYS the untouched original, even when it is also the
        // displayed sentence — a log reader should not have to work out
        // which branch was taken to know what arrived on the wire.
        diagnostic: error.message,
      );
    }
    // Not even an ApiException: a bad cast, a `FormatException`, a null
    // check on a shape the backend changed. `toString()` on those is a
    // developer artefact and occasionally a stack trace.
    return ApiFailure(
      message: unexpected.message,
      messageAr: unexpected.messageAr,
      code: _unexpectedCode,
      diagnostic: error.toString(),
    );
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
