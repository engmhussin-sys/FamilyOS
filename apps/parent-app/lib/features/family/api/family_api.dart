import '../../../core/network/api_client.dart';

/// The launch markets, and the IANA zone each one's day boundary is
/// computed in.
///
/// NOT INVENTED HERE — these are the backend's own values, read off
/// `apps/backend/src/modules/analytics/domain/growth-settings.ts`
/// (`reporting.timezone.EG` -> `'Africa/Cairo'`,
/// `reporting.timezone.SA` -> `'Asia/Riyadh'`), the same pair
/// `apps/backend/src/common/time/is-iana-timezone.validator.ts` names as
/// its canonical examples. If a third market is added, the value comes
/// from that file, not from this one.
const Map<String, String> familyTimezoneByCountry = <String, String>{
  'EG': 'Africa/Cairo',
  'SA': 'Asia/Riyadh',
};

/// The ISO-3166 alpha-2 codes the setup screen may offer. Ordered, because
/// a `Map`'s iteration order is an implementation detail to depend on in a
/// dropdown.
const List<String> supportedFamilyCountries = <String>['EG', 'SA'];

/// `null` for an unknown code rather than a defaulted `'Africa/Cairo'`: a
/// silently defaulted zone is precisely the bug this mapping exists to
/// prevent, and `PATCH /settings` treats an absent `timezone` as "leave it
/// alone" rather than as a value.
String? timezoneForCountry(String? countryCode) =>
    countryCode == null ? null : familyTimezoneByCountry[countryCode];

/// "Create Family" reuses `PATCH /settings` (Sprint 8, real) rather than
/// inventing a new endpoint — `AuthService.register` already creates a
/// `Family` row for every new parent; there is no separate "create
/// family" concept on the backend to call. This screen's job is filling
/// in the name/timezone the backend defaulted at registration, via the
/// existing settings-update path — per the explicit "no duplicate
/// endpoints" rule.
///
/// WHY `timezone` IS NOW SENT AND WHY IT MATTERS. Until this change the
/// screen collected a country and sent only `name`, so every family kept
/// `Family.timezone`'s schema default of `"UTC"`. `FamilyDateService`
/// derives every business date from that column — streak day boundaries,
/// daily limits, reward idempotency keys — so a family left on `UTC` gets
/// the wrong day boundary forever, silently. The country the parent picks
/// now resolves to a real IANA zone via [familyTimezoneByCountry] and is
/// sent on the same request.
///
/// WHY `country` IS *NOT* SENT — A BACKEND GAP, NOT AN OMISSION HERE.
/// `UpdateSettingsDto`
/// (`apps/backend/src/modules/settings/presentation/dto/update-settings.dto.ts`)
/// declares exactly two fields, `name?` and `timezone?`, and there is no
/// `country` column on `model Family` in `prisma/schema.prisma` to hold
/// one. `apps/backend/src/common/http/global-pipeline.ts` configures the
/// global `ValidationPipe` with `forbidNonWhitelisted: true`, so adding
/// `'country'` to this body would not be quietly ignored — it would make
/// `PATCH /settings` answer **400** and break family creation outright.
/// The country is therefore an INPUT to the timezone we do send, and
/// nothing more. Persisting the country itself needs a backend change
/// (column + DTO field) that does not exist yet.
class FamilyApi {
  FamilyApi(this._client);

  final ApiClient _client;

  /// The exact JSON body [setupFamily] sends, built separately so a test
  /// can assert on it without standing up an HTTP layer.
  ///
  /// [countryCode] is one of [supportedFamilyCountries]; anything else
  /// yields a body with no `timezone` key at all, which leaves the
  /// family's existing zone untouched rather than overwriting it with a
  /// guess.
  static Map<String, dynamic> buildSetupBody({
    required String name,
    String? countryCode,
  }) {
    final timezone = timezoneForCountry(countryCode);
    return <String, dynamic>{
      'name': name,
      if (timezone != null) 'timezone': timezone,
    };
  }

  Future<Map<String, dynamic>> setupFamily({
    required String name,
    String? countryCode,
  }) {
    return _client.patch(
      '/settings',
      data: buildSetupBody(name: name, countryCode: countryCode),
    );
  }
}
