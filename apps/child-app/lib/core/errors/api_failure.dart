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
  });

  final String message;
  final String? messageAr;
  final String? code;
  final int? statusCode;
  final String? requestId;
  final List<ApiFieldError> fieldErrors;

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

  factory ApiFailure.from(Object error) {
    if (error is ApiFailure) return error;
    if (error is ApiException) {
      return ApiFailure(
        message: error.message,
        messageAr: error.messageAr,
        code: error.code,
        statusCode: error.statusCode,
        requestId: error.requestId,
        fieldErrors: _fieldErrorsFrom(error.details),
      );
    }
    return ApiFailure(message: error.toString());
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
