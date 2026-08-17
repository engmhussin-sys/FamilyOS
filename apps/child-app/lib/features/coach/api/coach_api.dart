import '../../../core/network/api_client.dart';

/// THE TRANSPORT FOR `/api/v1/self/coach/*` — four endpoints that shipped
/// with **zero** Flutter consumers until now.
///
/// SECURITY SHAPE, restated because it is what keeps this class this small:
/// **no method here sends a `childId`.** The backend derives it from the
/// DEVICE in the verified token via `getChildAndFamilyIdForDevice`. There is
/// no child identifier in this file and there must never be one.
///
/// THE ONE RULE THAT IS NOT ABOUT TRANSPORT: there is no method on this class
/// that sends free text and receives model output, because there is no such
/// route. [answer] takes a `topicCode` which the server validates against a
/// nine-value enum and 400s on anything else. [checkin] sends the only free
/// text a child can send anywhere in this product, and what comes back is
/// either a fixed human-written card or today's ordinary encouragement —
/// never a generated reply to what was typed.
class ChildCoachApi {
  ChildCoachApi(this._client);

  final ApiClient _client;

  static const String _base = '/self/coach';

  /// Today's encouragement. No child input exists on this path at all.
  Future<Map<String, dynamic>> today() => _client.get('$_base/today');

  /// The closed question vocabulary this app renders as buttons.
  ///
  /// Returns `{topics: [...]}` — an object, not a bare array, so `get` (which
  /// casts to Map) is the correct client method here. Unwrapping happens in
  /// the repository.
  Future<Map<String, dynamic>> topics() => _client.get('$_base/topics');

  /// The answer for ONE code, at the child's own age band.
  ///
  /// [topicCode] must be a value this app received from [topics]. It is never
  /// constructed from user input — the child taps a button carrying a code
  /// the server itself supplied. An unknown code is a 400 carrying
  /// `messageAr` («هذا السؤال غير متاح. اختر سؤالًا من القائمة.»), which the
  /// repository surfaces as an `ApiFailure` and the screen renders as
  /// coaching rather than as an error.
  Future<Map<String, dynamic>> answer(String topicCode) =>
      _client.get('$_base/answer/$topicCode');

  /// «كيف تشعر اليوم؟» — a SAFETY path, not a chat.
  ///
  /// [feeling] is bounded to 500 characters by `ChildCheckinDto`
  /// (`@Length(1, 500)`); the field in the UI enforces the same ceiling so a
  /// child hits a counter rather than a 400. The text is classified offline
  /// on the server and then dropped: not stored, not logged, not echoed, not
  /// sent to any provider.
  Future<Map<String, dynamic>> checkin(String feeling) =>
      _client.post('$_base/checkin', body: {'feeling': feeling});
}
