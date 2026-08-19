import '../network/api_exception.dart';

/// A SINGLE FIELD ERROR from the B3 error envelope's `details`.
/// Same shape as the Parent App's copy — see that file's header for why
/// two producers (`details.fields`, `details.errors`) both land here.
class ApiFieldError {
  const ApiFieldError({required this.field, this.code, this.messageAr, this.message});

  final String field;
  final String? code;
  final String? messageAr;
  final String? message;

  String get display => _firstNonEmpty([messageAr, message, code, field]) ?? field;
}

/// THE PRESENTATION-LAYER VIEW OF A FAILED CALL, child side.
///
/// The Child App's screens never import `ApiException` and never import
/// `dio`. A repository catches [ApiException] and converts it here; every
/// controller state and every screen carries only this.
///
/// WHY THIS MATTERS MORE HERE THAN ANYWHERE ELSE IN THE PRODUCT: every
/// "no" a child receives from this server is a designed, non-punitive
/// Arabic sentence (CONTEXT §3 principle 7). `MAX_PER_DAY_REACHED` is not
/// «تم حظرك» — it is «أكملت هذا البرنامج مرة اليوم — نراك غدًا!». If the
/// client renders `message` instead of `messageAr`, the child gets the
/// English operational sentence and the entire principle evaporates at the
/// last hop. [display] is that last hop.
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

  final String message;
  final String? messageAr;
  final String? code;
  final int? statusCode;
  final String? requestId;
  final List<ApiFieldError> fieldErrors;

  /// THE REAL ERROR, KEPT BUT NEVER SHOWN — the child-side twin of the
  /// Parent App's field of the same name.
  ///
  /// When a failure never reached the B3 filter — a proxy's 502 HTML page, a
  /// dropped socket, a `FormatException` from a truncated body — the only
  /// text available is the transport's own, e.g. «The request returned an
  /// invalid status code of 502». On a parent's screen that sentence is
  /// merely useless; on a CHILD's screen it is an English operational string
  /// carrying an HTTP status code, put in front of a six-year-old who reads
  /// Arabic — and it is the exact opposite of the non-punitive voice every
  /// other "no" in this app is written in.
  ///
  /// So it lives HERE: [message]/[messageAr] carry what the child reads,
  /// [diagnostic] carries what actually happened. [KidErrorState] does not
  /// know this field exists.
  final String? diagnostic;

  /// ARABIC FIRST. `messageAr` wins whenever the server sent one.
  String get display => _firstNonEmpty([messageAr, message]) ?? message;

  String get displayEn => _firstNonEmpty([message, messageAr]) ?? message;

  String displayFor({required bool arabic}) => arabic ? display : displayEn;

  bool get isOffline => code == _offlineCode;
  bool get isTimeout => code == _timeoutCode;

  /// TRUE when the server said "not now" rather than "something broke".
  /// The Child App renders these WITHOUT an error icon and WITHOUT a
  /// retry-in-red treatment — they are coaching messages, not failures.
  bool get isNotNow => statusCode == 409 || _notNowCodes.contains(code);

  static const _offlineCode = 'CLIENT_OFFLINE';
  static const _timeoutCode = 'CLIENT_TIMEOUT';

  static const Set<String> _notNowCodes = {
    'MAX_PER_DAY_REACHED',
    'MAX_PER_WEEK_REACHED',
    'REWARD_LIMIT_REACHED',
    'ATTEMPT_ALREADY_OPEN',
    'PROGRAM_NOT_ACTIVE',
    'PROGRAM_EXPIRED',
    'ACHIEVEMENT_NOT_SUBMITTABLE',
    'AGE_BELOW_MINIMUM',
    'NOT_FOR_THIS_CHILD',
  };

  /// THE SENTENCE FOR A FAILURE NOBODY WORDED.
  ///
  /// `ApiClient._toApiException` already supplies reviewed Egyptian Arabic
  /// for the two transport cases it can name (`CLIENT_OFFLINE`,
  /// `CLIENT_TIMEOUT`). This is the third case, and the one that used to be
  /// missing: a proxy 502, an HTML error page, a truncated body or any route
  /// that never reached the B3 filter arrived with `messageAr == null`, so
  /// [display] fell through to the English transport string and
  /// [KidErrorState] rendered it to a child.
  ///
  /// Same register as the other two — colloquial, non-punitive, and it names
  /// the one thing the child can do. Nothing here says "failed" or "error".
  static const ApiFailure unexpected = ApiFailure(
    message: 'That did not go through. Try again in a moment.',
    messageAr: 'مش قادرين نكمّل دلوقتي. جرّب تاني بعد شوية.',
    code: _unexpectedCode,
  );

  static const _unexpectedCode = 'CLIENT_UNEXPECTED';

  /// True when NOBODY worded this failure — neither the B3 filter nor one of
  /// the two transport classifications — so the sentence on screen is
  /// [unexpected]'s and the real text is in [diagnostic]. Branch on this,
  /// never on the sentence itself.
  bool get isUnexpected => code == _unexpectedCode;

  /// THE SERVER SAW THIS REQUEST AND REFUSED IT. Twin of the Parent App's
  /// getter of the same name — see that file for the full argument.
  ///
  /// True only for a 4xx that came back through the B3 filter. False for
  /// anything that never got an answer (offline, timeout, [unexpected] —
  /// which includes a 4xx from a proxy that never reached the filter) and
  /// false for a 5xx, where the request arrived and the server broke.
  ///
  /// ON A CHILD'S SCREEN THIS DECIDES WHOSE PROBLEM IT IS. "The code you
  /// typed is not the right one" is a sentence about the child's input, and
  /// may only be said when the SERVER said so. A dropped socket or a 502 is
  /// the grown-ups' problem and must never be worded as if the child did
  /// something wrong.
  bool get isServerRefusal =>
      !isOffline &&
      !isTimeout &&
      !isUnexpected &&
      statusCode != null &&
      statusCode! >= 400 &&
      statusCode! < 500;

  /// The throttle answered, not the business rule. A 429 says nothing about
  /// whether what was submitted was right — a child retyping a code they were
  /// read aloud will hit `/pairing/accept`'s limit with a perfectly good one.
  bool get isRateLimited => statusCode == 429 || code == 'RATE_LIMITED';

  /// THE NARROW CASE WHERE THE CLIENT, NOT THE SERVER, OWNS THE SENTENCE.
  ///
  /// Everywhere else in this app the server's Arabic IS the product (CONTEXT
  /// §3 principle 7) and is carried through untouched. `/pairing/accept` is
  /// the exception, and it is a real one: a wrong or expired code is a bare
  /// `UnauthorizedException`, so B3's per-status fallback supplies the
  /// Arabic — «انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.» That sentence is
  /// correct for an expired session and meaningless to a seven-year-old on
  /// the first screen this app ever shows, who has no session and has never
  /// logged in. There is no endpoint-specific sentence to preserve here,
  /// because the endpoint never wrote one.
  ///
  /// [sentence] is stored in BOTH [message] and [messageAr] on purpose: it is
  /// not a translation pair, it is one line the caller already resolved in
  /// the reader's own locale through `LocaleController.t`, so [displayFor]
  /// must return it whichever way the locale flag points.
  ///
  /// NOTHING DIAGNOSTIC IS LOST. `code`, `statusCode`, `requestId` and
  /// `fieldErrors` all survive, and the server's untouched text stays in
  /// [diagnostic] — which no widget reads.
  ApiFailure withClientSentence(String sentence) => ApiFailure(
        message: sentence,
        messageAr: sentence,
        code: code,
        statusCode: statusCode,
        requestId: requestId,
        fieldErrors: fieldErrors,
        diagnostic: _firstNonEmpty([diagnostic, message]),
      );

  /// THE ONE CONVERSION, AND THE POINT AT WHICH RAW TEXT STOPS.
  ///
  /// Three outcomes, in order:
  ///   1. the B3 envelope is present (`code`, and normally `messageAr`) — the
  ///      server's own words are carried through untouched, because the
  ///      server is the only party that knows what actually went wrong, and
  ///      because those words ARE the product (CONTEXT §3 principle 7). This
  ///      covers `CLIENT_OFFLINE` and `CLIENT_TIMEOUT` too: `ApiClient` gives
  ///      both a `code` and a reviewed `messageAr` of their own. A B3
  ///      envelope that somehow lacks `messageAr` gets [unexpected]'s Arabic
  ///      rather than falling through to the English, so a child is never
  ///      handed an English sentence;
  ///   2. anything else that is still an `ApiException` — a proxy page, a
  ///      dropped socket — is rendered as [unexpected];
  ///   3. not even an `ApiException` — a bad cast, a `FormatException` — is
  ///      also [unexpected]. `toString()` on those is a developer artefact
  ///      and occasionally a stack trace.
  ///
  /// In every branch the untouched original survives in [diagnostic], and
  /// `statusCode` / `requestId` / `fieldErrors` survive as well: they are how
  /// support finds the matching backend log line.
  factory ApiFailure.from(Object error) {
    if (error is ApiFailure) return error;
    if (error is ApiException) {
      final hasArabic = _firstNonEmpty([error.messageAr]) != null;
      final fromEnvelope = _firstNonEmpty([error.code]) != null || hasArabic;

      return ApiFailure(
        message: fromEnvelope ? error.message : unexpected.message,
        messageAr: hasArabic ? error.messageAr : unexpected.messageAr,
        code: fromEnvelope ? error.code : _unexpectedCode,
        statusCode: error.statusCode,
        // `requestId ?? correlationId`, which is what the parent app already
        // read. `ApiClient._toApiException` falls back the same way, so this
        // only matters for an `ApiException` built anywhere else — but a
        // support line that is blank for one app and filled for the other is
        // the divergence, not the symptom.
        requestId: error.requestId ?? error.correlationId,
        fieldErrors: _fieldErrorsFrom(error.details),
        // ALWAYS the untouched original, even when it is also the displayed
        // sentence — a log reader should not have to work out which branch
        // was taken to know what arrived on the wire.
        diagnostic: error.message,
      );
    }
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
